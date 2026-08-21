// SPDX-License-Identifier: Apache-2.0
/**
 * Inspect command types
 */

/**
 * Server information from MCP handshake
 */
export interface ServerInfo {
  /**
   * Server name
   */
  name: string;

  /**
   * Server version
   */
  version: string;

  /**
   * MCP protocol version negotiated
   */
  protocolVersion: string;

  /**
   * Registry hash currently published
   */
  registryHash?: string;
}

/**
 * Tool information from tools/list
 */
export interface ToolInfo {
  /**
   * Tool name/ID
   */
  name: string;

  /**
   * Tool description
   */
  description?: string;

  /**
   * Input schema
   */
  inputSchema?: Record<string, unknown>;

  /**
   * Output schema (if documented)
   */
  outputSchema?: Record<string, unknown>;

  /**
   * Effect flags
   */
  effects?: {
    readOnly?: boolean;
    idempotent?: boolean;
    [key: string]: unknown;
  };

  /**
   * Auth expectations
   */
  auth?: {
    required?: boolean;
    schemes?: string[];
  };

  /**
   * Additional annotations
   */
  annotations?: Record<string, unknown>;
}

/**
 * Latency measurements
 */
export interface LatencyStats {
  /**
   * Ping round-trip time (ms)
   */
  pingMs?: number;

  /**
   * tools/list call time (ms)
   */
  toolsListMs: number;

  /**
   * Total handshake time (ms)
   */
  handshakeMs: number;
}

/**
 * Dry-run result for a single tool
 */
export interface DryRunResult {
  /**
   * Tool that was invoked
   */
  tool: string;

  /**
   * Success status
   */
  success: boolean;

  /**
   * Return value (if successful)
   */
  result?: unknown;

  /**
   * Error message (if failed)
   */
  error?: string;

  /**
   * Execution time (ms)
   */
  executionMs: number;
}

/**
 * Overall inspection result
 */
export interface InspectResult {
  /**
   * Server information
   */
  server: ServerInfo;

  /**
   * Tools available
   */
  tools: ToolInfo[];

  /**
   * Latency measurements
   */
  latency: LatencyStats;

  /**
   * Dry-run result (if requested)
   */
  dryRun?: DryRunResult;

  /**
   * Health status
   */
  healthy: boolean;

  /**
   * Error details (if unhealthy)
   */
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Diff result when comparing against snapshot
 */
export interface DiffResult {
  /**
   * Tools added since snapshot
   */
  added: string[];

  /**
   * Tools removed since snapshot
   */
  removed: string[];

  /**
   * Tools with changed schemas
   */
  modified: Array<{
    tool: string;
    changes: string[];
  }>;

  /**
   * Registry hash changed
   */
  hashChanged: boolean;

  /**
   * Previous hash
   */
  previousHash?: string;

  /**
   * Current hash
   */
  currentHash?: string;
}
