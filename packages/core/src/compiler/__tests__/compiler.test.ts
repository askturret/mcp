/**
 * Compiler tests - determinism, pass order, and fixture compilation
 */

import { describe, it, expect } from '@jest/globals';
import { createCompiler } from '../index.js';
import type { DiscoveredOperation } from '../../sources/types.js';
import type { Logger } from '../../sources/types.js';

/**
 * Create a minimal logger for testing
 */
function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * Simple Petstore fixture
 */
function createPetstoreFixture(): DiscoveredOperation[] {
  return [
    {
      candidateId: 'listPets',
      name: 'listPets',
      description: 'List all pets',
      rawInput: {
        type: 'object',
        properties: {
          limit: { type: 'integer', maximum: 100 },
        },
      },
      rawOutput: {
        type: 'object',
        properties: {
          pets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
              },
            },
          },
        },
      },
      source: {
        kind: 'openapi',
        location: 'petstore.yaml#/paths//pets/get',
      },
      effects: {
        readOnly: true,
        idempotent: true,
        retryable: true,
        idempotencyKeyRequired: false,
        classifications: [],
      },
    },
    {
      candidateId: 'createPet',
      name: 'createPet',
      description: 'Create a new pet',
      rawInput: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      },
      rawOutput: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
        },
      },
      source: {
        kind: 'openapi',
        location: 'petstore.yaml#/paths//pets/post',
      },
      effects: {
        readOnly: false,
        idempotent: false,
        retryable: false,
        idempotencyKeyRequired: true,
        classifications: [],
      },
    },
  ];
}

describe('Compiler', () => {
  describe('determinism', () => {
    it('should produce identical hash across multiple runs', async () => {
      const compiler = createCompiler(1);
      const discovered = createPetstoreFixture();
      const context = {
        logger: createTestLogger(),
        overlays: [],
        preset: 'light' as const,
      };

      // Compile 10 times
      const snapshots = await Promise.all(
        Array.from({ length: 10 }, () => compiler.compile(discovered, context)),
      );

      // All hashes should be identical
      const hashes = snapshots.map(s => s.hash);
      const uniqueHashes = new Set(hashes);

      expect(uniqueHashes.size).toBe(1);
    });

    it('should produce stable hash for same input (determinism test)', async () => {
      const compiler = createCompiler(1);
      const discovered = createPetstoreFixture();
      const context = {
        logger: createTestLogger(),
        overlays: [],
        preset: 'light' as const,
      };

      const snapshot1 = await compiler.compile(discovered, context);
      const snapshot2 = await compiler.compile(discovered, context);

      expect(snapshot1.hash).toBe(snapshot2.hash);
      expect(snapshot1.hash).toBeTruthy();
      expect(snapshot1.hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });
  });

  describe('compilation', () => {
    it('should compile Petstore fixture successfully', async () => {
      const compiler = createCompiler(1);
      const discovered = createPetstoreFixture();
      const context = {
        logger: createTestLogger(),
        overlays: [],
        preset: 'light' as const,
      };

      const snapshot = await compiler.compile(discovered, context);

      expect(snapshot.version).toBe(1);
      expect(snapshot.hash).toBeTruthy();
      expect(snapshot.createdAt).toBeInstanceOf(Date);
      expect(snapshot.operations.size).toBe(2);

      // Check listPets operation
      const listPets = snapshot.operations.get('listPets');
      expect(listPets).toBeDefined();
      expect(listPets?.name).toBe('listPets');
      expect(listPets?.description).toBe('List all pets');
      expect(listPets?.effects.readOnly).toBe(true);
      expect(listPets?.effects.idempotent).toBe(true);
      expect(listPets?.effects.retryable).toBe(true);
      expect(listPets?.executor).toBeDefined();
      expect(listPets?.input).toBeDefined();
      expect(listPets?.output).toBeDefined();

      // Check createPet operation
      const createPet = snapshot.operations.get('createPet');
      expect(createPet).toBeDefined();
      expect(createPet?.name).toBe('createPet');
      expect(createPet?.description).toBe('Create a new pet');
      expect(createPet?.effects.readOnly).toBe(false);
      expect(createPet?.effects.idempotencyKeyRequired).toBe(true);
    });

    it('should handle duplicate operation IDs deterministically', async () => {
      const compiler = createCompiler(1);
      const discovered: DiscoveredOperation[] = [
        {
          candidateId: 'getPet',
          name: 'getPet',
          description: 'From OpenAPI',
          source: { kind: 'openapi' },
          effects: {
            readOnly: true,
            idempotent: true,
            retryable: true,
            idempotencyKeyRequired: false,
            classifications: [],
          },
        },
        {
          candidateId: 'getPet',
          name: 'getPet',
          description: 'From code',
          source: { kind: 'code' },
          effects: {
            readOnly: true,
            idempotent: true,
            retryable: true,
            idempotencyKeyRequired: false,
            classifications: [],
          },
        },
      ];

      const context = {
        logger: createTestLogger(),
        overlays: [],
        preset: 'light' as const,
      };

      const snapshot = await compiler.compile(discovered, context);

      // Should have only one operation (code wins over openapi)
      expect(snapshot.operations.size).toBe(1);
      const op = snapshot.operations.get('getPet');
      expect(op?.description).toBe('From code'); // Code has higher precedence
    });

    it('should validate required fields and drop invalid operations', async () => {
      const compiler = createCompiler(1);
      const discovered: DiscoveredOperation[] = [
        {
          candidateId: 'valid',
          name: 'validOp',
          description: 'Valid operation',
          source: { kind: 'openapi' },
          rawInput: { type: 'object' },
          rawOutput: { type: 'object' },
          effects: {
            readOnly: true,
            idempotent: true,
            retryable: true,
            idempotencyKeyRequired: false,
            classifications: [],
          },
        },
        {
          candidateId: 'invalid',
          name: '', // Missing name
          description: 'Invalid operation',
          source: { kind: 'openapi' },
        },
      ];

      const context = {
        logger: createTestLogger(),
        overlays: [],
        preset: 'light' as const,
      };

      const snapshot = await compiler.compile(discovered, context);

      // Only valid operation should be included
      expect(snapshot.operations.size).toBe(1);
      expect(snapshot.operations.has('valid')).toBe(true);
      expect(snapshot.operations.has('invalid')).toBe(false);
    });
  });

  describe('immutability', () => {
    it('should deep-freeze the snapshot', async () => {
      const compiler = createCompiler(1);
      const discovered = createPetstoreFixture();
      const context = {
        logger: createTestLogger(),
        overlays: [],
        preset: 'light' as const,
      };

      const snapshot = await compiler.compile(discovered, context);

      // Attempt to mutate should throw in strict mode or no-op in non-strict
      expect(() => {
        (snapshot as { version: number }).version = 999;
      }).toThrow();
    });
  });

  describe('pass ordering', () => {
    it('should be order-sensitive (permutation MUST fail)', async () => {
      // This test proves pass order is intentional, not accidental.
      // Swapping critical passes (resolve-identity assigns canonical IDs,
      // validate-invariants checks those IDs exist) must produce different
      // results — otherwise order-sensitivity would be meaningless.

      const discovered = createPetstoreFixture();
      const context = {
        logger: createTestLogger(),
        overlays: [],
        preset: 'light' as const,
      };

      // Import passes directly to test permutation
      const { COMPILER_PASSES } = await import('../index.js');
      const { validateInvariants } = await import('../passes/validate-invariants.js');

      // Find the indices of these two passes in the correct order
      const resolveIdx = COMPILER_PASSES.findIndex(p => p.name === 'resolve-identity');
      const validateIdx = COMPILER_PASSES.findIndex(p => p.name === 'validate-invariants');

      expect(resolveIdx).toBeGreaterThanOrEqual(0);
      expect(validateIdx).toBeGreaterThanOrEqual(0);
      expect(resolveIdx).toBeLessThan(validateIdx); // Correct order: resolve before validate

      // Test 1: Correct order produces valid operations
      const compiler = createCompiler(1);
      const snapshot = await compiler.compile(discovered, context);
      expect(snapshot.operations.size).toBe(2);

      // Test 2: Swapped order produces different result (order-sensitivity proof)
      // Run just the two passes in SWAPPED order to show the dependency
      const warnings = {
        warnings: [] as unknown[],
        warn(w: unknown) { this.warnings.push(w); },
        getWarnings() { return this.warnings; },
      };
      const testContext = { ...context, warnings };

      // Convert discovered to intermediate form (explicit typing to satisfy exactOptionalPropertyTypes)
      type IntermediateOp = {
        candidateId?: string;
        name: string;
        description: string;
        source?: { kind: string; location?: string };
        effects?: { readOnly: boolean; idempotent: boolean; retryable: boolean; idempotencyKeyRequired: boolean; classifications: readonly string[] };
      };

      let operations: readonly IntermediateOp[] = discovered.map(op => ({
        candidateId: op.candidateId,
        name: op.name,
        description: op.description,
        ...(op.source && { source: op.source }),
        ...(op.effects && { effects: op.effects }),
      }));

      // Run validate-invariants BEFORE resolve-identity (wrong order)
      // validate-invariants checks for op.id, which resolve-identity assigns
      operations = await validateInvariants.run(operations, testContext);

      // Swapped order: validate runs first, sees no IDs, drops all operations
      expect(operations.length).toBe(0); // All dropped vs. 2 in correct order

      // This proves order-sensitivity is real and intentional, not accidental
    });
  });
});
