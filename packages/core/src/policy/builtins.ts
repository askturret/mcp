// SPDX-License-Identifier: Apache-2.0
/**
 * The initial set of built-in policies.
 *
 * Each is deliberately small and single-purpose. Real deployments compose them
 * with `allOf` / `anyOf` / `not` rather than reaching for one policy that knows
 * everything.
 *
 * Every string any of these puts into a decision — evidence claims, denial
 * reasons, challenge prompts — is written on the assumption it will be
 * rendered in Explorer and persisted to the audit trail. None of them read the
 * principal's identifier, and none read `context.input`.
 */

import type { ConfirmationProof, EffectClassification } from '../types.js';
import type {
  ConfirmationChallenge,
  Policy,
  PolicyContext,
  PolicyDecision,
  PolicyEvidence,
} from './types.js';

const evidence = (policyId: string, claim: string, detail?: string): PolicyEvidence =>
  detail === undefined ? { policyId, claim } : { policyId, claim, detail };

/**
 * Deny unless a principal is present.
 *
 * Note this asserts only that the caller was *identified*, not that the
 * identity is trustworthy — establishing that is the transport's job, before a
 * `Principal` is ever constructed.
 */
export function authenticated(options?: { readonly id?: string }): Policy {
  const id = options?.id ?? 'authenticated';

  return {
    id,
    evaluate(context: PolicyContext): Promise<PolicyDecision> {
      if (context.principal === undefined) {
        return Promise.resolve({
          effect: 'deny',
          code: 'UNAUTHENTICATED',
          safeReason: 'This operation requires an authenticated caller.',
          evidence: [evidence(id, 'principal is absent')],
        });
      }

      return Promise.resolve({
        effect: 'allow',
        // Deliberately records only presence and coarse type. The principal's
        // id is exactly the thing evidence may not carry.
        evidence: [evidence(id, 'principal is present', `principal type: ${context.principal.type}`)],
      });
    },
  };
}

/** How `permissionPolicy` treats an operation absent from its map. */
export type UnlistedOperationBehaviour = 'deny' | 'allow';

export interface PermissionPolicyOptions {
  /**
   * What to do when the operation has no entry in the map.
   *
   * Defaults to `'deny'`. An operation nobody granted a permission for is an
   * operation nobody decided about, and defaulting to `'allow'` means every
   * newly-added operation is world-callable from the moment it is discovered
   * until someone remembers to add a map entry. `'allow'` is available for the
   * case where this policy is one branch of a wider `anyOf`, but it should be
   * a deliberate choice.
   */
  readonly unlisted?: UnlistedOperationBehaviour;
  readonly id?: string;
}

/**
 * Allow or deny by comparing the principal's permissions against the
 * permissions an operation requires.
 *
 * `required` maps operation ID to the permissions needed. **All** listed
 * permissions must be held — the conjunctive reading, because "needs billing
 * read AND write" is the common intent and the safer default when the map is
 * ambiguous. Express alternatives with `anyOf` of two `permissionPolicy`
 * instances rather than by loosening this.
 */
export function permissionPolicy(
  required: Readonly<Record<string, readonly string[]>>,
  options?: PermissionPolicyOptions,
): Policy {
  const id = options?.id ?? 'permissionPolicy';
  const unlisted: UnlistedOperationBehaviour = options?.unlisted ?? 'deny';

  return {
    id,
    evaluate(context: PolicyContext): Promise<PolicyDecision> {
      const operationId = context.operation.id;
      const needed = Object.prototype.hasOwnProperty.call(required, operationId)
        ? required[operationId]
        : undefined;

      if (needed === undefined) {
        if (unlisted === 'allow') {
          return Promise.resolve({
            effect: 'allow',
            evidence: [
              evidence(id, 'operation requires no listed permissions', `operation: ${operationId}`),
            ],
          });
        }
        return Promise.resolve({
          effect: 'deny',
          code: 'FORBIDDEN',
          safeReason: 'This operation has no permission grant configured.',
          evidence: [
            evidence(id, 'operation is absent from the permission map', `operation: ${operationId}`),
          ],
        });
      }

      if (context.principal === undefined) {
        return Promise.resolve({
          effect: 'deny',
          code: 'UNAUTHENTICATED',
          safeReason: 'This operation requires an authenticated caller.',
          evidence: [evidence(id, 'principal is absent, so it holds no permissions')],
        });
      }

      const held = new Set(context.principal.permissions ?? []);
      const missing = needed.filter((permission) => !held.has(permission));

      if (missing.length > 0) {
        return Promise.resolve({
          effect: 'deny',
          code: 'FORBIDDEN',
          safeReason: 'The caller lacks the permissions this operation requires.',
          evidence: [
            evidence(
              id,
              'principal is missing required permissions',
              // Naming the MISSING permissions describes this API's permission
              // vocabulary and what the request needed — both already known to
              // an authorised caller. The principal's full permission set is
              // NOT listed: that describes the caller, not the request.
              `missing: ${missing.join(', ')}`,
            ),
          ],
        });
      }

      return Promise.resolve({
        effect: 'allow',
        evidence: [
          evidence(id, 'principal holds every required permission', `required: ${needed.join(', ')}`),
        ],
      });
    },
  };
}

export interface ConfirmationForEffectsOptions {
  readonly id?: string;
  /** Coarse challenge kind recorded on the challenge. Defaults to `'acknowledge'`. */
  readonly kind?: string;
}

/**
 * Require confirmation when an operation carries any of the given effect
 * classifications.
 *
 * Operations whose classifications do not intersect `kinds` are allowed — this
 * policy speaks only to confirmation, never to authorization. Compose it with
 * `authenticated()` and `permissionPolicy()` for the latter.
 *
 * ## The challenge id is derived, not random
 *
 * `challenge.id` is a deterministic function of the operation id and the
 * matched classifications, so the same operation always produces the same
 * challenge id. That makes decisions reproducible and testable, and it is what
 * lets Explorer show a stable challenge across a retry.
 *
 * **It is therefore NOT a nonce, and must not be treated as one.** It carries
 * no unpredictability and no expiry, so it cannot by itself stop a
 * `ConfirmationProof` from one call being replayed against another. Binding a
 * proof to a single call — freshness, single use, tying it to the caller — is
 * the verification step's job, and that lives behind
 * `VerifyConfirmationHook`, not here.
 */
export function confirmationForEffects(
  kinds: readonly EffectClassification[],
  options?: ConfirmationForEffectsOptions,
): Policy {
  const id = options?.id ?? `confirmationForEffects(${[...kinds].join(', ')})`;
  const kind = options?.kind ?? 'acknowledge';
  const wanted = new Set<EffectClassification>(kinds);

  return {
    id,
    evaluate(context: PolicyContext): Promise<PolicyDecision> {
      const matched = context.operation.effects.classifications.filter((c) => wanted.has(c));

      if (matched.length === 0) {
        return Promise.resolve({
          effect: 'allow',
          evidence: [
            evidence(
              id,
              'operation carries none of the classifications that require confirmation',
              `operation: ${context.operation.id}`,
            ),
          ],
        });
      }

      const sorted = [...matched].sort();
      const challenge: ConfirmationChallenge = {
        id: `confirm:${context.operation.id}:${sorted.join('+')}`,
        kind,
        // Describes the CLASS of action, never the arguments it would act on.
        prompt: `This operation is classified as ${sorted.join(', ')}. Confirm to proceed.`,
        classifications: sorted,
      };

      return Promise.resolve({
        effect: 'confirmation_required',
        challenge,
        evidence: [
          evidence(id, 'operation requires confirmation for its effects', `classifications: ${sorted.join(', ')}`),
        ],
      });
    },
  };
}

/**
 * Verifies an out-of-band signature on a presented confirmation proof.
 *
 * Returns `true` when the signature is valid for this proof in this context.
 * Deliberately synchronous and total: it must not throw, because a policy that
 * throws denies nothing — it turns the call into `INTERNAL_ERROR` and loses the
 * reason. Return `false` for every failure, including malformed input.
 */
export type EvidenceVerifier = (
  proof: ConfirmationProof,
  context: PolicyContext,
) => boolean;

export interface RequireEvidenceOptions {
  readonly id?: string;
  /**
   * Human-readable instruction rendered in the challenge prompt and written to
   * the audit trail. Same safety rules as evidence: describe what is needed,
   * never who or what it applies to.
   */
  readonly prompt?: string;
}

/**
 * Require a signed, out-of-band approval before an operation proceeds (§10.2,
 * #52).
 *
 * This is the Regulated column's "explicit evidence policy": confirmation is
 * demanded for EVERY operation the policy guards, not only for operations whose
 * effects happen to be classified — which is the difference between this and
 * `confirmationForEffects`. A regulated deployment does not want its confirmation
 * requirement to depend on whether a spec author remembered to classify an
 * operation as `destructive`.
 *
 * ## Why the verifier is mandatory
 *
 * There is no default. A default that accepted anything would make the policy
 * decorative, and one that rejected everything would make every guarded call
 * fail at runtime with a confusing error — the failure an operator discovers
 * from behaviour rather than from configuration. Callers must decide, and the
 * Regulated preset refuses to boot without one.
 *
 * ## How it composes with the engine
 *
 * Three outcomes, and the middle one is the point:
 *
 *   - **No proof presented** → `confirmation_required`. The engine issues a
 *     nonce-bound challenge.
 *   - **Proof presented, signature invalid** → `deny`. The engine never reaches
 *     redemption, so a bad signature cannot consume a live challenge.
 *   - **Proof presented, signature valid** → `confirmation_required` *again*,
 *     NOT `allow`.
 *
 * That last one looks wrong and is the crux. Returning `allow` would tell the
 * engine the call is authorised and skip redemption entirely — discarding the
 * binding checks (right caller, right operation, right input, right registry),
 * the expiry, and single use. The signature would then be sufficient on its
 * own, and one valid signature would be replayable forever. Returning
 * `confirmation_required` keeps redemption in the path, so the signature check
 * is strictly ADDITIVE to the engine's guarantees rather than a substitute for
 * them.
 */
export function requireEvidence(
  kind: string,
  verify: EvidenceVerifier,
  options?: RequireEvidenceOptions,
): Policy {
  const id = options?.id ?? `requireEvidence(${kind})`;
  const prompt =
    options?.prompt ??
    `This operation requires ${kind} evidence from a separately-authenticated approver.`;

  return {
    id,
    evaluate(context: PolicyContext): Promise<PolicyDecision> {
      const challenge: ConfirmationChallenge = {
        id: `evidence:${kind}:${context.operation.id}`,
        kind,
        prompt,
      };

      const presented = context.confirmation;

      if (presented === undefined) {
        return Promise.resolve({
          effect: 'confirmation_required',
          challenge,
          evidence: [evidence(id, 'no confirmation evidence was presented', `required kind: ${kind}`)],
        });
      }

      // A verifier that throws would surface as INTERNAL_ERROR and lose the
      // reason, so a throw is treated as a failed verification — the same
      // answer, with the reason preserved.
      let verified: boolean;
      try {
        verified = verify(presented, context);
      } catch {
        verified = false;
      }

      if (!verified) {
        return Promise.resolve({
          effect: 'deny',
          code: 'FORBIDDEN',
          safeReason: 'The confirmation evidence presented was not accepted.',
          evidence: [
            evidence(id, 'presented evidence failed signature verification', `required kind: ${kind}`),
          ],
        });
      }

      // Verified, and STILL confirmation_required — see the header. The engine
      // must redeem the proof so binding, freshness and single-use all apply.
      return Promise.resolve({
        effect: 'confirmation_required',
        challenge,
        evidence: [
          evidence(
            id,
            'presented evidence passed signature verification; redemption still required',
            `required kind: ${kind}`,
          ),
        ],
      });
    },
  };
}

/**
 * Allow read-only operations, deny everything else.
 *
 * Reads `operation.effects.readOnly`, which the compiler infers. This is a
 * blunt instrument and meant to be — it is the backstop for a
 * discovery-time surface that should expose nothing capable of mutation.
 */
export function readOnly(options?: { readonly id?: string }): Policy {
  const id = options?.id ?? 'readOnly';

  return {
    id,
    evaluate(context: PolicyContext): Promise<PolicyDecision> {
      if (context.operation.effects.readOnly) {
        return Promise.resolve({
          effect: 'allow',
          evidence: [evidence(id, 'operation is read-only', `operation: ${context.operation.id}`)],
        });
      }

      return Promise.resolve({
        effect: 'deny',
        code: 'FORBIDDEN',
        safeReason: 'Only read-only operations are permitted here.',
        evidence: [
          evidence(id, 'operation is not read-only', `operation: ${context.operation.id}`),
        ],
      });
    },
  };
}
