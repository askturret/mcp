/**
 * Pass 5: Simplify input/output schemas
 *
 * Drops unused definitions, inlines single-use refs, caps depth.
 * For v0.1: pass-through (schemas already simplified by sources).
 */

import type { CompilerPass, CompiledOperation, CompilerContext } from '../types.js';

export const simplifySchemas: CompilerPass = {
  name: 'simplify-schemas',

  async run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]> {
    context.logger.debug('Running simplify-schemas pass', { count: operations.length });

    // For v0.1: pass-through - schemas from fromOpenApi are already dereferenced
    // Future enhancement: depth capping, unused definition removal
    return operations;
  },
};
