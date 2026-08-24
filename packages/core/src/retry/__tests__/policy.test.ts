// SPDX-License-Identifier: Apache-2.0
/**
 * Retry decision matrix (§8.4, §5.8) — the pure half.
 *
 * `dispatcher-retry.test.ts` proves the dispatcher acts on these decisions.
 * This file proves the decisions themselves, exhaustively, which is only
 * practical because the policy is separable from the loop.
 */

import { describe, it, expect } from '@jest/globals';

import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
  NEVER_RETRY_CODES,
  TRANSIENT_CODES,
  computeBackoffMs,
  decideRetry,
  isRetryEligible,
  resolveRetryConfig,
} from '../index.js';
import type { EffectMetadata, OperationErrorCode } from '../../types.js';

function effects(overrides: Partial<EffectMetadata> = {}): EffectMetadata {
  return {
    readOnly: false,
    idempotent: false,
    retryable: false,
    idempotencyKeyRequired: false,
    classifications: [],
    ...overrides,
  };
}

const ALL_CODES: readonly OperationErrorCode[] = [
  'INVALID_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CONFIRMATION_REQUIRED',
  'RATE_LIMITED',
  'QUEUE_FULL',
  'TIMEOUT',
  'CANCELLED',
  'UPSTREAM_UNAVAILABLE',
  'OUTCOME_UNKNOWN',
  'REQUEST_TOO_LARGE',
  'OUTPUT_TOO_LARGE',
  'INTERNAL_ERROR',
];

/** Effects that pass the matrix, so error-code behaviour is what varies. */
const RETRYABLE_READ = effects({ readOnly: true, idempotent: true, retryable: true });

describe('effects matrix (§8.4)', () => {
  it('permits a read-only retryable operation, without an idempotency key', () => {
    // §45's own first test case: a read-only GET retries. A GET has nothing to
    // deduplicate, so it carries idempotencyKeyRequired: false — which the
    // literal "all four must be true" reading would refuse.
    expect(
      isRetryEligible(
        effects({ readOnly: true, idempotent: true, retryable: true, idempotencyKeyRequired: false }),
      ),
    ).toBe(true);
  });

  it('refuses when retryable is false, even for a read-only operation', () => {
    // `retryable` is the explicit escape hatch. An implication that overrode
    // it would make the flag unusable for its only job.
    expect(isRetryEligible(effects({ readOnly: true, idempotent: true, retryable: false }))).toBe(
      false,
    );
  });

  it('requires BOTH idempotent and a required key for a mutating operation', () => {
    const base = { readOnly: false, retryable: true };

    expect(isRetryEligible(effects({ ...base, idempotent: true, idempotencyKeyRequired: true }))).toBe(
      true,
    );
    // Idempotent but with no key the upstream can dedupe on: a replay is
    // indistinguishable from a second genuine call.
    expect(
      isRetryEligible(effects({ ...base, idempotent: true, idempotencyKeyRequired: false })),
    ).toBe(false);
    expect(
      isRetryEligible(effects({ ...base, idempotent: false, idempotencyKeyRequired: true })),
    ).toBe(false);
  });

  it('refuses the compiler default, which is the conservative one', () => {
    // infer-effects fills in "assume non-idempotent mutation" when a source
    // omits metadata. That must not be retryable.
    expect(isRetryEligible(effects({ idempotencyKeyRequired: true }))).toBe(false);
  });
});

describe('OUTCOME_UNKNOWN is never retried (§5.8, acceptance)', () => {
  it('refuses regardless of how permissive the effects are', () => {
    const decision = decideRetry({
      errorCode: 'OUTCOME_UNKNOWN',
      effects: effects({
        readOnly: true,
        idempotent: true,
        retryable: true,
        idempotencyKeyRequired: true,
      }),
      attempt: 1,
      maxAttempts: 10,
    });

    expect(decision).toEqual({ retry: false, reason: 'outcome-unknown' });
  });

  it('is not reachable through the transient list', () => {
    // The acceptance criterion is "in ANY code path". This pins the structural
    // property the module-load invariant enforces, so the guarantee survives
    // someone editing the lists rather than resting on the branch order alone.
    expect(TRANSIENT_CODES).not.toContain('OUTCOME_UNKNOWN');
    expect(NEVER_RETRY_CODES).toContain('OUTCOME_UNKNOWN');
  });
});

describe('transient classification (§8.4)', () => {
  it.each(['UPSTREAM_UNAVAILABLE', 'TIMEOUT'] as const)('retries %s', (code) => {
    expect(
      decideRetry({ errorCode: code, effects: RETRYABLE_READ, attempt: 1, maxAttempts: 3 }),
    ).toEqual({ retry: true, reason: 'eligible' });
  });

  it('refuses every code that is not on the transient list', () => {
    const transient = new Set<OperationErrorCode>(TRANSIENT_CODES);
    const refused = ALL_CODES.filter((code) => !transient.has(code));

    // Enumerated from the full code union rather than from a hand-listed set,
    // so a NEW error code added to the union defaults to not-retried here and
    // has to be classified deliberately.
    for (const code of refused) {
      const decision = decideRetry({
        errorCode: code,
        effects: RETRYABLE_READ,
        attempt: 1,
        maxAttempts: 3,
      });
      expect([decision.reason, decision.retry]).toEqual([
        code === 'OUTCOME_UNKNOWN' ? 'outcome-unknown' : 'not-transient',
        false,
      ]);
    }
  });

  it('refuses INTERNAL_ERROR, so an internal bug is not replayed', () => {
    expect(
      decideRetry({
        errorCode: 'INTERNAL_ERROR',
        effects: RETRYABLE_READ,
        attempt: 1,
        maxAttempts: 3,
      }).retry,
    ).toBe(false);
  });
});

describe('attempt budget', () => {
  it('stops at maxAttempts', () => {
    const at = (attempt: number) =>
      decideRetry({
        errorCode: 'UPSTREAM_UNAVAILABLE',
        effects: RETRYABLE_READ,
        attempt,
        maxAttempts: 3,
      });

    expect(at(1).retry).toBe(true);
    expect(at(2).retry).toBe(true);
    expect(at(3)).toEqual({ retry: false, reason: 'attempts-exhausted' });
  });

  it('checks eligibility before the budget, so the reason is the real one', () => {
    // A non-retryable operation on its last attempt must report WHY it will
    // not be retried, not "exhausted" — those lead an operator to different
    // fixes.
    expect(
      decideRetry({
        errorCode: 'UPSTREAM_UNAVAILABLE',
        effects: effects({ readOnly: true, retryable: false }),
        attempt: 3,
        maxAttempts: 3,
      }).reason,
    ).toBe('effects-forbid-retry');
  });
});

describe('config resolution', () => {
  it('defaults to 3 attempts', () => {
    expect(resolveRetryConfig({}, 'op').maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(resolveRetryConfig({}, 'op').baseDelayMs).toBe(DEFAULT_BASE_DELAY_MS);
  });

  it('lets a per-operation override beat the policy default', () => {
    const config = { maxAttempts: 3, perOperation: { special: { maxAttempts: 7 } } };

    expect(resolveRetryConfig(config, 'special').maxAttempts).toBe(7);
    expect(resolveRetryConfig(config, 'ordinary').maxAttempts).toBe(3);
  });

  it('falls back rather than accepting a nonsensical value', () => {
    // Zero or negative attempts would mean "never execute at all", which is
    // not a retry policy — it is a broken deployment silently disabling every
    // tool. Fall back to the default instead.
    expect(resolveRetryConfig({ maxAttempts: 0 }, 'op').maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(resolveRetryConfig({ maxAttempts: -1 }, 'op').maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(resolveRetryConfig({ baseDelayMs: NaN }, 'op').baseDelayMs).toBe(DEFAULT_BASE_DELAY_MS);
  });
});

describe('backoff', () => {
  const config = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 5000 };

  it('grows exponentially', () => {
    // random() === 1 is the top of each jitter window, which is where the
    // exponential shape is visible.
    const top = (attempt: number) => computeBackoffMs(attempt, config, () => 1);

    expect([top(1), top(2), top(3), top(4)]).toEqual([100, 200, 400, 800]);
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoffMs(20, config, () => 1)).toBe(5000);
  });

  it('jitters across the whole window', () => {
    // Full jitter: the delay is uniform in [0, window), so the bottom of the
    // window is 0 and the top is the cap. A fixed exponential would return the
    // same value for both, which is the synchronisation this avoids.
    expect(computeBackoffMs(3, config, () => 0)).toBe(0);
    expect(computeBackoffMs(3, config, () => 0.5)).toBe(200);
    expect(computeBackoffMs(3, config, () => 1)).toBe(400);
  });
});
