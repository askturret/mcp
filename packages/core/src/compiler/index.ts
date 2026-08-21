/**
 * Compiler - transforms discovered operations into deterministic registry snapshot
 *
 * Implements the 9-pass compilation pipeline (§5.2):
 * 1. Normalize external schemas
 * 2. Resolve identity & duplicates
 * 3. Apply overlays (stub for v0.1)
 * 4. Generate agent-facing names
 * 5. Simplify input/output schemas
 * 6. Infer conservative effects
 * 7. Apply preset defaults
 * 8. Validate invariants
 * 9. Freeze and hash snapshot
 *
 * Determinism requirement (§17 criterion 2):
 * Same input MUST produce identical hash across processes and Node versions.
 */

import type { DiscoveredOperation } from '../sources/types.js';
import type { RegistrySnapshot, OperationDefinition } from '../types.js';
import type {
  CompilerContext,
  CompilerPass,
  CompiledOperation,
  WarningCollector,
  CompilerWarning,
  PresetName,
  Overlay,
} from './types.js';

// Import all passes
import { normalizeSchemas } from './passes/normalize-schemas.js';
import { resolveIdentity } from './passes/resolve-identity.js';
import { applyOverlays } from './passes/apply-overlays.js';
import { generateNames } from './passes/generate-names.js';
import { simplifySchemas } from './passes/simplify-schemas.js';
import { inferEffects } from './passes/infer-effects.js';
import { applyPresetDefaults } from './passes/apply-preset-defaults.js';
import { validateInvariants } from './passes/validate-invariants.js';
import { freezeAndHash } from './passes/freeze-and-hash.js';
import { createSnapshot } from './passes/freeze-and-hash.js';

// =============================================================================
// Warning collector implementation
// =============================================================================

class WarningCollectorImpl implements WarningCollector {
  private warnings: CompilerWarning[] = [];

  warn(warning: CompilerWarning): void {
    this.warnings.push(warning);
  }

  getWarnings(): readonly CompilerWarning[] {
    return this.warnings;
  }
}

// =============================================================================
// Compiler implementation
// =============================================================================

/**
 * Deterministic compiler pass order.
 * Order is critical - passes depend on outputs from prior passes.
 */
const COMPILER_PASSES: readonly CompilerPass[] = [
  normalizeSchemas,
  resolveIdentity,
  applyOverlays,
  generateNames,
  simplifySchemas,
  inferEffects,
  applyPresetDefaults,
  validateInvariants,
  freezeAndHash,
];

/**
 * Compiler interface
 */
export interface Compiler {
  /**
   * Compile discovered operations into a deterministic registry snapshot
   *
   * @param discovered - Operations from sources
   * @param context - Compiler context (logger, warnings, overlays, preset)
   * @returns Immutable, hashable registry snapshot
   */
  compile(
    discovered: readonly DiscoveredOperation[],
    context: Omit<CompilerContext, 'warnings'>,
  ): Promise<RegistrySnapshot>;
}

/**
 * Create a new compiler instance
 */
export function createCompiler(version: number = 1): Compiler {
  return {
    async compile(
      discovered: readonly DiscoveredOperation[],
      context: Omit<CompilerContext, 'warnings'>,
    ): Promise<RegistrySnapshot> {
      const warnings = new WarningCollectorImpl();
      const fullContext: CompilerContext = {
        ...context,
        warnings,
      };

      fullContext.logger.info('Starting compilation', {
        discoveredCount: discovered.length,
        preset: fullContext.preset,
      });

      // Convert DiscoveredOperation to CompiledOperation
      let operations: readonly CompiledOperation[] = discovered.map(op => ({
        candidateId: op.candidateId,
        name: op.name,
        description: op.description,
        rawInput: op.rawInput,
        rawOutput: op.rawOutput,
        source: op.source,
        hints: op.hints,
        effects: op.effects,
        executor: op.executor,
        annotations: op.annotations,
        provenance: op.provenance,
      }));

      // Run all passes in order
      for (const pass of COMPILER_PASSES) {
        fullContext.logger.debug(`Running pass: ${pass.name}`, {
          inputCount: operations.length,
        });

        operations = await pass.run(operations, fullContext);

        fullContext.logger.debug(`Pass complete: ${pass.name}`, {
          outputCount: operations.length,
        });
      }

      // Create final snapshot
      const definitions = operations as readonly OperationDefinition[];
      const snapshot = createSnapshot(definitions, version);

      const collectedWarnings = warnings.getWarnings();
      fullContext.logger.info('Compilation complete', {
        operationCount: snapshot.operations.size,
        warningCount: collectedWarnings.length,
        hash: snapshot.hash,
      });

      if (collectedWarnings.length > 0) {
        fullContext.logger.warn('Compilation warnings', {
          warnings: collectedWarnings,
        });
      }

      return snapshot;
    },
  };
}

// =============================================================================
// Exports
// =============================================================================

export type {
  CompilerContext,
  CompilerPass,
  CompilerWarning,
  WarningCollector,
  CompiledOperation,
  PresetName,
  Overlay,
};

export { COMPILER_PASSES };
