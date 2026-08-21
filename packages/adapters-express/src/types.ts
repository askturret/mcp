// SPDX-License-Identifier: Apache-2.0
/**
 * Express adapter type definitions
 */

/**
 * Express MCP configuration options
 */
export interface ExpressMcpOptions {
  /**
   * Base path for MCP endpoints
   */
  basePath?: string;

  /**
   * Enable Explorer UI
   */
  enableExplorer?: boolean;

  /**
   * Enable health check endpoints
   */
  enableHealth?: boolean;
}
