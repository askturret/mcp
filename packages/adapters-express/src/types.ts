// SPDX-License-Identifier: Apache-2.0
/**
 * Express adapter type definitions
 */

import type { OperationSource, DispatcherHooks } from '@askturret/mcp-core';
import type { HttpTransportOptions } from '@askturret/mcp-transports';

/**
 * Express MCP configuration options (composable form)
 */
export interface ExpressMcpOptions {
  /**
   * Operation sources to compile and expose
   */
  sources: OperationSource[];

  /**
   * Optional dispatcher hooks for auth, policy, etc.
   */
  hooks?: DispatcherHooks;

  /**
   * Base path for MCP endpoints (default: '/mcp')
   */
  basePath?: string;

  /**
   * Transport configuration
   * Default: stateless HTTP transport with Light preset defaults
   */
  transport?: Partial<HttpTransportOptions>;

  /**
   * Enable Explorer UI (default: true when NODE_ENV !== 'production')
   */
  enableExplorer?: boolean;

  /**
   * Include filter for operations
   * - undefined: Light preset (read-only auto-exposed, mutations excluded)
   * - string[]: explicit operation IDs to include
   * - '*': include all (including mutations)
   */
  include?: string[] | '*';

  /**
   * Maximum request body size in bytes (default: 1048576 = 1 MiB)
   */
  maxRequestBodySize?: number;

  /**
   * Maximum response size in bytes (default: 1048576 = 1 MiB)
   */
  maxResponseSize?: number;

  /**
   * Default deadline per call in milliseconds (default: 30000)
   */
  deadlineMs?: number;
}

/**
 * One-call form options for mcpFromOpenApi()
 */
export interface McpFromOpenApiOptions {
  /**
   * OpenAPI spec source (file path or URL)
   */
  spec: string;

  /**
   * Base path for MCP endpoints (default: '/mcp')
   */
  basePath?: string;

  /**
   * Include filter for operations
   * - undefined: Light preset (read-only auto-exposed, mutations excluded)
   * - string[]: explicit operation IDs to include
   * - '*': include all (including mutations)
   */
  include?: string[] | '*';

  /**
   * Explicit upstream base URL for calling the described API.
   *
   * Overrides the spec's `servers` array. Supply this when the spec declares no
   * absolute server, declares several and you want a specific one, or points at
   * an environment you are not targeting.
   */
  baseUrl?: string;

  /**
   * Enable Explorer UI (default: true when NODE_ENV !== 'production')
   */
  enableExplorer?: boolean;

  /**
   * Dispatcher hooks
   */
  hooks?: DispatcherHooks;
}

/**
 * Request context extracted from Express request
 */
export interface RequestContext {
  /**
   * Authenticated user from req.user (if present)
   */
  user?: {
    id?: string;
    email?: string;
    name?: string;
    roles?: string[];
  };

  /**
   * Request ID for tracing
   */
  requestId: string;
}
