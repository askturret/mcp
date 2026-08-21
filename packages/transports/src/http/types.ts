// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP transport types - MCP Streamable HTTP server configuration
 */

import type { RegistryReference, DispatcherHooks } from '@askturret/mcp-core';

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
   * Registry reference (snapshot provider)
   */
  readonly registry: RegistryReference;

  /**
   * Optional dispatcher hooks for auth, policy, etc.
   */
  readonly hooks?: DispatcherHooks;

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
