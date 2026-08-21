/**
 * Command dispatcher tests - envelope order, snapshot capture, error mapping
 */

import { describe, it, expect } from '@jest/globals';
import { createDispatcher } from '../index.js';
import { AtomicRegistryReference } from '../../registry-reference.js';
import type { OperationDefinition, RegistrySnapshot } from '../../types.js';
import type { DispatcherHooks } from '../types.js';
import { freezeMap } from '../../compiler/passes/freeze-and-hash.js';

/**
 * Create a stub executor that echoes input (for testing envelope stages)
 */
function createStubExecutor() {
  return {
    execute: async (
      _operation: OperationDefinition,
      input: unknown,
      _context: any,
    ) => {
      return {
        ok: true as const,
        value: input,
      };
    },
  };
}

/**
 * Create a minimal test snapshot
 */
function createTestSnapshot(version: number, hash: string) {
  const operations = new Map<string, OperationDefinition>([
    [
      'listPets',
      {
        id: 'listPets',
        name: 'listPets',
        description: 'List all pets',
        input: { type: 'object' },
        output: { type: 'object' },
        effects: {
          readOnly: true,
          idempotent: true,
          retryable: true,
          idempotencyKeyRequired: false,
          classifications: [],
        },
        executor: { type: 'stub' },
      },
    ],
  ]);

  const immutableOperations = freezeMap(operations);

  const snapshot: RegistrySnapshot = {
    version,
    hash,
    createdAt: new Date(),
    operations: immutableOperations,
  };

  Object.freeze(snapshot);

  return snapshot;
}

/**
 * Create a minimal test command
 */
function createTestCommand(overrides?: Record<string, unknown>) {
  const abortController = new AbortController();

  return {
    requestId: 'test-request-1',
    operationId: 'listPets',
    input: { limit: 10 },
    deadline: new Date(Date.now() + 30000),
    signal: abortController.signal,
    registryHash: 'test-hash',
    ...overrides,
  };
}

describe('CommandDispatcher', () => {
  describe('12-stage execution envelope', () => {
    it('should execute all 12 stages in order (happy path)', async () => {
      // Track stage execution order
      const executionOrder: string[] = [];

      const hooks: DispatcherHooks = {
        authenticate: async () => {
          executionOrder.push('2-authenticate');
          return undefined;
        },
        authorize: async () => {
          executionOrder.push('3-authorize');
          return { continue: true };
        },
        verifyConfirmation: async () => {
          executionOrder.push('5-verify-confirmation');
          return { continue: true };
        },
        redact: (value) => {
          executionOrder.push('10-redact');
          return value;
        },
        audit: async () => {
          executionOrder.push('11-audit');
        },
      };

      const snapshot = createTestSnapshot(1, 'hash1');
      const registry = new AtomicRegistryReference(snapshot);

      // Register stub executor
      const executors = new Map();
      executors.set('stub', createStubExecutor());
      const dispatcher = createDispatcher(registry, hooks, executors);

      const command = createTestCommand();
      const result = await dispatcher.dispatch(command);

      // Verify successful execution
      expect(result.isError).toBe(false);
      expect(result.content).toEqual({ limit: 10 });

      // Verify all hook stages executed in order
      // Stages 1, 4, 6, 7, 8, 9, 12 are internal (not hook-visible)
      expect(executionOrder).toEqual([
        '2-authenticate',
        '3-authorize',
        '5-verify-confirmation',
        '10-redact',
        '11-audit',
      ]);
    });

    it('should validate input (stage 4)', async () => {
      const snapshot = createTestSnapshot(1, 'hash1');
      const registry = new AtomicRegistryReference(snapshot);
      const dispatcher = createDispatcher(registry);

      const command = createTestCommand({ input: null as unknown as object });
      const result = await dispatcher.dispatch(command);

      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toBe('Input is required');
    });

    it('should validate output (stage 9)', async () => {
      // v0.1: stub executor echoes input, so we verify the validateOutput stage
      // by confirming output passes through when valid
      const snapshot = createTestSnapshot(1, 'hash1');
      const registry = new AtomicRegistryReference(snapshot);

      // Register stub executor
      const executors = new Map();
      executors.set('stub', createStubExecutor());
      const dispatcher = createDispatcher(registry, {}, executors);

      const command = createTestCommand({ input: { valid: true } });
      const result = await dispatcher.dispatch(command);

      // Output validation passed (stub returns input, which is valid)
      expect(result.isError).toBe(false);
      expect(result.content).toEqual({ valid: true });
    });

    it('should handle authorization short-circuit (stage 3)', async () => {
      const hooks: DispatcherHooks = {
        authorize: async () => ({
          shortCircuit: true,
          result: {
            ok: false,
            error: {
              code: 'FORBIDDEN',
              message: 'Insufficient permissions',
            },
          },
        }),
      };

      const snapshot = createTestSnapshot(1, 'hash1');
      const registry = new AtomicRegistryReference(snapshot);
      const dispatcher = createDispatcher(registry, hooks);

      const command = createTestCommand();
      const result = await dispatcher.dispatch(command);

      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe('FORBIDDEN');
    });
  });

  describe('snapshot capture invariant', () => {
    it('should capture snapshot at dispatch entry and never re-read', async () => {
      const snapshot1 = createTestSnapshot(1, 'hash1');
      const snapshot2 = createTestSnapshot(2, 'hash2');

      const registry = new AtomicRegistryReference(snapshot1);

      // Track which snapshot hash was used
      let capturedHash: string | undefined;

      const hooks: DispatcherHooks = {
        audit: async (context) => {
          capturedHash = context.registryHash;
        },
      };

      // Register stub executor
      const executors = new Map();
      executors.set('stub', createStubExecutor());
      const dispatcherWithHooks = createDispatcher(registry, hooks, executors);

      // Start dispatch against snapshot1
      const command = createTestCommand();
      const resultPromise = dispatcherWithHooks.dispatch(command);

      // Swap to snapshot2 mid-flight
      await new Promise(resolve => setTimeout(resolve, 1));
      registry.swap(snapshot2);

      // Wait for dispatch to complete
      const result = await resultPromise;

      // Verify dispatch completed against snapshot1 (captured at entry)
      expect(result.isError).toBe(false);
      expect(capturedHash).toBe('hash1');

      // Verify registry is now at snapshot2
      expect(registry.current().hash).toBe('hash2');
    });
  });

  describe('error mapping', () => {
    it('should map operation not found to INVALID_INPUT', async () => {
      const snapshot = createTestSnapshot(1, 'hash1');
      const registry = new AtomicRegistryReference(snapshot);
      const dispatcher = createDispatcher(registry);

      const command = createTestCommand({ operationId: 'nonexistent' });
      const result = await dispatcher.dispatch(command);

      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('not found');
    });

    it('should map internal exceptions to INTERNAL_ERROR without leaking details', async () => {
      // v0.1: Test verifies the error mapping contract
      // Real executor injection deferred, but we verify INTERNAL_ERROR shape

      // Use a hook that throws to simulate internal exception path
      const hooks: DispatcherHooks = {
        audit: async () => {
          throw new Error('Secret internal details should never leak');
        },
      };

      const snapshot = createTestSnapshot(1, 'hash1');
      const registry = new AtomicRegistryReference(snapshot);

      // Register stub executor
      const executors = new Map();
      executors.set('stub', createStubExecutor());
      const dispatcher = createDispatcher(registry, hooks, executors);

      const command = createTestCommand();
      const result = await dispatcher.dispatch(command);

      // Verify internal exception mapped to INTERNAL_ERROR
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe('INTERNAL_ERROR');
      expect(result.error?.message).toBe('An internal error occurred');
      // Verify no internal details leaked
      expect(result.error?.message).not.toContain('Secret');
    });

    it('should preserve error details and retryAfter if present', async () => {
      const hooks: DispatcherHooks = {
        authorize: async () => ({
          shortCircuit: true,
          result: {
            ok: false,
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many requests',
              details: { limit: 100, window: 60 },
              retryAfter: 30,
            },
          },
        }),
      };

      const snapshot = createTestSnapshot(1, 'hash1');
      const registry = new AtomicRegistryReference(snapshot);
      const dispatcher = createDispatcher(registry, hooks);

      const command = createTestCommand();
      const result = await dispatcher.dispatch(command);

      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe('RATE_LIMITED');
      expect(result.error?.details).toEqual({ limit: 100, window: 60 });
      expect(result.error?.retryAfter).toBe(30);
    });
  });

  describe('envelope immutability', () => {
    it('should run hooks in the documented pipeline order', async () => {
      // The 12-stage pipeline is sealed and its order is part of the contract:
      // resolve → authenticate → authorize → validate input → verify
      // confirmation → bulkhead → deadline → execute → validate output →
      // redact → audit → map to MCP result.
      //
      // This assertion used to be `expect(true).toBe(true)` with the order
      // written out in comments — it asserted nothing and would not have
      // noticed a reordering. The hooks are the observable stages, so record
      // the order they actually run in and compare it against the contract.
      const calls: string[] = [];

      const snapshot = createTestSnapshot(1, 'hash1');
      const registry = new AtomicRegistryReference(snapshot);

      // A working executor, so the happy path reaches the post-execute stages.
      // Without one, execution fails and redact/audit never run.
      const executors = new Map([
        [
          'stub',
          {
            execute: async () => {
              calls.push('execute');
              return { ok: true as const, value: { pets: [] } };
            },
          },
        ],
      ]);

      const dispatcher = createDispatcher(
        registry,
        {
          authenticate: async () => {
            calls.push('authenticate');
            return undefined;
          },
          authorize: async () => {
            calls.push('authorize');
            return { continue: true as const };
          },
          verifyConfirmation: async () => {
            calls.push('verifyConfirmation');
            return { continue: true as const };
          },
          redact: <T>(value: T): T => {
            calls.push('redact');
            return value;
          },
          audit: async () => {
            calls.push('audit');
          },
        },
        executors,
      );

      const result = await dispatcher.dispatch(createTestCommand());

      expect(result.isError).toBeFalsy();
      expect(calls).toEqual([
        'authenticate',
        'authorize',
        'verifyConfirmation',
        'execute',
        'redact',
        'audit',
      ]);
    });
  });

  describe('executor invocation (regression test for #83)', () => {
    it('should invoke the bound executor and return its real output (not echo)', async () => {
      // Regression test: proves dispatcher actually calls operation.executor
      // instead of echoing input. This is the exact class of test that was
      // missing and let the stub ship in #13.

      // Create a mock executor that returns a DIFFERENT value than input
      const mockExecutor = {
        execute: async (
          _operation: OperationDefinition,
          input: unknown,
          _context: any,
        ) => {
          // Transform the input to prove we're not echoing
          return {
            ok: true as const,
            value: {
              transformed: true,
              originalInput: input,
              executorInvoked: true,
            },
          };
        },
      };

      // Register the mock executor
      const executors = new Map();
      executors.set('handler', mockExecutor);

      // Create operation that binds to our executor
      const operations = new Map<string, OperationDefinition>([
        [
          'transform',
          {
            id: 'transform',
            name: 'transform',
            description: 'Test operation',
            input: { type: 'object' },
            output: { type: 'object' },
            effects: {
              readOnly: false,
              idempotent: false,
              retryable: false,
              idempotencyKeyRequired: false,
              classifications: [],
            },
            executor: { type: 'handler' }, // Binds to our mock
          },
        ],
      ]);

      const snapshot: RegistrySnapshot = {
        version: 1,
        hash: 'test-hash',
        createdAt: new Date(),
        operations: freezeMap(operations),
      };

      const registry = new AtomicRegistryReference(snapshot);
      const dispatcher = createDispatcher(registry, {}, executors);

      const command = createTestCommand({
        operationId: 'transform',
        input: { value: 42 },
      });

      const result = await dispatcher.dispatch(command);

      // Verify the executor was actually invoked
      expect(result.isError).toBe(false);
      if (!result.isError) {
        // The output should be the TRANSFORMED value, not an echo of input
        expect(result.content).toEqual({
          transformed: true,
          originalInput: { value: 42 },
          executorInvoked: true,
        });
        // Explicitly verify this is NOT an echo
        expect(result.content).not.toEqual({ value: 42 });
      }
    });

    it('should return error when no executor is registered for operation type', async () => {
      // Test error handling when executor type is not registered

      const operations = new Map<string, OperationDefinition>([
        [
          'unbound',
          {
            id: 'unbound',
            name: 'unbound',
            description: 'Operation with unregistered executor',
            input: { type: 'object' },
            output: { type: 'object' },
            effects: {
              readOnly: false,
              idempotent: false,
              retryable: false,
              idempotencyKeyRequired: false,
              classifications: [],
            },
            executor: { type: 'nonexistent' }, // No executor registered
          },
        ],
      ]);

      const snapshot: RegistrySnapshot = {
        version: 1,
        hash: 'test-hash',
        createdAt: new Date(),
        operations: freezeMap(operations),
      };

      const registry = new AtomicRegistryReference(snapshot);
      const dispatcher = createDispatcher(registry, {}, new Map()); // Empty executors

      const command = createTestCommand({ operationId: 'unbound' });
      const result = await dispatcher.dispatch(command);

      // Should return INTERNAL_ERROR when executor not found
      expect(result.isError).toBe(true);
      if (result.isError) {
        expect(result.error?.code).toBe('INTERNAL_ERROR');
        expect(result.error?.message).toContain('No executor registered');
      }
    });
  });
});
