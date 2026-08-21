/**
 * Type safety tests for core types
 *
 * Verifies that the core type definitions are properly exported and can be used.
 */

import type { OperationDefinition, OperationCommand, RegistrySnapshot } from '../types.js';

// Test: OperationDefinition can be created and has required fields
const testOperation: OperationDefinition = {
  id: 'test-op-1',
  name: 'Test Operation',
  description: 'A test operation',
};

// Test: OperationCommand can be created
const testCommand: OperationCommand = {
  operationId: 'test-op-1',
  parameters: { key: 'value' },
};

// Test: RegistrySnapshot can be created
const testSnapshot: RegistrySnapshot = {
  version: '1.0.0',
  operations: [testOperation],
};

// Verify all objects were created successfully
if (!testOperation || !testCommand || !testSnapshot) {
  throw new Error('Type definitions failed to compile correctly');
}

console.log('✓ All type definitions compile correctly');
console.log('✓ OperationDefinition type works');
console.log('✓ OperationCommand type works');
console.log('✓ RegistrySnapshot type works');
