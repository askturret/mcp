/**
 * Pass 4: Generate agent-facing names/descriptions
 *
 * Applies naming heuristics to improve agent-facing operation names.
 * For v0.1: pass-through (sources already provide good names).
 */

import type { CompilerPass, CompiledOperation, CompilerContext } from '../types.js';

export const generateNames: CompilerPass = {
  name: 'generate-names',

  async run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]> {
    context.logger.debug('Running generate-names pass', { count: operations.length });

    // For v0.1: sources (especially fromOpenApi) already provide agent-friendly names
    // Future enhancement: apply doctor-style naming heuristics
    return operations.map(op => ({
      ...op,
      // Ensure name and description exist (required fields)
      name: op.name || op.id || 'unnamed-operation',
      description: op.description || `Operation: ${op.name || op.id}`,
    }));
  },
};
