/**
 * Tests for fromDefinitions() source
 */

import { fromDefinitions } from '../from-definitions.js';
import type { DiscoveryContext, DiscoveredOperation } from '../types.js';
import type { DefinitionInput } from '../from-definitions.js';

/**
 * Create a minimal discovery context for testing
 */
function createTestContext(signal?: AbortSignal): DiscoveryContext {
  return {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    abortSignal: signal ?? new AbortController().signal,
  };
}

/**
 * Create a minimal test definition
 */
function createTestDefinition(id: string, location?: string): DefinitionInput {
  return {
    id,
    name: `op-${id}`,
    description: `Operation ${id}`,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'handler' },
    location,
  };
}

/**
 * Test: fromDefinitions([a, b, c]) returns exactly those 3 with correct provenance
 */
export async function testFromDefinitionsReturnsAllOperations(): Promise<void> {
  const definitions: DefinitionInput[] = [
    createTestDefinition('a'),
    createTestDefinition('b'),
    createTestDefinition('c'),
  ];

  const source = fromDefinitions(definitions);
  const context = createTestContext();
  const discovered = await source.discover(context);

  // Should return exactly 3 operations
  if (discovered.length !== 3) {
    throw new Error(`Expected 3 operations, got ${discovered.length}`);
  }

  // Should preserve IDs
  const ids = discovered.map((op) => op.candidateId);
  if (!ids.includes('a') || !ids.includes('b') || !ids.includes('c')) {
    throw new Error(`Expected IDs [a, b, c], got [${ids.join(', ')}]`);
  }

  // Should have correct provenance
  for (const op of discovered) {
    if (op.source.kind !== 'code') {
      throw new Error(`Expected source kind 'code', got '${op.source.kind}'`);
    }
  }

  console.log('✓ fromDefinitions returns all operations with correct provenance');
}

/**
 * Test: Individual definition locations override default
 */
export async function testDefinitionLocationOverride(): Promise<void> {
  const definitions: DefinitionInput[] = [
    createTestDefinition('op1', 'file1.ts:10'),
    createTestDefinition('op2'), // No location, will use default
  ];

  const source = fromDefinitions(definitions, {
    defaultLocation: 'default.ts',
  });

  const context = createTestContext();
  const discovered = await source.discover(context);

  const op1 = discovered.find((op) => op.candidateId === 'op1');
  const op2 = discovered.find((op) => op.candidateId === 'op2');

  if (!op1 || !op2) {
    throw new Error('Operations not found');
  }

  if (op1.source.location !== 'file1.ts:10') {
    throw new Error(`Expected op1 location 'file1.ts:10', got '${op1.source.location}'`);
  }

  if (op2.source.location !== 'default.ts') {
    throw new Error(`Expected op2 location 'default.ts', got '${op2.source.location}'`);
  }

  console.log('✓ Individual definition locations override default');
}

/**
 * Test: fromDefinitions preserves all fields
 */
export async function testFromDefinitionsPreservesFields(): Promise<void> {
  const definition: DefinitionInput = {
    id: 'test-op',
    name: 'testOp',
    description: 'Test operation',
    input: { type: 'object', properties: { x: { type: 'number' } } },
    output: { type: 'object', properties: { y: { type: 'string' } } },
    effects: {
      readOnly: false,
      idempotent: true,
      retryable: false,
      idempotencyKeyRequired: true,
      classifications: ['financial'],
    },
    executor: { type: 'http', config: { url: 'https://api.example.com' } },
    annotations: { custom: 'metadata' },
    provenance: [{ field: 'description', kind: 'code', location: 'doc.ts' }],
  };

  const source = fromDefinitions([definition]);
  const context = createTestContext();
  const discovered = await source.discover(context);

  if (discovered.length !== 1) {
    throw new Error(`Expected 1 operation, got ${discovered.length}`);
  }

  const op = discovered[0];

  // Verify all fields preserved
  if (op.candidateId !== 'test-op') throw new Error('ID not preserved');
  if (op.name !== 'testOp') throw new Error('Name not preserved');
  if (!op.rawInput || !op.rawInput.properties) throw new Error('Input not preserved');
  if (!op.rawOutput || !op.rawOutput.properties) throw new Error('Output not preserved');
  if (!op.effects || !op.effects.idempotent) throw new Error('Effects not preserved');
  if (!op.executor || op.executor.type !== 'http') throw new Error('Executor not preserved');
  if (!op.annotations || op.annotations.custom !== 'metadata') {
    throw new Error('Annotations not preserved');
  }
  if (!op.provenance || op.provenance.length !== 1) {
    throw new Error('Provenance not preserved');
  }

  console.log('✓ fromDefinitions preserves all fields');
}

/**
 * Test: fromDefinitions with custom source ID
 */
export async function testFromDefinitionsCustomSourceId(): Promise<void> {
  const definitions = [createTestDefinition('op1')];
  const source = fromDefinitions(definitions, { sourceId: 'custom-source' });

  if (source.id !== 'custom-source') {
    throw new Error(`Expected source ID 'custom-source', got '${source.id}'`);
  }

  console.log('✓ fromDefinitions accepts custom source ID');
}

/**
 * Run all fromDefinitions tests
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      await testFromDefinitionsReturnsAllOperations();
      await testDefinitionLocationOverride();
      await testFromDefinitionsPreservesFields();
      await testFromDefinitionsCustomSourceId();
      console.log('\n✅ All fromDefinitions tests passed');
    } catch (error) {
      console.error('\n❌ fromDefinitions test failed:', error);
      process.exit(1);
    }
  })();
}
