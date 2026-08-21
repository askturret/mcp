/**
 * Command dispatcher with fixed execution envelope
 *
 * ADR-010: 12-stage pipeline, sealed and immutable.
 * Every stage must be present; plugins can extend hooks but not reorder stages.
 *
 * Snapshot capture invariant: snapshot is captured ONCE at dispatch entry
 * and threaded through all stages. Never re-read the registry reference mid-flight.
 */

import type {
  OperationCommand,
  OperationResult,
  OperationError,
  RegistrySnapshot,
  OperationDefinition,
} from '../types.js';
import type { RegistryReference } from '../registry-reference.js';
import type {
  DispatchContext,
  DispatcherHooks,
  MCPResult,
  HookDecision,
} from './types.js';
import { omitUndefined } from '../utils.js';

/**
 * Command dispatcher interface
 */
export interface CommandDispatcher {
  /**
   * Dispatch a command through the 12-stage execution envelope.
   *
   * @param command - Operation command to execute
   * @returns MCP wire result
   */
  dispatch(command: OperationCommand): Promise<MCPResult>;
}

/**
 * Create a command dispatcher
 *
 * @param registry - Registry reference (snapshot captured at dispatch entry)
 * @param hooks - Optional user-extensible hooks
 * @returns CommandDispatcher instance
 */
export function createDispatcher(
  registry: RegistryReference,
  hooks?: DispatcherHooks,
): CommandDispatcher {
  return new DefaultCommandDispatcher(registry, hooks);
}

/**
 * Default command dispatcher implementation
 */
class DefaultCommandDispatcher implements CommandDispatcher {
  constructor(
    private readonly registry: RegistryReference,
    private readonly hooks: DispatcherHooks = {},
  ) {}

  async dispatch(command: OperationCommand): Promise<MCPResult> {
    try {
      // STAGE 1: Resolve snapshot and operation
      // CRITICAL: Capture snapshot ONCE at dispatch entry, never re-read
      const snapshot = this.registry.current();
      const operation = snapshot.operations.get(command.operationId);

      if (!operation) {
        return this.mapError({
          code: 'INVALID_INPUT',
          message: `Operation '${command.operationId}' not found`,
        });
      }

      // Build dispatch context (immutable for entire pipeline)
      const context: DispatchContext = {
        requestId: command.requestId,
        operationId: command.operationId,
        registryHash: snapshot.hash,
        principal: command.principal,
        confirmation: command.confirmation,
        deadline: command.deadline,
        signal: command.signal,
      };

      // STAGE 2: Authenticate
      const principal = await this.authenticate(context);
      const contextWithPrincipal: DispatchContext = {
        ...context,
        principal: principal ?? context.principal,
      };

      // STAGE 3: Authorize
      const authDecision = await this.authorize(contextWithPrincipal, command.input);
      if (authDecision.shortCircuit) {
        return this.mapResult(authDecision.result);
      }

      // STAGE 4: Validate input
      const inputValidation = this.validateInput(command.input, operation);
      if (!inputValidation.ok) {
        return this.mapError(inputValidation.error);
      }

      // STAGE 5: Verify confirmation
      const confirmDecision = await this.verifyConfirmation(
        contextWithPrincipal,
        command.input,
      );
      if (confirmDecision.shortCircuit) {
        return this.mapResult(confirmDecision.result);
      }

      // STAGE 6: Acquire bulkhead permit
      // v0.1: no-op (real bulkheads in Epic #3)
      await this.acquireBulkhead(contextWithPrincipal);

      // STAGE 7: Apply deadline + AbortSignal to executor
      // (Already present in command, passed to executor)

      // STAGE 8: Execute
      const executionResult = await this.execute(
        operation,
        command.input,
        contextWithPrincipal,
      );

      // If execution failed, skip output validation and go straight to mapping
      if (!executionResult.ok) {
        return this.mapResult(executionResult);
      }

      // STAGE 9: Validate output
      const outputValidation = this.validateOutput(executionResult.value, operation);
      if (!outputValidation.ok) {
        return this.mapError(outputValidation.error);
      }

      // STAGE 10: Redact observable data
      const redacted = this.redact(executionResult.value);

      // STAGE 11: Audit
      const finalResult: OperationResult = { ok: true, value: redacted };
      await this.audit(contextWithPrincipal, finalResult);

      // STAGE 12: Map to MCP result
      return this.mapResult(finalResult);
    } catch (error) {
      // Catch any internal exception and map to INTERNAL_ERROR
      // NEVER leak original message, stack, or type name
      return this.mapError({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
      });
    }
  }

  // ============================================================================
  // Stage implementations
  // ============================================================================

  private async authenticate(context: DispatchContext): Promise<Principal | undefined> {
    if (this.hooks.authenticate) {
      return this.hooks.authenticate(context);
    }
    // v0.1: default is unauthenticated
    return undefined;
  }

  private async authorize(
    context: DispatchContext,
    input: unknown,
  ): Promise<HookDecision> {
    if (this.hooks.authorize) {
      return this.hooks.authorize(context, input);
    }
    // v0.1: default is allow all
    return { continue: true };
  }

  private validateInput(
    input: unknown,
    operation: OperationDefinition,
  ): OperationResult {
    // v0.1: basic type check (full JSON Schema validation deferred)
    if (input === null || input === undefined) {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Input is required',
        },
      };
    }
    return { ok: true, value: input };
  }

  private async verifyConfirmation(
    context: DispatchContext,
    input: unknown,
  ): Promise<HookDecision> {
    if (this.hooks.verifyConfirmation) {
      return this.hooks.verifyConfirmation(context, input);
    }
    // v0.1: no-op (pass-through)
    return { continue: true };
  }

  private async acquireBulkhead(_context: DispatchContext): Promise<void> {
    // v0.1: no-op (real bulkheads in Epic #3)
    return;
  }

  private async execute(
    operation: OperationDefinition,
    input: unknown,
    context: DispatchContext,
  ): Promise<OperationResult> {
    // v0.1: stub executor - returns echo result
    // Real executor strategies (viaHandler, viaHttp) ship in issue #14
    try {
      // Simulate async execution
      await new Promise(resolve => setTimeout(resolve, 0));

      // Check for cancellation
      if (context.signal.aborted) {
        return {
          ok: false,
          error: {
            code: 'CANCELLED',
            message: 'Request cancelled',
          },
        };
      }

      // Echo the input as output (stub behavior)
      return { ok: true, value: input };
    } catch (error) {
      // Map executor exceptions to INTERNAL_ERROR
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Execution failed',
        },
      };
    }
  }

  private validateOutput(
    output: unknown,
    operation: OperationDefinition,
  ): OperationResult {
    // v0.1: basic type check (full JSON Schema validation deferred)
    if (output === null || output === undefined) {
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Executor returned null or undefined',
        },
      };
    }
    return { ok: true, value: output };
  }

  private redact<T>(value: T): T {
    if (this.hooks.redact) {
      return this.hooks.redact(value);
    }
    // v0.1: pass-through (no redaction)
    return value;
  }

  private async audit(
    context: DispatchContext,
    result: OperationResult,
  ): Promise<void> {
    if (this.hooks.audit) {
      await this.hooks.audit(context, result);
    }
    // v0.1: no-op sink
  }

  // ============================================================================
  // Error mapping
  // ============================================================================

  private mapResult(result: OperationResult): MCPResult {
    if (result.ok) {
      return {
        isError: false,
        content: result.value,
      };
    }
    return this.mapError(result.error);
  }

  private mapError(error: OperationError): MCPResult {
    return {
      isError: true,
      error: omitUndefined({
        code: error.code,
        message: error.message,
        details: error.details,
        retryAfter: error.retryAfter,
      }),
    };
  }
}

// Re-export types
export type { CommandDispatcher, DispatcherHooks, DispatchContext, MCPResult } from './types.js';
