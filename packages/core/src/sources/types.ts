// SPDX-License-Identifier: Apache-2.0
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
 * Logger interface for discovery context. **Legacy — new code should use
 * `StructuredLogger`** (`logging/types.ts`).
 *
 * Minimal subset: `debug`/`info`/`warn`/`error` with an unconstrained
 * `Record<string, unknown>` of metadata.
 *
 * ## Two logger types exist, and this is the older one (#133)
 *
 * `StructuredLogger` (#38, §9.3) is a strict superset — it adds `trace` and
 * `child()`, and its methods are generic so that logging a §9.4 forbidden field
 * such as `rawInput` is a COMPILE error. This interface has neither: no
 * `child()` for request-scoped fields, no `trace`, and `meta` accepts anything.
 *
 * There is no name collision to trip over — the two are `Logger` and
 * `StructuredLogger` — so a call site that needs `child()` and holds this type
 * gets a compile error rather than a surprise. The hazard is subtler: you can
 * quite reasonably reach for this one, log a forbidden field, and have nothing
 * object.
 *
 * ## Why it still exists
 *
 * It sits on two documented public seams — `DiscoveryContext.logger` (below)
 * and `CompilerContext.logger`. Widening those to `StructuredLogger` is safe
 * for CONSUMERS (a superset still has `.info()`), but every CONSTRUCTOR of
 * those contexts would then have to supply `trace` and `child`: both
 * `NOOP_LOGGER` constants in `reload/`, every adapter fixture, and every test
 * that builds a discovery context. That is a real migration, on a public seam,
 * and it is scheduled rather than skipped.
 *
 * **Retirement trigger: Epic #3 / #49**, which opens these files anyway to
 * replace the `RedactionFn` placeholder with the central redaction pipeline.
 * Migrating before that target exists risks moving the same call sites twice.
 *
 * Full reasoning, and the decision record:
 * `docs/adr/ADR-021-two-logger-types.md`.
 *
 * To bridge from a `StructuredLogger` to this type — which is what the gateway
 * does to satisfy `DiscoveryContext` — use `asLegacyLogger`. It enforces the
 * §9.4 forbidden-field list at runtime, because the compile-time guard cannot
 * reach across this interface's signature.
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
   *
   * Sources should check this periodically. "Abort cleanly" used to be the
   * whole instruction, which implied a rule without stating one — and that
   * ambiguity is what let two frames of `compositeSource` disagree about what
   * an aborted run returns (#340). So, stated:
   *
   * **An aborted `discover()` RESOLVES with `[]`. It does not reject, and it
   * does not return partial results.**
   *
   * Partial results are excluded on purpose: a half-discovered set flows into
   * the compiler and the registry snapshot hash, producing a valid-looking but
   * silently incomplete registry. `[]` is unmistakably empty.
   *
   * An implementation with nothing interruptible may ignore the signal
   * entirely — `fromDefinitions` is a synchronous map and does exactly that.
   * What it must not do is invent a third behaviour.
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
