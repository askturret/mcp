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
      let timeoutId: NodeJS.Timeout | undefined;

      // Wire context.signal to our AbortController
      if (context.signal.aborted) {
        abortController.abort();
      } else {
        context.signal.addEventListener('abort', () => abortController.abort());
      }

      // Race handler execution against deadline
      // The handler promise itself is NOT cancelled (JS can't cancel in-flight promises)
      // but execute() returns TIMEOUT at the deadline regardless
      const handlerPromise = this.handler(input, context).then(
        (value) => ({ ok: true as const, value }),
        (error) => {
          // Handler threw an exception
          // Check if aborted (deadline or cancellation)
          if (abortController.signal.aborted) {
            if (context.signal.aborted) {
              return {
                ok: false as const,
                error: {
                  code: 'CANCELLED' as const,
                  message: 'Request cancelled',
                },
              };
            }
            return {
              ok: false as const,
              error: {
                code: 'TIMEOUT' as const,
                message: 'Deadline exceeded',
              },
            };
          }

          // Map any other exception to INTERNAL_ERROR
          // NEVER leak exception message, stack, or type name
          return {
            ok: false as const,
            error: {
              code: 'INTERNAL_ERROR' as const,
              message: 'Execution failed',
            },
          };
        },
      );

      const timeoutPromise = new Promise<OperationResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            ok: false,
            error: {
              code: 'TIMEOUT',
              message: 'Deadline exceeded',
            },
          });
        }, deadlineMs);
      });

      // Race the two promises
      const result = await Promise.race([handlerPromise, timeoutPromise]);

      // Clean up timeout
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      return result;
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
