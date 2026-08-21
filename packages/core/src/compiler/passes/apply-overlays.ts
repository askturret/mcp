/**
 * Pass 3: Apply overlays and code enhancements
 *
 * No-op stub for v0.1 - full overlay engine ships in Epic #4.
 */

import type { CompilerPass, CompiledOperation, CompilerContext } from '../types.js';

export const applyOverlays: CompilerPass = {
  name: 'apply-overlays',

  async run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]> {
    context.logger.debug('Running apply-overlays pass (no-op for v0.1)', {
      count: operations.length,
      overlayCount: context.overlays.length,
    });

    // v0.1: no-op - overlays array should be empty
    if (context.overlays.length > 0) {
      context.logger.warn('Overlays provided but overlay engine not yet implemented', {
        overlayCount: context.overlays.length,
      });
    }

    return operations;
  },
};
