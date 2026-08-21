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

      // Call handler with input and context
      // Handler can access AbortSignal via context.signal
      const result = await this.handler(input, context);

      // Success
      return { ok: true, value: result };
    } catch (error) {
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
  }
}
