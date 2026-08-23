// SPDX-License-Identifier: Apache-2.0
/**
 * Policy engine types.
 *
 * One interface serves both evaluation phases. Splitting it into a list-time
 * and a call-time interface would let the same rule answer differently in each,
 * which is how an operation becomes invisible in discovery but callable in
 * practice (or the reverse). `phase` distinguishes them; the policy does not.
 */

import type {
  ConfirmationProof,
  EffectClassification,
  OperationDefinition,
  Principal,
} from '../types.js';

/**
 * Identifying information a client volunteered about itself.
 *
 * Structurally matches the inline `clientInfo` on `OperationCommand`. Named
 * here because `PolicyContext` needs to refer to it; both fields stay optional
 * because a client is not obliged to introduce itself, and a policy must not
 * assume it did.
 */
export interface ClientInfo {
  readonly name?: string;
  readonly version?: string;
}

/**
 * A challenge a caller must satisfy before a guarded operation proceeds.
 *
 * `id` is what comes back as `ConfirmationProof.challengeId`.
 *
 * `prompt` is rendered to a human and written to the audit trail, so it is held
 * to the same standard as evidence: no principal identifiers, no tokens, no
 * request payload. Describe the CLASS of action being confirmed, never the
 * specific values being acted on.
 */
export interface ConfirmationChallenge {
  readonly id: string;
  /** Coarse challenge kind, e.g. `'acknowledge'`. */
  readonly kind: string;
  /** Safe, human-readable description of what is being confirmed. */
  readonly prompt: string;
  /** Which effect classifications triggered the challenge. */
  readonly classifications?: readonly EffectClassification[];
}

/**
 * A single reason contributing to a decision.
 *
 * Evidence is consumed directly by Explorer and the audit trail, so it is
 * **safe by contract**: no principal identifiers, no raw tokens, no request or
 * response payloads, no error messages (which routinely embed all three).
 *
 * State the CLAIM, not the value that satisfied it — `"principal holds the
 * required permissions"`, never `"principal alice@example.com holds billing:write"`.
 * Operation IDs and permission names are safe; they describe your API surface,
 * which the caller already knows.
 */
export interface PolicyEvidence {
  readonly policyId: string;
  /** What was established, e.g. `'principal is present'`. */
  readonly claim: string;
  /** Optional elaboration. Same safety rules as `claim`. */
  readonly detail?: string;
}

/**
 * The outcome of evaluating a policy.
 *
 * `deny` carries a machine-readable `code` and a `safeReason` fit to return to
 * the caller. The separation is deliberate: the code is for branching, the
 * reason is for humans, and calling it `safeReason` rather than `reason` is a
 * standing reminder that it crosses a trust boundary.
 */
export type PolicyDecision =
  | { readonly effect: 'allow'; readonly evidence: readonly PolicyEvidence[] }
  | {
      readonly effect: 'deny';
      readonly code: string;
      readonly safeReason: string;
      readonly evidence: readonly PolicyEvidence[];
    }
  | {
      readonly effect: 'confirmation_required';
      readonly challenge: ConfirmationChallenge;
      readonly evidence: readonly PolicyEvidence[];
    };

/** Which evaluation is running. */
export type PolicyPhase = 'discovery' | 'invocation';

/**
 * Everything a policy may reason about.
 *
 * `input` is populated **only** in the `invocation` phase — during `discovery`
 * there is no call yet, so there are no arguments. A policy that reads `input`
 * without checking `phase` will behave differently at list time and call time,
 * which is the disagreement this single interface exists to prevent.
 */
export interface PolicyContext {
  readonly principal?: Principal;
  readonly operation: OperationDefinition;
  readonly registryHash: string;
  readonly phase: PolicyPhase;
  /** Present only when `phase === 'invocation'`. */
  readonly input?: unknown;
  readonly clientInfo?: ClientInfo;

  /**
   * A confirmation proof the caller PRESENTED, if any (#52).
   *
   * ## This is an untrusted claim, not an established fact
   *
   * The engine already redeems this proof against a server-side binding —
   * caller, operation, registry and input hash, plus freshness and single use.
   * None of that happens here, and a policy MUST NOT treat the presence of this
   * field as evidence that the confirmation was valid. It is the raw thing the
   * client sent.
   *
   * It is exposed so a policy can apply an ADDITIONAL check the engine cannot
   * know about — `requireEvidence` uses it to verify an out-of-band signature,
   * whose scheme is adopter-specific. The correct shape for such a policy is to
   * DENY when its own check fails and otherwise still return
   * `confirmation_required`, so the engine's binding checks run too. Returning
   * `allow` on the strength of this field alone would skip redemption entirely
   * and turn a single-use proof into a reusable one.
   */
  readonly confirmation?: ConfirmationProof;
}

/**
 * A composable authorization rule.
 *
 * `id` appears in evidence, so it should identify the rule to an operator
 * reading an audit entry. Combinators derive their own ids from their children.
 */
export interface Policy {
  readonly id: string;
  evaluate(context: PolicyContext): Promise<PolicyDecision>;
}
