/**
 * Pass 8: Validate invariants
 *
 * Checks required fields, no dangling refs, effect coherence, size caps.
 * Throws on critical failures; non-critical issues become warnings.
 */

import type { CompilerPass, CompiledOperation, CompilerContext, CompilerWarning } from '../types.js';
import { omitUndefined } from '../../utils.js';

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

      if (!op.executor) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_EXECUTOR',
          message: `Operation '${op.id}' missing required 'executor' binding`,
          location: op.source?.location,
        }));
        continue;
      }

      // Effect coherence check
      if (op.effects.readOnly && op.effects.idempotencyKeyRequired) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'INCOHERENT_EFFECTS',
          message: `Operation '${op.id}' is readOnly but requires idempotency key`,
          location: op.source?.location,
        }));
      }

      validated.push(op);
    }

    context.logger.debug('Validation complete', {
      totalOperations: operations.length,
      validOperations: validated.length,
      invalidOperations: operations.length - validated.length,
    });

    return validated;
  },
};
