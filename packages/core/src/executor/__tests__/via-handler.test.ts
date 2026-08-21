/**
 * viaHandler executor tests
 */

import { describe, it, expect } from '@jest/globals';
import { viaHandler } from '../via-handler.js';
import type { OperationDefinition } from '../../types.js';
import type { DispatchContext } from '../../dispatcher/types.js';

/**
 * Create a minimal test operation definition
 */
function createTestOperation(overrides?: Partial<OperationDefinition>): OperationDefinition {
  return {
    id: 'testOp',
    name: 'testOp',
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
    executor: { type: 'handler' },
    ...overrides,
  };
}

/**
 * Create a minimal test context
 */
function createTestContext(overrides?: Partial<DispatchContext>): DispatchContext {
  const abortController = new AbortController();

  return {
    requestId: 'test-request-1',
    operationId: 'testOp',
    registryHash: 'test-hash',
    deadline: new Date(Date.now() + 30000),
    signal: abortController.signal,
    ...overrides,
  };
}

describe('viaHandler', () => {
  describe('round-trip execution', () => {
    it('should execute handler and return result', async () => {
      const handler = async (input: unknown) => {
        return { echoed: input, processed: true };
      };

      const executor = viaHandler(handler);
      const operation = createTestOperation();
      const context = createTestContext();
      const input = { value: 42 };

      const result = await executor.execute(operation, input, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ echoed: input, processed: true });
      }
    });

    it('should pass context to handler', async () => {
      let receivedContext: DispatchContext | undefined;

      const handler = async (_input: unknown, ctx: DispatchContext) => {
        receivedContext = ctx;
        return { ok: true };
      };

      const executor = viaHandler(handler);
      const operation = createTestOperation();
      const context = createTestContext({ requestId: 'specific-request-123' });

      await executor.execute(operation, {}, context);

      expect(receivedContext).toBeDefined();
      expect(receivedContext?.requestId).toBe('specific-request-123');
    });
  });

  describe('cancellation', () => {
    it('should return CANCELLED if signal is aborted before execution', async () => {
      const handler = async (input: unknown) => {
        return { echoed: input };
      };

      const executor = viaHandler(handler);
      const operation = createTestOperation();
      const abortController = new AbortController();
      abortController.abort();
      const context = createTestContext({ signal: abortController.signal });

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('CANCELLED');
      }
    });

    it('should return CANCELLED if signal is aborted during execution', async () => {
      const abortController = new AbortController();

      const handler = async (_input: unknown, ctx: DispatchContext) => {
        // Simulate async work
        await new Promise(resolve => setTimeout(resolve, 10));

        // Check signal during execution
        if (ctx.signal.aborted) {
          throw new Error('Aborted');
        }

        return { ok: true };
      };

      const executor = viaHandler(handler);
      const operation = createTestOperation();
      const context = createTestContext({ signal: abortController.signal });

      // Abort mid-execution
      setTimeout(() => abortController.abort(), 5);

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('CANCELLED');
      }
    });
  });

  describe('exception mapping', () => {
    it('should map handler exceptions to INTERNAL_ERROR', async () => {
      const handler = async () => {
        throw new Error('Secret internal details should never leak');
      };

      const executor = viaHandler(handler);
      const operation = createTestOperation();
      const context = createTestContext();

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INTERNAL_ERROR');
        expect(result.error.message).toBe('Execution failed');
        // Verify no internal details leaked
        expect(result.error.message).not.toContain('Secret');
      }
    });

    it('should never leak exception type names', async () => {
      class CustomError extends Error {
        constructor() {
          super('Custom error message');
          this.name = 'CustomError';
        }
      }

      const handler = async () => {
        throw new CustomError();
      };

      const executor = viaHandler(handler);
      const operation = createTestOperation();
      const context = createTestContext();

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INTERNAL_ERROR');
        expect(result.error.message).toBe('Execution failed');
        // Verify no type name leaked
        expect(result.error.message).not.toContain('CustomError');
      }
    });
  });

  describe('deadline enforcement', () => {
    it('should honor deadline within tolerance', async () => {
      const handler = async (_input: unknown, ctx: DispatchContext) => {
        // Simulate work that might exceed deadline
        const remainingMs = ctx.deadline.getTime() - Date.now();

        // If deadline is near, handler should check and abort
        if (remainingMs < 100) {
          throw new Error('Deadline approaching');
        }

        return { ok: true };
      };

      const executor = viaHandler(handler);
      const operation = createTestOperation();
      const deadline = new Date(Date.now() + 50); // Very tight deadline
      const context = createTestContext({ deadline });

      const result = await executor.execute(operation, {}, context);

      // Handler should detect tight deadline and fail
      expect(result.ok).toBe(false);
    });

    it('should enforce deadline even when handler ignores signal and deadline', async () => {
      // CRITICAL: This test proves the executor enforces the deadline,
      // not just relying on the handler to voluntarily check signal.
      // A handler that ignores context.deadline/signal must still be cut off.

      let handlerStarted = false;
      let handlerCompleted = false;

      const handler = async (_input: unknown, _ctx: DispatchContext) => {
        handlerStarted = true;

        // Deliberately ignore context.signal and context.deadline
        // Sleep way past the deadline (300ms vs 50ms deadline)
        await new Promise(resolve => setTimeout(resolve, 300));

        handlerCompleted = true;
        return { ok: true };
      };

      const executor = viaHandler(handler);
      const operation = createTestOperation();
      const deadline = new Date(Date.now() + 50); // 50ms deadline
      const context = createTestContext({ deadline });

      const startTime = Date.now();
      const result = await executor.execute(operation, {}, context);
      const elapsed = Date.now() - startTime;

      // Executor MUST cut off the handler at the deadline
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TIMEOUT');
        expect(result.error.message).toContain('Deadline exceeded');
      }

      // Verify handler was started
      expect(handlerStarted).toBe(true);

      // CRITICAL: Handler should NOT have completed
      // The executor must cut it off before it finishes sleeping
      expect(handlerCompleted).toBe(false);

      // Verify execution was cut off near the deadline (within tolerance)
      // Should be ~50ms, not 300ms
      expect(elapsed).toBeGreaterThanOrEqual(40); // Some tolerance for scheduling
      expect(elapsed).toBeLessThan(200); // Must not wait for handler to complete
    });

    it('should return TIMEOUT if deadline is already exceeded', async () => {
      const handler = async () => {
        return { ok: true };
      };

      const executor = viaHandler(handler);
      const operation = createTestOperation();
      const deadline = new Date(Date.now() - 1000); // Already passed
      const context = createTestContext({ deadline });

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TIMEOUT');
      }
    });
  });
});
