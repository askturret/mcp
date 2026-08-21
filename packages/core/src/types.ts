/**
 * Core type definitions for AskTurret MCP
 *
 * Canonical OperationDefinition, OperationCommand, and RegistrySnapshot types.
 */

/**
 * Placeholder for OperationDefinition - the canonical operation model
 */
export interface OperationDefinition {
  id: string;
  name: string;
  description?: string;
  // Full schema to be defined in issue #8
}

/**
 * Placeholder for OperationCommand - execution request
 */
export interface OperationCommand {
  operationId: string;
  parameters?: Record<string, unknown>;
  // Full schema to be defined in issue #8
}

/**
 * Placeholder for RegistrySnapshot - versioned capability surface
 */
export interface RegistrySnapshot {
  version: string;
  operations: OperationDefinition[];
  // Full schema to be defined in issue #8
}
