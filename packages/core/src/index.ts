/**
 * AskTurret MCP - Core Runtime
 *
 * Canonical model, compiler, registry, policies, and execution lifecycle.
 */

/**
 * Placeholder for createMcpServer - the main entry point for the Light API
 */
export function createMcpServer(options?: unknown): unknown {
  // Stub implementation for v0.1
  return {
    start: async () => {
      throw new Error('Not yet implemented');
    },
    stop: async () => {
      throw new Error('Not yet implemented');
    },
  };
}

/**
 * Version information
 */
export const VERSION = '0.1.0';

/**
 * Re-export all core types and utilities (to be implemented)
 */
export * from './types.js';
