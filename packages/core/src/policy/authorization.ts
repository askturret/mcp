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
 * Stable hash of the input a confirmation was issued against.
 *
 * Object key order is normalised so `{a,b}` and `{b,a}` bind identically — two
 * spellings of the same request must not produce different confirmations, or
 * a client library that reorders keys would break confirmation for no reason.
 *
 * Not reversible and never logged: the input is user data, and this hash is a
 * binding token, not a description of it.
 */
export function inputHash(input: unknown): string {
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
    // Cyclic or otherwise unserialisable. Fall back to a value that can never
    // match a previously-issued binding, so an input we cannot fingerprint
    // fails confirmation rather than passing it.
    return 'unhashable';
  }

  return createHash('sha256').update(serialised).digest('hex').slice(0, 32);
}

const deny = (code: OperationError['code'], message: string): OperationError => ({ code, message });

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
          error: deny('FORBIDDEN', decision.safeReason),
        });
      }

      // confirmation_required.
      //
      // The binding is re-derived here from the AUTHENTICATED principal and the
      // ACTUAL input. Nothing is read back from the proof except its id — a
      // value the client supplies cannot attest to who the client is, and
      // trusting `confirmation.principal` would be exactly that mistake.
      const binding: ConfirmationBinding = {
        callerHash: callerHash(request.principal, request.clientInfo),
        operationId: request.operation.id,
        registryHash: request.registryHash,
        inputHash: inputHash(request.input),
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
