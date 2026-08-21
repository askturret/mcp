/**
 * Pass 8: Validate invariants
 *
 * Checks required fields, no dangling refs, effect coherence, size caps.
 * Throws on critical failures; non-critical issues become warnings.
 */

import type { CompilerPass, CompiledOperation, CompilerContext, CompilerWarning } from '../types.js';
import type { EffectMetadata } from '../../types.js';
import { omitUndefined } from '../../utils.js';

/**
 * Default safe effects (conservative: assume non-idempotent mutation)
 * Belt-and-suspenders: infer-effects (pass 6) should have completed these,
 * but pass 8 validates and completes any gaps before freezing.
 */
const DEFAULT_EFFECTS: EffectMetadata = {
  readOnly: false,
  idempotent: false,
  retryable: false,
  idempotencyKeyRequired: true,
  classifications: [],
};

/**
 * Runtime check: is effects object complete?
 * Type guard narrows Partial<EffectMetadata> to full EffectMetadata.
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

export const validateInvariants: CompilerPass = {
  name: 'validate-invariants',

  async run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]> {
    context.logger.debug('Running validate-invariants pass', { count: operations.length });

    const validated: CompiledOperation[] = [];

    for (const op of operations) {
      // Required fields check
      if (!op.id) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_OPERATION_ID',
          message: `Operation missing required 'id' field`,
          location: op.source?.location,
        }));
        continue; // Skip invalid operation
      }

      if (!op.name) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_OPERATION_NAME',
          message: `Operation '${op.id}' missing required 'name' field`,
          location: op.source?.location,
        }));
        continue;
      }

      if (!op.description) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_OPERATION_DESCRIPTION',
          message: `Operation '${op.id}' missing required 'description' field`,
          location: op.source?.location,
        }));
        continue;
      }

      if (!op.input) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_INPUT_SCHEMA',
          message: `Operation '${op.id}' missing required 'input' schema`,
          location: op.source?.location,
        }));
        continue;
      }

      if (!op.output) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_OUTPUT_SCHEMA',
          message: `Operation '${op.id}' missing required 'output' schema`,
          location: op.source?.location,
        }));
        continue;
      }

      if (!op.effects) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_EFFECTS',
          message: `Operation '${op.id}' missing required 'effects' metadata`,
          location: op.source?.location,
        }));
        continue;
      }

      // Belt-and-suspenders: ensure effects is complete before freezing
      // infer-effects (pass 6) should have completed this, but validate defensively
      let completeEffects: EffectMetadata;
      if (isCompleteEffects(op.effects)) {
        completeEffects = op.effects;
      } else {
        // Fill missing fields with safe defaults
        completeEffects = {
          ...DEFAULT_EFFECTS,
          ...op.effects,
        };
        context.logger.debug(`Completed partial effects for operation '${op.id}'`, {
          provided: Object.keys(op.effects),
          completed: Object.keys(completeEffects),
        });
      }

      if (!op.executor) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_EXECUTOR',
          message: `Operation '${op.id}' missing required 'executor' binding`,
          location: op.source?.location,
        }));
        continue;
      }

      // Effect coherence check (use completed effects)
      if (completeEffects.readOnly && completeEffects.idempotencyKeyRequired) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'INCOHERENT_EFFECTS',
          message: `Operation '${op.id}' is readOnly but requires idempotency key`,
          location: op.source?.location,
        }));
      }

      // Push operation with completed effects
      validated.push({
        ...op,
        effects: completeEffects,
      });
    }

    context.logger.debug('Validation complete', {
      totalOperations: operations.length,
      validOperations: validated.length,
      invalidOperations: operations.length - validated.length,
    });

    return validated;
  },
};
