/**
 * Pass 6: Infer conservative effects
 *
 * Where source omitted effect metadata, fills in safe defaults.
 * Conservative = err on the side of caution (no auto-retry unless proven safe).
 */

import type { CompilerPass, CompiledOperation, CompilerContext } from '../types.js';
import type { EffectMetadata } from '../../types.js';

/**
 * Default safe effects (assume non-idempotent mutation)
 */
const DEFAULT_EFFECTS: EffectMetadata = {
  readOnly: false,
  idempotent: false,
  retryable: false,
  idempotencyKeyRequired: true,
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
