/**
 * AskTurret MCP - OpenAPI Source Adapter
 *
 * Imports OpenAPI 3.0/3.1 specifications and converts them into canonical OperationDefinitions.
 */

import type { OperationDefinition } from '@askturret/mcp-core';

/**
 * Import operations from an OpenAPI specification
 *
 * @param spec - OpenAPI specification (URL, file path, or parsed object)
 * @returns Array of canonical OperationDefinitions
 */
export function fromOpenApi(spec: unknown): OperationDefinition[] {
  // Stub implementation for v0.1
  // Full implementation will be in a later issue
  if (typeof spec !== 'object' || spec === null) {
    throw new Error('Invalid OpenAPI specification');
  }

  return [];
}

/**
 * Re-export utilities (to be implemented)
 */
export * from './types.js';
