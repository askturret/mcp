// SPDX-License-Identifier: Apache-2.0
/**
 * Compiler types - pass interface, context, and compiled operation
 *
 * The compiler transforms DiscoveredOperation[] into a deterministic RegistrySnapshot.
 * Each pass is pure, stateless, and order-dependent.
 */

import type { Logger } from '../sources/types.js';
import type { OperationDefinition, EffectMetadata } from '../types.js';

// =============================================================================
// Warning collection
// =============================================================================

/**
 * Compiler warning - non-fatal issue captured during compilation.
 */
export interface CompilerWarning {
  /**
   * Warning code (e.g., 'DUPLICATE_OPERATION_ID', 'MISSING_DESCRIPTION')
   */
  readonly code: string;

  /**
   * Human-readable warning message
   */
  readonly message: string;

  /**
   * Optional source location (file path, operation ID, etc.)
   */
  readonly location?: string;

  /**
   * Optional additional context
   */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Warning collector - accumulates warnings during compilation.
 */
export interface WarningCollector {
  /**
   * Add a warning
   */
  warn(warning: CompilerWarning): void;

  /**
   * Get all collected warnings
   */
  getWarnings(): readonly CompilerWarning[];
}

// =============================================================================
// Overlays (stub for v0.1)
// =============================================================================

/**
 * Overlay - enhancement applied on top of discovered operations.
 * Full implementation in Epic #4; v0.1 supports only "no overlays".
 */
export interface Overlay {
  readonly id: string;
  readonly [key: string]: unknown;
}

// =============================================================================
// Presets
// =============================================================================

/**
 * Preset name - determines default policy and behavior.
 */
export type PresetName = 'light' | 'production' | 'regulated';

// =============================================================================
// Compiled operation (intermediate form)
// =============================================================================

/**
 * Compiled operation - intermediate form during compilation.
 *
 * Starts as DiscoveredOperation, progressively enhanced by passes,
 * eventually becomes OperationDefinition.
 *
 * This is a superset type carrying both pre-compilation and post-compilation fields.
 * Uses Omit to exclude 'effects' from the base, then adds a compatible mid-pipeline type.
 */
export interface CompiledOperation extends Omit<Partial<OperationDefinition>, 'effects'> {
  /**
   * Candidate ID (may not be final)
   */
  candidateId?: string;

  /**
   * Name (required)
   */
  name: string;

  /**
   * Description (required)
   */
  description: string;

  /**
   * Source metadata (preserved through compilation)
   */
  source?: {
    readonly kind: string;
    readonly location?: string;
  };

  /**
   * Source-specific hints (consumed by passes, dropped before freeze)
   */
  hints?: Readonly<Record<string, unknown>>;

  /**
   * Raw input schema (normalized by early pass)
   */
  rawInput?: Record<string, unknown>;

  /**
   * Raw output schema (normalized by early pass)
   */
  rawOutput?: Record<string, unknown>;

  /**
   * Effect metadata - may be partial until infer-effects pass (step 6) completes.
   * Sources may only specify some effect fields; compiler fills in the rest.
   * Pass 8 (validate-invariants) ensures completeness before freezing.
   */
  effects?: Partial<EffectMetadata>;
}

// =============================================================================
// Compiler context
// =============================================================================

/**
 * Compiler context - ambient state available to all passes.
 */
export interface CompilerContext {
  /**
   * Logger for compiler messages
   */
  readonly logger: Logger;

  /**
   * Warning collector for non-fatal issues
   */
  readonly warnings: WarningCollector;

  /**
   * Overlays to apply (full engine in Epic #4; v0.1 = empty array)
   */
  readonly overlays: readonly Overlay[];

  /**
   * Preset for defaults
   */
  readonly preset: PresetName;
}

// =============================================================================
// Compiler pass interface
// =============================================================================

/**
 * Compiler pass - pure transformation over operations.
 *
 * Each pass receives the operations array and context, returns a transformed array.
 * Passes are executed in deterministic order (see compiler implementation).
 *
 * Purity requirement:
 * - No I/O (no HTTP, file reads, env reads)
 * - No time-dependent behavior (no Date.now(), Math.random())
 * - Deterministic output for same input
 */
export interface CompilerPass {
  /**
   * Pass name (for logging and diagnostics)
   */
  readonly name: string;

  /**
   * Transform operations
   *
   * @param operations - Current operations array (readonly)
   * @param context - Compiler context (logger, warnings, overlays, preset)
   * @returns Transformed operations array
   */
  run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]>;
}
