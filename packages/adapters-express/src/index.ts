/**
 * AskTurret MCP - Express Framework Adapter
 *
 * Mounts MCP endpoints on Express applications.
 */

/**
 * Express MCP middleware factory
 *
 * @param options - Configuration options
 * @returns Express middleware/router
 */
export function expressMcp(options?: unknown): unknown {
  // Stub implementation for v0.1
  // Returns a placeholder middleware
  return (req: unknown, res: unknown, next: unknown) => {
    if (typeof next === 'function') {
      next();
    }
  };
}

/**
 * Re-export utilities (to be implemented)
 */
export * from './types.js';
