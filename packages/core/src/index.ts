// SPDX-License-Identifier: Apache-2.0
/**
 * AskTurret MCP - Core Runtime
 *
 * Canonical model, compiler, registry, policies, and execution lifecycle.
 */

/**
 * Placeholder for createMcpServer - the main entry point for the Light API
 */
export function createMcpServer(_options?: unknown): unknown {
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
 * Re-export all core types and utilities
 */
export * from './types.js';
export * from './sources/index.js';
export * from './compiler/index.js';
export type { CompilerContext, CompilerPass, CompilerWarning } from './compiler/types.js';
export { omitUndefined } from './utils.js';
export { AtomicRegistryReference, type RegistryReference } from './registry-reference.js';
export { createDispatcher, type CommandDispatcher, type DispatcherHooks, type DispatchContext, type MCPResult } from './dispatcher/index.js';
export { viaHandler, viaHttp, type OperationExecutor, type OperationHandler, type HttpExecutorOptions, type HttpClient } from './executor/index.js';
