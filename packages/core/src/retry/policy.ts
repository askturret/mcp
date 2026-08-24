// SPDX-License-Identifier: Apache-2.0
/**
 * Retry decision rules (§8.4, §5.8, ADR-012).
 *
 * Every function here is PURE. The decision is separable from the loop that
 * acts on it, which is what lets the matrix be tested exhaustively without
 * standing up a dispatcher — and what lets the loop be read as "ask, then act"
 * rather than as a pile of inline conditions.
 */

import type { EffectMetadata, OperationErrorCode } from '../types.js';
import type {
  OperationRetryOverride,
  ResolvedRetryConfig,
  RetryConfig,
  RetryDecision,
} from './types.js';

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 100;
export const DEFAULT_MAX_DELAY_MS = 5_000;

/**
 * Error codes that MUST NEVER be auto-retried, whatever else is true.
 *
 * `OUTCOME_UNKNOWN` is the one that matters (§5.8): the upstream may have
 * applied the effect, so a retry is a possible double-apply. The rest are
 * terminal by nature — retrying a rejected input or a denied principal just
 * produces the same refusal more expensively.
 *
 * `RATE_LIMITED` is on this list deliberately even though it is transient in
 * the plain-English sense: retrying into a rate limiter is what turns a
 * throttle into an outage. The `retryAfter` hint is for the CLIENT to honour.
 */
export const NEVER_RETRY_CODES: readonly OperationErrorCode[] = [
  'OUTCOME_UNKNOWN',
  'INVALID_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CONFIRMATION_REQUIRED',
  'RATE_LIMITED',
  'CANCELLED',
  // Both size bounds (#125). Neither is transient: the same payload retried
  // against the same cap yields the same refusal. The fix is a smaller request
  // or a split call, and that is the client's to make.
  'REQUEST_TOO_LARGE',
  'OUTPUT_TOO_LARGE',
];

/**
 * Error codes eligible for auto-retry when the effects matrix also allows it.
 *
 * `TIMEOUT` is here, and it is safe here only because of #44. §8.4 qualifies
 * it as retryable "only when confirmed no side effect fired" — and since #44
 * the executor makes exactly that determination BEFORE this list is consulted:
 * a deadline that fires after a non-idempotent request was sent now yields
 * `OUTCOME_UNKNOWN`, not `TIMEOUT`. So a `TIMEOUT` arriving here already means
 * "nothing was sent, or the operation was idempotent".
 *
 * That is a load-bearing dependency between two issues, so it is written down
 * rather than left as a coincidence: if the #44 branch is ever removed,
 * `TIMEOUT` must come off this list in the same commit.
 *
 * `INTERNAL_ERROR` is deliberately NOT here. It is the code for a bug in this
 * process as well as for an ambiguous upstream 500, and retrying our own bug
 * is pointless. The transient upstream statuses that DO deserve a retry —
 * 502/503/504 — are mapped to `UPSTREAM_UNAVAILABLE` by the HTTP executor, so
 * "certain 5xx" (§8.4) reaches this list under a code that means it.
 */
export const TRANSIENT_CODES: readonly OperationErrorCode[] = [
  'UPSTREAM_UNAVAILABLE',
  'TIMEOUT',
];

/**
 * Structural invariant: the two lists must not overlap.
 *
 * Checked at module load rather than left to review. The acceptance criterion
 * is "`OUTCOME_UNKNOWN` never auto-retries, in ANY code path" — a criterion
 * that a future edit adding it to `TRANSIENT_CODES` would violate silently.
 * This turns that edit into an immediate, unmissable failure.
 */
for (const code of NEVER_RETRY_CODES) {
  if (TRANSIENT_CODES.includes(code)) {
    throw new Error(
      `Retry policy invariant violated: '${code}' is in both NEVER_RETRY_CODES and ` +
        `TRANSIENT_CODES. A never-retry code must never be treated as transient.`,
    );
  }
}

/**
 * Does the operation's effect metadata permit auto-retry at all? (§8.4)
 *
 * ## The spec's "all four must be true" does not survive its own test case
 *
 * §45 lists four flags and says all must be true, then immediately gives
 * `readOnly: true` GET → transient failure → automatic retry as a test case.
 * A read-only GET has nothing to deduplicate, so it carries
 * `idempotencyKeyRequired: false` — and under the literal reading it would
 * never retry, contradicting the example. The parenthetical ("or default-true
 * where semantically implied — readOnly implies idempotent and retryable") is
 * what resolves it.
 *
 * So the rule implemented here is the SAFETY reading, which is what the four
 * flags are actually for:
 *
 * 1. `retryable` is the explicit switch and is NEVER waived. The type's own
 *    docs call it the escape hatch — "may be false even for idempotent
 *    operations" — and an implication that overrode it would make the flag
 *    unusable for the one job it has. Not retrying is also the conservative
 *    direction, matching the compiler's stated stance ("no auto-retry unless
 *    proven safe").
 * 2. `readOnly` waives the remaining two: a read mutates nothing, so
 *    idempotency and dedup keys are moot. This is what makes §45's own first
 *    test case pass.
 * 3. A MUTATING operation needs BOTH `idempotent` and `idempotencyKeyRequired`
 *    — the strict reading, applied where it means something. Replaying a write
 *    is only safe if the upstream can recognise the replay.
 *
 * Flagged for QA rather than picked silently: reading (1) is the one place
 * this diverges from a literal reading of the prose, and it diverges toward
 * fewer retries.
 */
export function isRetryEligible(effects: EffectMetadata): boolean {
  if (!effects.retryable) return false;
  if (effects.readOnly) return true;
  return effects.idempotent && effects.idempotencyKeyRequired;
}

/**
 * The full retry decision for one failed attempt.
 *
 * Order is load-bearing. The never-retry check runs FIRST, before the effects
 * matrix and before the transient allowlist, so that no combination of flags
 * or future list edits can reach a retry for `OUTCOME_UNKNOWN`.
 *
 * @param attempt - 1-based number of the attempt that just failed
 */
export function decideRetry(params: {
  readonly errorCode: OperationErrorCode;
  readonly effects: EffectMetadata;
  readonly attempt: number;
  readonly maxAttempts: number;
}): RetryDecision {
  const { errorCode, effects, attempt, maxAttempts } = params;

  if (errorCode === 'OUTCOME_UNKNOWN') {
    return { retry: false, reason: 'outcome-unknown' };
  }

  if (NEVER_RETRY_CODES.includes(errorCode) || !TRANSIENT_CODES.includes(errorCode)) {
    return { retry: false, reason: 'not-transient' };
  }

  if (!isRetryEligible(effects)) {
    return { retry: false, reason: 'effects-forbid-retry' };
  }

  if (attempt >= maxAttempts) {
    return { retry: false, reason: 'attempts-exhausted' };
  }

  return { retry: true, reason: 'eligible' };
}

/**
 * Merge policy defaults with any per-operation override.
 */
export function resolveRetryConfig(
  config: RetryConfig,
  operationId: string,
): ResolvedRetryConfig {
  const override: OperationRetryOverride = config.perOperation?.[operationId] ?? {};

  return {
    maxAttempts: positiveOr(
      override.maxAttempts ?? config.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
    ),
    baseDelayMs: positiveOr(
      override.baseDelayMs ?? config.baseDelayMs,
      DEFAULT_BASE_DELAY_MS,
    ),
    maxDelayMs: positiveOr(override.maxDelayMs ?? config.maxDelayMs, DEFAULT_MAX_DELAY_MS),
  };
}

/**
 * Bounded exponential backoff with full jitter (§8.4).
 *
 * `delay = random() * min(maxDelayMs, baseDelayMs * 2^(attempt-1))`
 *
 * Full jitter rather than a fixed exponential: N clients that failed against
 * the same upstream at the same instant otherwise retry at the same instant,
 * which is how a recovering service is knocked straight back over. Spreading
 * each retry uniformly across its window is what breaks that synchronisation.
 *
 * @param attempt - 1-based number of the attempt that just failed
 */
export function computeBackoffMs(
  attempt: number,
  config: ResolvedRetryConfig,
  random: () => number,
): number {
  const exponential = config.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(config.maxDelayMs, exponential);
  return Math.floor(random() * capped);
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
