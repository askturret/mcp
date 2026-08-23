// SPDX-License-Identifier: Apache-2.0
/**
 * Pass 6: Infer conservative effects
 *
 * Where source omitted effect metadata, fills in safe defaults.
 * Conservative = err on the side of caution (no auto-retry unless proven safe).
 */

import type { CompilerPass, CompiledOperation, CompilerContext } from '../types.js';
import type { EffectMetadata } from '../../types.js';

/**
 * Default safe effects (assume non-idempotent mutation).
 *
 * ## Why `idempotencyKeyRequired` defaults to FALSE (#45)
 *
 * It used to default to `true`, and while the flag was inert that read as
 * extra caution. #45 makes it enforcing: an operation with
 * `idempotencyKeyRequired: true` now fails with `INVALID_INPUT` at stage 4
 * unless the caller supplies a key. Under the old default, EVERY operation
 * discovered without explicit effect metadata — which is every operation from
 * an OpenAPI spec — would have become uncallable the moment this shipped.
 *
 * That is not a hypothetical: it broke three adapter-conformance categories on
 * the first run, with the executor never entered.
 *
 * The codebase already held the other half of this argument. `diff.ts`
 * classifies `idempotencyKeyRequired` false -> true as a BREAKING change,
 * because "callers not sending a key will be rejected". Defaulting it to
 * `true` shipped every un-annotated operation pre-broken in exactly that way.
 *
 * Retry safety does NOT depend on this flag's default, which is what makes the
 * change safe. `retryable: false` and `idempotent: false` above are what
 * prevent an unknown operation from being auto-retried, and they are untouched
 * — a defaulted operation now fails the retry matrix on two independent counts.
 * What this flag governs is a REQUIREMENT IMPOSED ON THE CALLER, and the
 * conservative direction for a requirement you cannot justify is not to impose
 * it. An operation that genuinely needs a dedup key needs a source that says
 * so; inferring it from absence of information demands a key for reads.
 */
const DEFAULT_EFFECTS: EffectMetadata = {
  readOnly: false,
  idempotent: false,
  retryable: false,
  idempotencyKeyRequired: false,
  classifications: [],
};

export const inferEffects: CompilerPass = {
  name: 'infer-effects',

  async run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]> {
    context.logger.debug('Running infer-effects pass', { count: operations.length });

    return operations.map(op => {
      // If source already provided full effects, keep them
      if (op.effects && isCompleteEffects(op.effects)) {
        return op;
      }

      // Merge source-provided partial effects with safe defaults
      const effects: EffectMetadata = {
        ...DEFAULT_EFFECTS,
        ...(op.effects ?? {}),
      };

      return {
        ...op,
        effects,
      };
    });
  },
};

/**
 * Check if effects object has all required fields
 */
function isCompleteEffects(effects: Partial<EffectMetadata>): effects is EffectMetadata {
  return (
    typeof effects.readOnly === 'boolean' &&
    typeof effects.idempotent === 'boolean' &&
    typeof effects.retryable === 'boolean' &&
    typeof effects.idempotencyKeyRequired === 'boolean' &&
    Array.isArray(effects.classifications)
  );
}
