// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP transport types - MCP Streamable HTTP server configuration
 */

import type { BulkheadsConfig, RetryConfig } from '@askturret/mcp-core';
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
   * Shutdown transport and clean up resources
   */
  shutdown(): Promise<void>;
}
