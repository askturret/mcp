// SPDX-License-Identifier: Apache-2.0
/**
 * @fileoverview Readiness criterion #6: non-idempotent writes are never
 * automatically retried, and `OUTCOME_UNKNOWN` is never retried in ANY path.
 *
 * ## What makes this test worth having
 *
 * It drives the REAL decision functions — `decideRetry` and `isRetryEligible`
 * from `retry/policy.ts` — across the exhaustive product of every error code
 * (12) and every combination of the four effect flags (16): 192 cases.
 *
 * It deliberately does NOT re-state the rule as a local predicate and assert
 * that against itself. A test shaped that way passes with the retry policy
 * deleted, so it cannot go RED on revert and certifies nothing — the
 * `Transcribed Oracle` antipattern in `docs/TESTING.md`.
 *
 * ## Note on the criterion's wording
 *
 * The refusal is a RUNTIME decision, not a compile-time one: TypeScript happily
 * constructs `{ idempotent: false, retryable: true }`, and nothing rejects that
 * object at the type level. What holds is that `isRetryEligible` refuses the
 * combination and `decideRetry` never returns `retry: true` for it.
 */

import { describe, it, expect } from '@jest/globals';
import {
  NEVER_RETRY_CODES,
  TRANSIENT_CODES,
  decideRetry,
  isRetryEligible,
} from '../retry/policy.js';
import type { EffectMetadata, OperationErrorCode } from '../types.js';

/** Every member of the `OperationErrorCode` union (types.ts). */
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

const BOOLS = [true, false] as const;

/** The exhaustive 2^4 effect matrix. */
function allEffects(): readonly EffectMetadata[] {
  const out: EffectMetadata[] = [];
  for (const readOnly of BOOLS) {
    for (const idempotent of BOOLS) {
      for (const retryable of BOOLS) {
        for (const idempotencyKeyRequired of BOOLS) {
          out.push({
            readOnly,
            idempotent,
            retryable,
            idempotencyKeyRequired,
            classifications: [],
          });
        }
      }
    }
  }
  return out;
}

const EFFECT_COMBINATIONS = allEffects();

/** A mutating operation that claims to be retryable while not being idempotent. */
const CONTRADICTORY_WRITE: EffectMetadata = {
  readOnly: false,
  idempotent: false,
  retryable: true,
  idempotencyKeyRequired: true,
  classifications: [],
};

describe('Idempotent+retryable fuzz (readiness #6)', () => {
  it('enumerates the full effect matrix', () => {
    // Guards every loop below: a silently-empty matrix would make each
    // "never retries" assertion vacuously true.
    expect(EFFECT_COMBINATIONS).toHaveLength(16);
    // 13 since #125 added REQUEST_TOO_LARGE. Bumping this is the deliberate
    // step the count exists to force: a new code has to be classified in
    // NEVER_RETRY_CODES or TRANSIENT_CODES, not merely appended to the union.
    expect(ALL_CODES).toHaveLength(13);
  });

  it('never retries OUTCOME_UNKNOWN, for any effect combination', () => {
    for (const effects of EFFECT_COMBINATIONS) {
      for (const attempt of [1, 2]) {
        const decision = decideRetry({
          errorCode: 'OUTCOME_UNKNOWN',
          effects,
          attempt,
          maxAttempts: 5,
        });
        expect(decision.retry).toBe(false);
        // The FIRST check must be the one that fires — if a later branch
        // short-circuited it instead, the ordering guarantee in policy.ts
        // ("the never-retry check runs FIRST") would be silently untrue.
        expect(decision.reason).toBe('outcome-unknown');
      }
    }
  });

  it('never retries a non-idempotent mutating operation, whatever the error code', () => {
    expect(isRetryEligible(CONTRADICTORY_WRITE)).toBe(false);

    for (const errorCode of ALL_CODES) {
      const decision = decideRetry({
        errorCode,
        effects: CONTRADICTORY_WRITE,
        attempt: 1,
        maxAttempts: 5,
      });
      expect(decision.retry).toBe(false);
    }
  });

  it('only ever retries when the code is transient AND the effects permit it', () => {
    let retried = 0;

    for (const errorCode of ALL_CODES) {
      for (const effects of EFFECT_COMBINATIONS) {
        const decision = decideRetry({ errorCode, effects, attempt: 1, maxAttempts: 3 });
        if (decision.retry) {
          retried++;
          // Cross-checked against the other production export and the
          // production allowlist — not against a copy of the rule.
          expect(TRANSIENT_CODES).toContain(errorCode);
          expect(isRetryEligible(effects)).toBe(true);
          expect(NEVER_RETRY_CODES).not.toContain(errorCode);
        }
      }
    }

    // Anti-vacuity: if NOTHING retried, every assertion above passes for the
    // wrong reason and the suite would still be green with retry disabled.
    expect(retried).toBeGreaterThan(0);
  });

  it('does retry a genuinely safe, transient failure', () => {
    const idempotentWrite: EffectMetadata = {
      readOnly: false,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: true,
      classifications: [],
    };

    expect(isRetryEligible(idempotentWrite)).toBe(true);
    expect(
      decideRetry({
        errorCode: 'UPSTREAM_UNAVAILABLE',
        effects: idempotentWrite,
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toEqual({ retry: true, reason: 'eligible' });
  });

  it('keeps OUTCOME_UNKNOWN in the never-retry set and out of the transient set', () => {
    expect(NEVER_RETRY_CODES).toContain('OUTCOME_UNKNOWN');
    expect(TRANSIENT_CODES).not.toContain('OUTCOME_UNKNOWN');

    // The structural invariant policy.ts asserts at module load. Restated here
    // so the failure names the criterion rather than surfacing as an import
    // error in an unrelated suite.
    for (const code of NEVER_RETRY_CODES) {
      expect(TRANSIENT_CODES).not.toContain(code);
    }
  });
});
