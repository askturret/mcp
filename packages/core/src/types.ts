// SPDX-License-Identifier: Apache-2.0
/**
 * Core type definitions for AskTurret MCP
 *
 * Canonical OperationDefinition, OperationCommand, OperationResult, and error types.
 * These types form the foundational type surface - every source produces it,
 * every compiler pass transforms it, every executor consumes it.
 *
 * ADR-002: Canonical OperationDefinition - source-agnostic model
 * ADR-011: Typed operational errors - no raw exceptions cross transport boundary
 */

// =============================================================================
// JSON Schema representation
// =============================================================================

/**
 * JSON Schema type - simplified representation for I/O validation.
 * Full JSON Schema support is deferred; this covers common validation needs.
 */
export type JSONSchema = Record<string, unknown>;

// =============================================================================
// Operation identity and definition
// =============================================================================

/**
 * Unique identifier for an operation within a registry snapshot.
 */
export type OperationId = string;

/**
 * Effect classifications - semantic tags for operation behavior.
 * Used by policy engine for authorization decisions.
 */
export type EffectClassification =
  | 'financial'
  | 'destructive'
  | 'data-export'
  | 'notification'
  | 'state-change';

/**
 * Effect metadata - describes operation safety characteristics.
 * Used by retry logic, policy, and audit systems.
 */
export interface EffectMetadata {
  /**
   * True if operation reads but does not mutate state.
   * Read-only operations can be retried freely.
   */
  readonly readOnly: boolean;

  /**
   * True if repeated execution with the same input produces the same result
   * and does not cause additional side effects.
   * Idempotent operations are safe to auto-retry.
   */
  readonly idempotent: boolean;

  /**
   * True if operation is safe to retry on transient failure.
   * May be false even for idempotent operations if retry could cause issues.
   */
  readonly retryable: boolean;

  /**
   * True if client must supply an idempotency key.
   * Enforced by dispatcher before execution.
   */
  readonly idempotencyKeyRequired: boolean;

  /**
   * Semantic effect classifications for policy evaluation.
   * Examples: 'financial', 'destructive', 'data-export'
   */
  readonly classifications: readonly EffectClassification[];
}

/**
 * Provenance entry - tracks origin of a field value through compilation.
 * Enables Explorer to explain "where did this description come from?"
 */
export interface ProvenanceEntry {
  /**
   * Field path this entry applies to (e.g., 'description', 'effects.readOnly')
   */
  readonly field: string;

  /**
   * Source kind that contributed this value.
   *
   * `x-mcp` was added by #55. §5.3's chain has six LEVELS, and level 3 is
   * source-native `x-mcp` metadata — which had no representation here, since
   * `openapi` and `framework` are both level 4 (the source definition itself).
   * Without a distinct kind, a value an adopter wrote in `x-mcp` and one the
   * spec merely implied were indistinguishable in the provenance record, which
   * is the question §5.3 exists to answer.
   */
  readonly kind:
    | 'openapi'
    | 'framework'
    | 'overlay'
    | 'code'
    | 'x-mcp'
    | 'inference'
    | 'preset';

  /**
   * Optional source location (file path, line, or URL).
   */
  readonly location?: string;
}

/**
 * Executor binding - opaque reference to execution strategy.
 * Actual executor (viaHandler, viaHttp, custom) resolved at dispatch time.
 */
export interface ExecutorBinding {
  /**
   * Executor type identifier.
   */
  readonly type: string;

  /**
   * Executor-specific configuration (opaque to the canonical model).
   */
  readonly config?: Readonly<Record<string, unknown>>;
}

/**
 * Canonical operation definition.
 *
 * This is the foundational type - source-agnostic, immutable, and deep-frozen.
 * Every operation surface (OpenAPI, framework routes, explicit definitions)
 * compiles into this model.
 *
 * Invariants:
 * 1. Deep-frozen once constructed - mutation attempts throw in dev, no-op in prod
 * 2. No source-specific fields - use annotations or provenance instead
 * 3. Schema fields use JSONSchema, not source-native formats
 */
export interface OperationDefinition {
  /**
   * Unique identifier within a registry snapshot.
   */
  readonly id: OperationId;

  /**
   * Agent-facing tool name.
   * Generated or enhanced by compiler to be agent-friendly.
   */
  readonly name: string;

  /**
   * Human and agent-readable operation description.
   */
  readonly description: string;

  /**
   * JSON Schema for operation input validation.
   */
  readonly input: JSONSchema;

  /**
   * JSON Schema for operation output validation.
   */
  readonly output: JSONSchema;

  /**
   * Effect metadata - safety and retry characteristics.
   */
  readonly effects: EffectMetadata;

  /**
   * Executor binding - references how this operation executes.
   * Actual executor strategy resolved by dispatcher.
   */
  readonly executor: ExecutorBinding;

  /**
   * Optional source-specific or custom annotations.
   * Use for metadata that doesn't fit canonical fields.
   */
  readonly annotations?: Readonly<Record<string, unknown>>;

  /**
   * Optional provenance chain - tracks field origins through compilation.
   */
  readonly provenance?: readonly ProvenanceEntry[];
}

// =============================================================================
// Command and execution context
// =============================================================================

/**
 * Principal - authenticated identity executing an operation.
 * Used by policy engine for authorization.
 */
export interface Principal {
  /**
   * Principal identifier (user ID, API key hash, etc.)
   */
  readonly id: string;

  /**
   * Principal type (user, service, api-key, etc.)
   */
  readonly type: string;

  /**
   * Permissions this principal holds, consumed by `permissionPolicy`.
   *
   * Absent and empty mean the same thing to policy: no permissions. There is
   * deliberately no "all permissions" sentinel — a wildcard here would be a
   * value that silently satisfies every future permission check, including
   * ones nobody has written yet.
   */
  readonly permissions?: readonly string[];

  /**
   * Additional principal attributes for policy evaluation.
   */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * Confirmation proof - evidence that user confirmed a high-risk action.
 * Required for operations where policy demands explicit confirmation.
 */
export interface ConfirmationProof {
  /**
   * Confirmation challenge ID that was presented.
   */
  readonly challengeId: string;

  /**
   * User's confirmation response.
   */
  readonly response: string;

  /**
   * Timestamp when confirmation was obtained.
   */
  readonly confirmedAt: Date;
}

/**
 * Operation command - execution request envelope.
 *
 * Carries all context needed for a single operation execution:
 * identity, input, deadlines, cancellation, and registry version.
 */
export interface OperationCommand {
  /**
   * Unique request identifier for tracing and deduplication.
   */
  readonly requestId: string;

  /**
   * Optional trace ID for distributed tracing correlation.
   */
  readonly traceId?: string;

  /**
   * Optional client information from MCP session initialization.
   * Propagated from transport layer for context/audit.
   */
  readonly clientInfo?: {
    readonly name?: string;
    readonly version?: string;
  };

  /**
   * MCP protocol version negotiated for this session (#61, §9.1).
   *
   * Propagated from the transport for the same reason as `clientInfo` above:
   * session state the dispatcher reports but does not own. Stamped onto the
   * `mcp.protocol.version` span attribute.
   *
   * Absent falls back to the announced default — which is what a caller
   * dispatching directly gets, since without a transport there was no
   * negotiation to record.
   */
  readonly protocolVersion?: string;

  /**
   * Operation to execute.
   */
  readonly operationId: OperationId;

  /**
   * Operation input (validated against operation's input schema).
   */
  readonly input: unknown;

  /**
   * Optional authenticated principal.
   */
  readonly principal?: Principal;

  /**
   * Optional confirmation proof for high-risk operations.
   */
  readonly confirmation?: ConfirmationProof;

  /**
   * Optional idempotency key for duplicate prevention.
   * Required if operation's effects.idempotencyKeyRequired is true.
   */
  readonly idempotencyKey?: string;

  /**
   * Absolute execution deadline.
   * Executors must respect this via AbortSignal propagation.
   */
  readonly deadline: Date;

  /**
   * Cancellation signal.
   * Executors must propagate to downstream calls.
   */
  readonly signal: AbortSignal;

  /**
   * Registry snapshot hash this command executes against.
   * Enables audit trail showing which operation version executed.
   */
  readonly registryHash: string;
}

// =============================================================================
// Results and errors
// =============================================================================

/**
 * Result metadata - optional execution context.
 */
export interface ResultMetadata {
  /**
   * Execution duration in milliseconds.
   */
  readonly durationMs?: number;

  /**
   * Whether result came from cache.
   */
  readonly cached?: boolean;

  /**
   * Retry attempt number (1-indexed, absent if no retry).
   */
  readonly attempt?: number;

  /**
   * Additional executor-specific metadata.
   */
  readonly [key: string]: unknown;
}

/**
 * Operation error codes - exhaustive set of expected failure modes.
 *
 * Invariant: OUTCOME_UNKNOWN is distinct from failure.
 * For non-idempotent writes, a lost upstream response may mean success.
 * Agents must not auto-retry OUTCOME_UNKNOWN.
 */
export type OperationErrorCode =
  | 'INVALID_INPUT'           // Input validation failed
  | 'UNAUTHENTICATED'         // No valid principal
  | 'FORBIDDEN'               // Principal not authorized
  | 'CONFIRMATION_REQUIRED'   // High-risk operation needs confirmation
  | 'RATE_LIMITED'            // Rate limit exceeded
  | 'QUEUE_FULL'              // Bulkhead capacity exhausted
  | 'TIMEOUT'                 // Deadline exceeded
  | 'CANCELLED'               // Request cancelled via AbortSignal
  | 'UPSTREAM_UNAVAILABLE'    // Upstream service unreachable
  | 'OUTCOME_UNKNOWN'         // Lost response, outcome uncertain (do NOT retry)
  | 'OUTPUT_TOO_LARGE'        // Response exceeds size limit
  | 'INTERNAL_ERROR';         // Unexpected internal error

/**
 * Operation error - safe error projection across transport boundary.
 *
 * Invariant: never contains raw exception stacks or internal type names.
 * Those get logged separately via redaction pipeline.
 */
export interface OperationError {
  /**
   * Error code - discriminates failure type.
   */
  readonly code: OperationErrorCode;

  /**
   * Human-readable error message (redacted, safe for transport).
   */
  readonly message: string;

  /**
   * Optional structured error details (safe for transport).
   */
  readonly details?: Readonly<Record<string, unknown>>;

  /**
   * Optional retry-after hint in seconds (for RATE_LIMITED).
   */
  readonly retryAfter?: number;
}

/**
 * Operation result - discriminated union of success/failure.
 *
 * Type-safe result handling - no exceptions cross the transport boundary.
 */
export type OperationResult<T = unknown> =
  | { ok: true; value: T; metadata?: ResultMetadata }
  | { ok: false; error: OperationError };

// =============================================================================
// Registry snapshot
// =============================================================================

/**
 * Immutable registry snapshot - versioned capability surface.
 *
 * Compilation builds a candidate snapshot off the request path.
 * Once validated, a single atomic reference is swapped.
 * In-flight calls retain the snapshot they began with.
 */
export interface RegistrySnapshot {
  /**
   * Snapshot version (monotonic).
   */
  readonly version: number;

  /**
   * Content hash for snapshot verification.
   */
  readonly hash: string;

  /**
   * Snapshot creation timestamp.
   */
  readonly createdAt: Date;

  /**
   * All registered operations, keyed by ID.
   */
  readonly operations: ReadonlyMap<OperationId, OperationDefinition>;
}
