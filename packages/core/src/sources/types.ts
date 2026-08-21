/**
 * Operation source types - discovery interface and context
 *
 * Sources are Strategy implementations that discover operations from various inputs
 * (OpenAPI, framework routes, explicit definitions). Multiple sources combine via
 * Composite pattern. Conflict resolution is the compiler's responsibility.
 */

import type { OperationDefinition, JSONSchema } from '../types.js';

// =============================================================================
// Logger interface (minimal subset for discovery)
// =============================================================================

/**
 * Logger interface for discovery context.
 * Minimal subset - full logging integration deferred to observability epic.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// =============================================================================
// Discovery context
// =============================================================================

/**
 * Discovery context - ambient state available to all sources during discovery.
 * Generic type parameter allows adapter-specific extensions without `any`.
 */
export interface DiscoveryContext<TExtensions = Record<string, never>> {
  /**
   * Logger for discovery-time messages.
   */
  readonly logger: Logger;

  /**
   * Cancellation signal for long-running discovery.
   * Sources should check this periodically and abort cleanly.
   */
  readonly abortSignal: AbortSignal;

  /**
   * Adapter-specific extension slots.
   * Type-safe via generics - no `any`.
   */
  readonly extensions?: Readonly<TExtensions>;
}

// =============================================================================
// Discovered operation (superset of OperationDefinition)
// =============================================================================

/**
 * Source metadata - tracks where an operation was discovered.
 */
export interface SourceMetadata {
  /**
   * Source kind (openapi, framework, code, etc.)
   */
  readonly kind: string;

  /**
   * Optional source location (file path, URL, or human-readable hint)
   */
  readonly location?: string;
}

/**
 * Discovered operation - superset of OperationDefinition.
 *
 * Carries source-specific hints that compiler passes may consume, drop, or normalize.
 * Sources emit everything they find - conflict resolution is the compiler's job.
 */
export interface DiscoveredOperation {
  /**
   * Candidate operation ID.
   * May conflict with other sources - compiler resolves duplicates.
   */
  readonly candidateId: string;

  /**
   * Operation name (agent-facing tool name).
   */
  readonly name: string;

  /**
   * Human and agent-readable description.
   */
  readonly description: string;

  /**
   * Input schema.
   * May be raw (pre-normalization) or already JSONSchema.
   */
  readonly rawInput?: JSONSchema;

  /**
   * Output schema.
   * May be raw (pre-normalization) or already JSONSchema.
   */
  readonly rawOutput?: JSONSchema;

  /**
   * Source metadata - where this operation was discovered.
   */
  readonly source: SourceMetadata;

  /**
   * Source-specific hints for compiler passes.
   * Examples: HTTP method, route pattern, OpenAPI operationId, framework metadata.
   * Compiler may consume these for name generation, effect inference, etc.
   */
  readonly hints?: Readonly<Record<string, unknown>>;

  /**
   * Optional fields that may be present if source already derived them.
   * Compiler will fill in missing fields or override with enhancements.
   */
  readonly effects?: Partial<OperationDefinition['effects']>;
  readonly executor?: OperationDefinition['executor'];
  readonly annotations?: OperationDefinition['annotations'];
  readonly provenance?: OperationDefinition['provenance'];
}

// =============================================================================
// Operation source interface
// =============================================================================

/**
 * Operation source - Strategy interface for pluggable discovery.
 *
 * Sources discover operations from various inputs and return DiscoveredOperation[].
 * Multiple sources combine via Composite pattern.
 * Conflict resolution is the compiler's responsibility, not the source's.
 */
export interface OperationSource<TExtensions = Record<string, never>> {
  /**
   * Source identifier (unique within a compilation context).
   */
  readonly id: string;

  /**
   * Discover operations from this source.
   *
   * Returns all operations found - duplicates are fine, compiler handles dedup.
   * May be async (e.g., HTTP fetch for OpenAPI) or sync (explicit definitions).
   *
   * @param context - Discovery context with logger, abort signal, extensions
   * @returns Array of discovered operations
   */
  discover(context: DiscoveryContext<TExtensions>): Promise<DiscoveredOperation[]>;
}
