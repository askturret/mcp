/**
 * Pass 1: Normalize external schemas
 *
 * Resolves $ref, dereferences, and canon

icalizes keyword shape.
 * For v0.1: pass-through if schemas are already JSON Schema.
 */

import type { CompilerPass, CompiledOperation, CompilerContext } from '../types.js';

export const normalizeSchemas: CompilerPass = {
  name: 'normalize-schemas',

  async run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]> {
    context.logger.debug('Running normalize-schemas pass', { count: operations.length });

    // For v0.1: schemas from fromOpenApi are already normalized by SwaggerParser
    // This pass is a placeholder for future schema normalization logic
    return operations.map(op => ({
      ...op,
      // Only set input/output when raw schemas exist
      // Leave undefined when absent — validate-invariants (pass 8) decides what to do
      ...(op.rawInput && { input: op.rawInput }),
      ...(op.rawOutput && { output: op.rawOutput }),
    }));
  },
};
