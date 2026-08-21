// SPDX-License-Identifier: Apache-2.0
/**
 * Pass 7: Apply preset defaults
 *
 * Applies preset-specific defaults (Light/Production/Regulated).
 * For v0.1: minimal - mainly ensures executor binding exists.
 */

import type { CompilerPass, CompiledOperation, CompilerContext } from '../types.js';

export const applyPresetDefaults: CompilerPass = {
  name: 'apply-preset-defaults',

  async run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]> {
    context.logger.debug('Running apply-preset-defaults pass', {
      count: operations.length,
      preset: context.preset,
    });

    return operations.map(op => {
      // Ensure executor binding exists
      const executor = op.executor ?? {
        type: 'handler', // Default to direct handler
        config: {},
      };

      // Preset-specific behavior (minimal for v0.1)
      // Future: apply timeout, rate limit, confirmation requirements based on preset
      return {
        ...op,
        executor,
      };
    });
  },
};
