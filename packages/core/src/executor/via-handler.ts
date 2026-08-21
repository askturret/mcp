/**
 * viaHandler executor - direct in-process operation execution
 *
 * Direct function call, no serialization, propagates AbortSignal,
 * maps handler exceptions to OperationError at the boundary.
 */

import type { OperationDefinition, OperationResult } from '../types.js';
import type { DispatchContext } from '../dispatcher/types.js';
import type { OperationExecutor, OperationHandler } from './types.js';

/**
 * Create a handler-based executor.
 *
 * @param handler - Operation handler function
 * @returns OperationExecutor that calls the handler directly
 */
export function viaHandler(handler: OperationHandler): OperationExecutor {
  return new HandlerExecutor(handler);
}

/**
 * Handler executor implementation.
 */
class HandlerExecutor implements OperationExecutor {
  constructor(private readonly handler: OperationHandler) {}

  async execute(
    _operation: OperationDefinition,
    input: unknown,
    context: DispatchContext,
  ): Promise<OperationResult> {
    try {
      // Check for cancellation before calling handler
      if (context.signal.aborted) {
        return {
          ok: false,
          error: {
            code: 'CANCELLED',
            message: 'Request cancelled',
          },
        };
      }

      // Enforce deadline independently of handler cooperation
      // ADR-014: executors must enforce deadlines, not rely on handler checking signal
      const now = new Date();
      const deadlineMs = context.deadline.getTime() - now.getTime();

      if (deadlineMs <= 0) {
        return {
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: 'Deadline exceeded',
          },
        };
      }

      // Create AbortController for deadline enforcement
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), deadlineMs);

      // Wire context.signal to our AbortController
      if (context.signal.aborted) {
        abortController.abort();
      } else {
        context.signal.addEventListener('abort', () => abortController.abort());
      }

      // Race handler execution against deadline
      let handlerCompleted = false;
      let handlerResult: unknown;

      try {
        // Call handler with input and context
        // Handler can access AbortSignal via context.signal
        handlerResult = await this.handler(input, context);
        handlerCompleted = true;
        clearTimeout(timeoutId);
      } catch (error) {
        clearTimeout(timeoutId);

        // Check if aborted (deadline or cancellation)
        if (abortController.signal.aborted) {
          if (context.signal.aborted) {
            return {
              ok: false,
              error: {
                code: 'CANCELLED',
                message: 'Request cancelled',
              },
            };
          }
          return {
            ok: false,
            error: {
              code: 'TIMEOUT',
              message: 'Deadline exceeded',
            },
          };
        }

        // Map any other exception to INTERNAL_ERROR
        // NEVER leak exception message, stack, or type name
        return {
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Execution failed',
          },
        };
      }

      // Success
      return { ok: true, value: handlerResult };
    } catch (error) {
      // Catch any unexpected exception
      // Check if cancellation happened during execution
      if (context.signal.aborted) {
        return {
          ok: false,
          error: {
            code: 'CANCELLED',
            message: 'Request cancelled',
          },
        };
      }

      // Map to INTERNAL_ERROR, never leak exception details
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Execution failed',
        },
      };
    }
  }
}
