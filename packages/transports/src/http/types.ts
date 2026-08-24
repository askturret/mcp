// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP transport types - MCP Streamable HTTP server configuration
 */

import type {
  AuditSink,
  BreakerStats,
  BreakersConfig,
  BulkheadsConfig,
  HealthReport,
  Observability,
  ReloadController,
  RetryConfig,
  ShutdownResult,
  StructuredLogger,
} from '@askturret/mcp-core';
import type {
  RegistryReference,
  DispatcherHooks,
  OperationExecutor,
  Policy,
  PolicyMetrics,
  ConfirmationRegistry,
  AuthorizationTimings,
} from '@askturret/mcp-core';

/**
 * Session store interface - pluggable session persistence
 */
export interface SessionStore {
  /**
   * Get session data by ID
   */
  get(sessionId: string): Promise<SessionData | null>;

  /**
   * Set session data
   */
  set(sessionId: string, data: SessionData): Promise<void>;

  /**
   * Delete session
   */
  delete(sessionId: string): Promise<void>;
}

/**
 * Session data - persisted per-session state
 */
export interface SessionData {
  /**
   * Client information from initialize
   */
  readonly clientInfo?: {
    readonly name: string;
    readonly version: string;
  };

  /**
   * MCP protocol version negotiated at `initialize` (#61).
   *
   * Recorded per session rather than read from a constant at call time,
   * because the whole point of negotiating is that two sessions may have
   * agreed different things. It is what every later call on this session
   * stamps onto `mcp.protocol.version`.
   *
   * Optional so a store persisted before #61 still loads — an old session
   * record simply falls back to the announced default rather than failing to
   * deserialize.
   */
  readonly protocolVersion?: string;

  /**
   * Session creation timestamp
   */
  readonly createdAt: Date;

  /**
   * Last activity timestamp
   */
  readonly lastActivityAt: Date;
}

/**
 * HTTP transport configuration
 */
export interface HttpTransportOptions {
  /**
   * Bulkhead configuration, forwarded to the dispatcher (#43, §8.2).
   *
   * Without this the option would exist on `DispatcherOptions` and be
   * unreachable from any adapter — the transport is what constructs the
   * dispatcher — so bulkheads would ship configurable only in theory.
   *
   * Reachable from the facades for free: `McpFacadeOptions.transport` is
   * spread into these options, so `transport: { bulkheads: { ... } }` works on
   * both Express and Fastify without either adapter changing.
   */
  readonly bulkheads?: BulkheadsConfig;

  /**
   * Retry policy, forwarded to the dispatcher (#45, §8.4).
   *
   * Here for the same reason as `bulkheads` above: the transport is what
   * constructs the dispatcher, so an option that exists only on
   * `DispatcherOptions` is unreachable from any adapter. Because
   * `McpFacadeOptions.transport` is spread into these options, `transport:
   * { retry: { ... } }` works on both Express and Fastify without either
   * adapter changing.
   */
  readonly retry?: RetryConfig;

  /**
   * Circuit breakers, forwarded to the dispatcher (#46, §8.5).
   *
   * Same seam as `bulkheads` and `retry` above: the transport constructs the
   * dispatcher, so an option that lives only on `DispatcherOptions` is
   * unreachable from any adapter. `transport: { breakers: { ... } }` works on
   * both Express and Fastify without either adapter changing.
   */
  readonly breakers?: BreakersConfig;

  /**
   * Audit sink with mandatory-delivery semantics (#48, §9.3).
   *
   * Forwarded to the dispatcher AND wired into §8.6 phase 5: when this is set
   * and no explicit `flushAudit` is supplied, shutdown flushes this sink.
   * That is what turns phase 5's promise -- audit outlives telemetry on
   * shutdown -- into behaviour rather than an aspiration.
   */
  readonly auditSink?: AuditSink;

  /**
   * Span tree and metrics, forwarded to the dispatcher (#39, §9.1 / §9.2).
   *
   * Same reason `bulkheads` is here: the option existed on `DispatcherOptions`
   * and the transport is what constructs the dispatcher, so until now there was
   * NO path from any adapter to the dispatcher's telemetry. `openTelemetry()`
   * shipped in #39 and every caller that reached for it got a no-op tracer and
   * a no-op recorder, silently — the wiring simply did not exist.
   *
   * Found while building the gateway (#57), whose Prometheus endpoint would
   * otherwise have scraped an always-empty registry and reported a healthy zero
   * for every metric. That is worse than no endpoint: it looks like a server
   * with no traffic rather than one with no instrumentation.
   *
   * Absent still means no-op on both, so nothing changes for a caller that does
   * not set it.
   */
  readonly observability?: Observability;

  /**
   * Structured logger for the dispatcher's stage-level logs (#38, §9.3).
   *
   * Unreachable from an adapter for the same reason as `observability`. Absent
   * means SILENT, exactly as `DispatcherOptions` documents — importing this
   * package must never write to an adopter's stdout uninvited.
   *
   * These are operational logs, NOT audit records. `auditSink` above remains
   * the only channel carrying a delivery guarantee.
   */
  readonly logger?: StructuredLogger;

  /**
   * Reload controller, so `/health/ready` can report a degraded reload (§8.7).
   *
   * `ReloadController.readiness()` already existed and its own docs say it is
   * "for a health endpoint to surface" — #47 is that endpoint. Reading the
   * CACHED state it maintains, never triggering a reload.
   */
  readonly reload?: ReloadController;

  /**
   * Enforce dependency conditions in readiness (§8.7 "production preset").
   *
   * Default false. Outside production an unreachable audit sink or a fully
   * open breaker set is a degraded instance, not one to pull from rotation —
   * and pulling EVERY instance for a shared dependency blip takes the service
   * down instead of the dependency.
   */
  readonly enforceDependencies?: boolean;

  /**
   * Last known audit-sink reachability. Must be CACHED, never a live probe:
   * §8.7 forbids readiness fanning out to dependencies.
   */
  readonly auditSinkReachable?: () => boolean;

  /** Event-loop budget for `/health/live`. Default 200ms (§8.7). */
  readonly livenessBudgetMs?: number;

  /** §8.6 phase 5 — must complete. Stronger delivery than telemetry. */
  readonly flushAudit?: () => Promise<void>;

  /** §8.6 phase 6 — best-effort, bounded. */
  readonly flushTelemetry?: () => Promise<void>;

  /** §8.6 phase 7 — executors, HTTP clients, anything the adopter owns. */
  readonly closeResources?: () => Promise<void>;

  /**
   * Registry reference (snapshot provider)
   */
  readonly registry: RegistryReference;

  /**
   * Optional dispatcher hooks for auth, policy, etc.
   */
  readonly hooks?: DispatcherHooks;

  /**
   * Optional executors map (for testing or custom executor registration)
   */
  readonly executors?: Map<string, OperationExecutor>;

  /**
   * Base path for MCP endpoints (default: '/mcp')
   */
  readonly basePath?: string;

  /**
   * Session configuration
   * - undefined: stateless (no session persistence)
   * - 'inMemory': in-memory session store
   * - SessionStore: custom session store
   */
  readonly session?: 'inMemory' | SessionStore;

  /**
   * Optional discovery-time visibility policy.
   *
   * When set, `tools/list` returns only the operations this policy does not
   * deny. `confirmation_required` operations stay listed — the confirmation
   * happens at call time.
   *
   * When unset, `tools/list` lists every operation in the snapshot, which is
   * the behaviour before this option existed.
   *
   * **This is not the security boundary** (§5.5): it shrinks what an agent
   * sees, not what it can invoke. Anything hidden here must also be denied at
   * call time by the same policy.
   */
  readonly visibilityPolicy?: Policy;

  /**
   * Call-time authorization policy — dispatcher stage 3.
   *
   * **This is the security boundary** (§5.5). `visibilityPolicy` shrinks what
   * an agent sees; this decides what it may actually do. Anything hidden at
   * discovery should also be denied here — usually by passing the same policy
   * to both, since one `Policy` serves both phases.
   *
   * When unset, stage 3 falls back to the `authorize` hook alone, which
   * defaults to allow-all. Enabling enforcement is an explicit act.
   */
  readonly authorizationPolicy?: Policy;

  /** Tuning for call-time authorization. Ignored without an `authorizationPolicy`. */
  readonly authorization?: {
    /**
     * Confirmation registry. Supply one to control nonce/TTL behaviour, or to
     * share issuance across transports; otherwise a default is created.
     */
    readonly confirmations?: ConfirmationRegistry;
    /** Decision counter sink. Defaults to a no-op until observability (#39). */
    readonly metrics?: PolicyMetrics;
    /** Duration sink for `mcp_authorization_duration_seconds`. */
    readonly timings?: AuthorizationTimings;
  };

  /**
   * Tuning for the visibility decision cache. Ignored without a
   * `visibilityPolicy`.
   */
  readonly visibility?: {
    /** Cache lifetime in ms. Defaults to 30s. `0` disables caching. */
    readonly ttlMs?: number;
    /** Maximum distinct identities cached. Defaults to 1000. */
    readonly maxEntries?: number;
    /** Fingerprint of policy configuration; see `VisibilityEngineOptions`. */
    readonly policyVersion?: string;
    /** Decision counter sink. Defaults to a no-op until observability (#39). */
    readonly metrics?: PolicyMetrics;
  };

  /**
   * Allowed Host header values (DNS rebinding mitigation)
   * Default: ['localhost', '127.0.0.1', '[::1]']
   */
  readonly allowedHosts?: string[];

  /**
   * Default deadline per call in milliseconds (default: 30000)
   */
  readonly deadlineMs?: number;

  /**
   * Maximum request body size in bytes (default: 1048576 = 1 MiB)
   */
  readonly maxRequestBodySize?: number;

  /**
   * Maximum response size in bytes (default: 1048576 = 1 MiB)
   */
  readonly maxResponseSize?: number;
}

/**
 * HTTP transport interface - wraps MCP SDK server
 */
export interface HttpTransport {
  /**
   * Get HTTP request handler for integration with Express/Fastify
   */
  handler(): (req: unknown, res: unknown) => Promise<void>;

  /**
   * Shutdown transport and clean up resources.
   *
   * Retained for compatibility; delegates to `close()`. Before #47 this was an
   * empty stub, so an existing caller got no shutdown at all.
   */
  shutdown(): Promise<void>;

  /**
   * Graceful shutdown following the §8.6 sequence.
   *
   * Idempotent: concurrent or repeated calls share one shutdown. Two drains
   * running at once would double-flush the audit sink and race to close the
   * same resources.
   */
  close(options?: { drainMs?: number }): Promise<ShutdownResult>;

  /** Skip the drain; audit flush is still attempted (§8.6). */
  forceClose(): Promise<ShutdownResult>;

  /** Cached readiness for `/health/ready` (§8.7). Never probes a dependency. */
  readiness(): HealthReport;

  /** Event-loop responsiveness for `/health/live` (§8.7). */
  liveness(): Promise<HealthReport>;

  /**
   * Current state of every configured circuit breaker (#46, §8.5).
   *
   * Forwarded from the dispatcher. #46 added this read seam for #56's
   * Explorer work, but only on `CommandDispatcher` — which the transport
   * constructs and keeps private, so no adopter could reach it. Same shape of
   * gap as the `bulkheads` / `retry` / `breakers` options each needed closing
   * for: a seam that exists only on an object nobody holds is configurable in
   * theory. Surfaced while building #51, which needs it to observe breaker
   * state during a load scenario.
   */
  breakerStats(): readonly BreakerStats[];
}
