// SPDX-License-Identifier: Apache-2.0
/**
 * Call-time authorization — the actual security boundary.
 *
 * §5.5 is emphatic that discovery-time filtering is not sufficient, and the
 * reason is concrete: identity, permissions, tool metadata and input-dependent
 * rules can all change between `tools/list` and `tools/call`. Everything
 * `visibility.ts` does is a courtesy to the agent. This is the part that stops
 * anything.
 *
 * Three deliberate differences from the discovery engine, each following from
 * that:
 *
 *   - **No caching, at all.** A cache is a promise that a past answer is still
 *     good, which is exactly the claim call-time authorization exists to
 *     refuse. The TOCTOU test in #35 is precisely this: allowed at discovery,
 *     denied by the time it is called.
 *   - **The actual input is in hand**, so a policy can decide on it.
 *   - **A confirmation must be redeemed**, not merely presented.
 */

import { createHash } from 'crypto';
import type {
  ConfirmationProof,
  OperationDefinition,
  OperationError,
  Principal,
} from '../types.js';
import type {
  ClientInfo,
  ConfirmationChallenge,
  Policy,
  PolicyContext,
  PolicyDecision,
} from './types.js';
import { callerHash } from './visibility.js';
import type { PolicyMetrics } from './visibility.js';
import type { ConfirmationBinding, ConfirmationRegistry } from './confirmation.js';
import { createConfirmationRegistry } from './confirmation.js';

/** Timing sink for `mcp_authorization_duration_seconds`. */
export interface AuthorizationTimings {
  recordDuration(effect: PolicyDecision['effect'], seconds: number): void;
}

const NOOP_METRICS: PolicyMetrics = { recordDecision: () => undefined };
const NOOP_TIMINGS: AuthorizationTimings = { recordDuration: () => undefined };

export interface AuthorizationRequest {
  readonly operation: OperationDefinition;
  readonly registryHash: string;
  readonly input: unknown;
  readonly principal?: Principal;
  readonly clientInfo?: ClientInfo;
  /** The proof the caller presented, if any. Never trusted for identity. */
  readonly confirmation?: ConfirmationProof;
}

export type AuthorizationOutcome =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly error: OperationError }
  | {
      readonly kind: 'confirmation_required';
      readonly challenge: ConfirmationChallenge;
      readonly error: OperationError;
    };

export interface AuthorizationEngineOptions {
  readonly policy: Policy;
  readonly confirmations?: ConfirmationRegistry;
  readonly metrics?: PolicyMetrics;
  readonly timings?: AuthorizationTimings;
  /** Injectable clock for duration measurement. Defaults to Date.now. */
  readonly now?: () => number;
}

export interface AuthorizationEngine {
  authorize(request: AuthorizationRequest): Promise<AuthorizationOutcome>;
  /** The registry backing confirmations, so a caller can inspect or share it. */
  readonly confirmations: ConfirmationRegistry;
}

/**
 * The result of fingerprinting an input for confirmation binding.
 *
 * A result object rather than a sentinel string, per ADR-011 — and for a
 * sharper reason here: a sentinel is a value, and values compare equal to
 * themselves. See `fingerprintInput`.
 */
export type InputFingerprint =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false };

/**
 * Stable fingerprint of the input a confirmation is bound to.
 *
 * Object key order is normalised so `{a,b}` and `{b,a}` bind identically — two
 * spellings of the same request must not produce different confirmations, or a
 * client library that reorders keys would break confirmation for no reason.
 *
 * Not reversible and never logged: the input is user data, and this is a
 * binding token, not a description of it.
 *
 * ## Why failure is signalled rather than substituted (QA on PR #122)
 *
 * The first version returned the literal string `'unhashable'` when
 * `JSON.stringify` could not handle the input — cycles, BigInt — and the
 * comment claimed it was "a value that can never match a previously-issued
 * binding."
 *
 * That was exactly backwards, and the comment was the worse half of the bug:
 * it vouched for an invariant the code did not provide. A constant matches
 * every OTHER unhashable input. Two different unserialisable inputs
 * fingerprinted equal, so a confirmation issued for one redeemed against the
 * other — a £10 confirmation authorising a £10,000 call.
 *
 * Returning a random value would also close it, but it would keep the shape
 * that caused the mistake: an unfingerprintable input silently taking part in
 * binding as though it had been fingerprinted. Failing explicitly says what is
 * actually true — we could not identify this input — and lets the caller deny
 * for that reason. "I could not determine" is not "it passed".
 */
export function fingerprintInput(input: unknown): InputFingerprint {
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonical);
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonical(v)]);
    return Object.fromEntries(entries);
  };

  let serialised: string;
  try {
    serialised = JSON.stringify(canonical(input)) ?? 'undefined';
  } catch {
    // Cyclic, BigInt, or a throwing toJSON. We cannot identify this input, so
    // we say so rather than inventing a stand-in for it.
    return { ok: false };
  }

  return { ok: true, hash: createHash('sha256').update(serialised).digest('hex').slice(0, 32) };
}

const deny = (code: OperationError['code'], message: string): OperationError => ({ code, message });

/**
 * Policy deny codes that reach the caller unchanged. Everything else becomes
 * `FORBIDDEN` (#124).
 *
 * ## Why an allowlist, and not "propagate whatever the policy said"
 *
 * `PolicyDecision.code` is typed `string`, and a policy is ordinary third-party
 * code. Forwarding it verbatim would let any policy author choose the
 * transport-visible error code — and these codes are not merely cosmetic. The
 * retry classifier keys on them (`NEVER_RETRY_CODES`), the circuit breaker keys
 * on them (`BREAKER_FAILURE_CODES`), and a policy that answered
 * `UPSTREAM_UNAVAILABLE` would make repeated denials look like a sick
 * dependency and open a breaker on a healthy one.
 *
 * So the engine still normalises. The change is that it now normalises to an
 * enumerated set of two rather than to a set of one.
 *
 * ## Why `UNAUTHENTICATED` specifically is safe to distinguish
 *
 * The concern #35's QA settled is information disclosure: an error code must
 * not tell a caller something about the SYSTEM they had not already earned.
 * `UNAUTHENTICATED` is a statement about the caller's OWN credentials — that
 * they presented none, or none that resolved to a principal. The caller knows
 * what they sent. It describes nothing about the resource, the operation, or
 * anyone else's access, so there is nothing here for it to disclose.
 *
 * `FORBIDDEN` continues to cover every other denial precisely because those
 * ARE statements about the system: which permissions an operation needs, that
 * a grant is missing, that a confirmation was refused.
 *
 * ## What this does NOT reopen (verified, not assumed)
 *
 *   - **Resource existence.** An unknown operation is refused at dispatcher
 *     stage 1 with `INVALID_INPUT` ("Operation 'x' not found"), BEFORE any
 *     policy runs. The exists/does-not-exist distinction is therefore already
 *     drawn by a different code on a path this change does not touch — so
 *     splitting `FORBIDDEN` cannot create an enumeration oracle, and did not
 *     narrow one either.
 *   - **Retry behaviour.** `UNAUTHENTICATED` and `FORBIDDEN` are BOTH already
 *     in `NEVER_RETRY_CODES`, so a denial that changes code does not become
 *     retryable.
 *   - **Breaker accounting.** `BREAKER_FAILURE_CODES` is an allowlist of three
 *     transient codes and contains neither, so §8.5's "100 denials must not
 *     open the breaker" holds for both.
 *   - **Composition.** `allOf` returns the first deny in declaration order and
 *     `anyOf` propagates a code only when every branch denied for the same
 *     (code, reason) — otherwise it synthesises `anyOf_all_denied`, which is
 *     not on this list and so still surfaces as `FORBIDDEN`. Mixed denials
 *     therefore stay collapsed, which is the conservative direction.
 */
const PROPAGATED_DENY_CODES: readonly string[] = ['UNAUTHENTICATED'];

/**
 * Map a policy's own deny code to the code the caller sees.
 *
 * Unrecognised codes — including the engine's own `policy_failed` and the
 * combinators' `policy_threw` / `anyOf_*` — deliberately land on `FORBIDDEN`:
 * a denial whose provenance the engine cannot vouch for is exactly the case
 * that should say the least.
 */
function clientDenyCode(policyCode: string): OperationError['code'] {
  return PROPAGATED_DENY_CODES.includes(policyCode)
    ? (policyCode as OperationError['code'])
    : 'FORBIDDEN';
}

export function createAuthorizationEngine(
  options: AuthorizationEngineOptions,
): AuthorizationEngine {
  const { policy } = options;
  const confirmations = options.confirmations ?? createConfirmationRegistry();
  const metrics = options.metrics ?? NOOP_METRICS;
  const timings = options.timings ?? NOOP_TIMINGS;
  const now = options.now ?? Date.now;

  async function evaluate(context: PolicyContext): Promise<PolicyDecision> {
    try {
      const decision = await policy.evaluate(context);
      const effect = decision?.effect;
      if (effect === 'allow' || effect === 'deny' || effect === 'confirmation_required') {
        return decision;
      }
    } catch {
      // fall through
    }

    // A policy that threw, or answered in a shape we do not recognise, has not
    // authorised anything. At the security boundary "I could not determine" is
    // a denial, never an allowance.
    return {
      effect: 'deny',
      code: 'policy_failed',
      safeReason: 'Authorization could not be determined.',
      evidence: [],
    };
  }

  return {
    confirmations,

    async authorize(request: AuthorizationRequest): Promise<AuthorizationOutcome> {
      const startedAt = now();

      const context: PolicyContext = {
        operation: request.operation,
        registryHash: request.registryHash,
        phase: 'invocation',
        input: request.input,
        ...(request.principal === undefined ? {} : { principal: request.principal }),
        ...(request.clientInfo === undefined ? {} : { clientInfo: request.clientInfo }),
        // Exposed so a policy can apply a check the engine cannot know about —
        // an out-of-band signature, say. It is the caller's UNVERIFIED claim;
        // the binding redemption below is what actually validates it, and that
        // still runs regardless of what any policy concluded from this field.
        ...(request.confirmation === undefined ? {} : { confirmation: request.confirmation }),
      };

      const decision = await evaluate(context);
      metrics.recordDecision('invocation', decision.effect);

      const finish = <T extends AuthorizationOutcome>(outcome: T): T => {
        timings.recordDuration(decision.effect, (now() - startedAt) / 1000);
        return outcome;
      };

      if (decision.effect === 'allow') {
        return finish({ kind: 'allow' });
      }

      if (decision.effect === 'deny') {
        return finish({
          kind: 'deny',
          // safeReason is the field the policy author marked as fit to cross a
          // trust boundary. The evidence list is NOT returned to the caller.
          //
          // The code is normalised through an allowlist rather than forwarded
          // (#124) — see PROPAGATED_DENY_CODES for why the set is enumerated
          // and why `UNAUTHENTICATED` is the one entry that earns a place.
          error: deny(clientDenyCode(decision.code), decision.safeReason),
        });
      }

      // confirmation_required.
      //
      // The binding is re-derived here from the AUTHENTICATED principal and the
      // ACTUAL input. Nothing is read back from the proof except its id — a
      // value the client supplies cannot attest to who the client is, and
      // trusting `confirmation.principal` would be exactly that mistake.
      const fingerprint = fingerprintInput(request.input);
      if (!fingerprint.ok) {
        // An input we cannot identify cannot be bound to, so it can neither be
        // issued a confirmation nor redeem one. Denying is the only answer that
        // does not amount to confirming something we could not name.
        //
        // Note this denies only the CONFIRMATION path. An `allow` never reaches
        // here, so an exotic input is not blanket-rejected — a policy that can
        // read it is still free to permit it.
        return finish({
          kind: 'deny',
          error: deny(
            'FORBIDDEN',
            'This operation requires confirmation, and its input could not be fingerprinted.',
          ),
        });
      }

      const binding: ConfirmationBinding = {
        callerHash: callerHash(request.principal, request.clientInfo),
        operationId: request.operation.id,
        registryHash: request.registryHash,
        inputHash: fingerprint.hash,
      };

      if (request.confirmation !== undefined) {
        const outcome = confirmations.redeem(request.confirmation, binding);
        if (outcome.accepted) {
          return finish({ kind: 'allow' });
        }

        // A rejected proof does not get a fresh challenge for free: issuing one
        // here would let a caller probe bindings cheaply, and it muddles
        // "you need to confirm" with "what you sent was not valid".
        return finish({
          kind: 'deny',
          error: deny('FORBIDDEN', `Confirmation was not accepted (${outcome.reason}).`),
        });
      }

      const challenge = confirmations.issue(decision.challenge, binding);
      return finish({
        kind: 'confirmation_required',
        challenge,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: challenge.prompt,
          details: { challenge },
        },
      });
    },
  };
}
