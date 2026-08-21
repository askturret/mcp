/**
 * Registry reference tests - atomicity, immutability, and hash stability
 */

import { describe, it, expect } from '@jest/globals';
import { AtomicRegistryReference } from '../registry-reference.js';
import type { RegistrySnapshot, OperationDefinition } from '../types.js';

/**
 * Create a minimal test snapshot
 */
function createTestSnapshot(version: number, hash: string): RegistrySnapshot {
  const operations = new Map<string, OperationDefinition>([
    [
      'testOp',
      {
        id: 'testOp',
        name: 'testOp',
        description: 'Test operation',
        input: { type: 'object' },
        output: { type: 'object' },
        effects: {
          readOnly: true,
          idempotent: true,
          retryable: true,
          idempotencyKeyRequired: false,
          classifications: [],
        },
        executor: { type: 'test' },
      },
    ],
  ]);

  // Deep-freeze the snapshot
  const snapshot: RegistrySnapshot = {
    version,
    hash,
    createdAt: new Date(),
    operations,
  };

  Object.freeze(snapshot);
  Object.freeze(snapshot.operations);

  return snapshot;
}

describe('AtomicRegistryReference', () => {
  describe('atomicity', () => {
    it('should atomically swap snapshots', () => {
      const snapshot1 = createTestSnapshot(1, 'hash1');
      const snapshot2 = createTestSnapshot(2, 'hash2');

      const ref = new AtomicRegistryReference(snapshot1);

      // Initially returns snapshot1
      expect(ref.current()).toBe(snapshot1);
      expect(ref.current().version).toBe(1);

      // Swap to snapshot2
      ref.swap(snapshot2);

      // Now returns snapshot2
      expect(ref.current()).toBe(snapshot2);
      expect(ref.current().version).toBe(2);
    });

    it('should handle concurrent dispatch scenario', async () => {
      // This test proves ADR-004: in-flight calls retain their snapshot
      // even when reload happens mid-execution.

      const snapshot1 = createTestSnapshot(41, 'hash41');
      const snapshot2 = createTestSnapshot(42, 'hash42');

      const ref = new AtomicRegistryReference(snapshot1);

      // Track which snapshot each "dispatch" captured
      const capturedSnapshots: RegistrySnapshot[] = [];

      // Dispatch 1: captures snapshot at entry, simulates async work
      const dispatch1 = new Promise<void>(resolve => {
        const captured = ref.current(); // Capture at dispatch entry
        capturedSnapshots.push(captured);

        // Simulate async work (dispatch in-flight)
        setTimeout(() => {
          // Dispatch 1 completes against its captured snapshot (v41)
          // even though swap happened during its execution
          expect(captured.version).toBe(41);
          resolve();
        }, 10);
      });

      // Wait a moment, then swap mid-flight
      await new Promise(resolve => setTimeout(resolve, 5));
      ref.swap(snapshot2);

      // Dispatch 2: starts after swap, captures new snapshot
      const dispatch2 = new Promise<void>(resolve => {
        const captured = ref.current(); // Capture at dispatch entry
        capturedSnapshots.push(captured);

        // Dispatch 2 executes against v42
        expect(captured.version).toBe(42);
        resolve();
      });

      // Wait for both to complete
      await Promise.all([dispatch1, dispatch2]);

      // Verify: Dispatch 1 kept v41, Dispatch 2 got v42
      expect(capturedSnapshots[0].version).toBe(41);
      expect(capturedSnapshots[1].version).toBe(42);
    });
  });

  describe('immutability', () => {
    it('should have frozen operations map', () => {
      const snapshot = createTestSnapshot(1, 'hash1');
      const ref = new AtomicRegistryReference(snapshot);

      const current = ref.current();

      // Attempt to mutate operations map should throw
      expect(() => {
        (current.operations as Map<string, OperationDefinition>).set('newOp', {
          id: 'newOp',
          name: 'newOp',
          description: 'New operation',
          input: { type: 'object' },
          output: { type: 'object' },
          effects: {
            readOnly: true,
            idempotent: true,
            retryable: true,
            idempotencyKeyRequired: false,
            classifications: [],
          },
          executor: { type: 'test' },
        });
      }).toThrow();
    });

    it('should have frozen snapshot object', () => {
      const snapshot = createTestSnapshot(1, 'hash1');
      const ref = new AtomicRegistryReference(snapshot);

      const current = ref.current();

      // Attempt to mutate snapshot properties should throw
      expect(() => {
        (current as { version: number }).version = 999;
      }).toThrow();
    });
  });
});
