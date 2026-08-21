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
});
