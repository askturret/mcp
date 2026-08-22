// SPDX-License-Identifier: Apache-2.0
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
  OperationDefinition,
  Principal,
} from '../types.js';
import type { RegistryReference } from '../registry-reference.js';
import type {
  DispatchContext,
  DispatcherHooks,
  MCPResult,
  HookDecision,
} from './types.js';
import type { OperationExecutor } from '../executor/types.js';
import type { AuthorizationEngine } from '../policy/authorization.js';
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
 * @param executors - Optional executor registry (maps executor type to OperationExecutor instance)
 * @returns CommandDispatcher instance
 */
export function createDispatcher(
  registry: RegistryReference,
  hooks?: DispatcherHooks,
  executors?: Map<string, OperationExecutor>,
  options?: DispatcherOptions,
): CommandDispatcher {
  return new DefaultCommandDispatcher(registry, hooks, executors, options);
}

/**
 * Dispatcher options beyond the hook seams.
 *
 * A fourth positional parameter rather than a breaking signature change: every
 * existing caller keeps working, and an absent policy means the dispatcher
 * behaves exactly as it did before.
 */
export interface DispatcherOptions {
  /**
   * Call-time authorization policy — stage 3, the actual security boundary.
   *
   * When absent, stage 3 falls back to the `authorize` hook alone, which
   * defaults to allow-all. That is the pre-existing behaviour and remains the
   * default: turning on enforcement is an explicit act.
   */
  readonly authorization?: AuthorizationEngine;
}

/**
 * Default command dispatcher implementation
 */
class DefaultCommandDispatcher implements CommandDispatcher {
  private readonly authorization: AuthorizationEngine | undefined;

  constructor(
    private readonly registry: RegistryReference,
    private readonly hooks: DispatcherHooks = {},
    private readonly executors: Map<string, OperationExecutor> = new Map(),
    options?: DispatcherOptions,
  ) {
    this.authorization = options?.authorization;
  }

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
      //
      // clientInfo is carried across from the command. It used to be dropped
      // here, which made it unreachable to anything downstream — noted during
      // #33 and closed in #35, because call-time authorization needs it.
      const context: DispatchContext = omitUndefined({
        requestId: command.requestId,
        operationId: command.operationId,
        registryHash: snapshot.hash,
        principal: command.principal,
        clientInfo: command.clientInfo,
        confirmation: command.confirmation,
        deadline: command.deadline,
        signal: command.signal,
      });

      // STAGE 2: Authenticate
      const principal = await this.authenticate(context);
      const contextWithPrincipal: DispatchContext = omitUndefined({
        ...context,
        principal: principal ?? context.principal,
      });

      // STAGE 3: Authorize — the actual security boundary (§5.5).
      //
      // The policy engine runs BEFORE the user hook. A hook cannot be allowed
      // to pre-empt a policy denial: if it could, configuring a permissive
      // hook would silently disable the security boundary, which is the one
      // thing a hook must never be able to do.
      const policyOutcome = await this.authorizeByPolicy(
        contextWithPrincipal,
        operation,
        command,
      );
      if (policyOutcome !== null) {
        // Denials are audited. Stage 11 only ever ran on the success path, so
        // without this a refusal left no trace — the one event an audit log
        // most needs to contain.
        await this.audit(contextWithPrincipal, policyOutcome);
        return this.mapResult(policyOutcome);
      }

      const authDecision = await this.authorize(contextWithPrincipal, command.input);
      if ('shortCircuit' in authDecision) {
        await this.audit(contextWithPrincipal, authDecision.result);
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
      if ('shortCircuit' in confirmDecision) {
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

  /**
   * Stage 3, policy half.
   *
   * Returns `null` to continue, or the failing `OperationResult` to return.
   *
   * Note this runs before stage 4 (validate input), which is deliberate per
   * §5.6: a policy may refuse an operation without anyone spending cycles
   * validating an input schema against untrusted content. The input reaching
   * a policy here is the already-parsed JSON-RPC `params.arguments` — the
   * transport parses the body once, and nothing between that parse and this
   * point coerces it, so "safely decoded, no schema-driven coercion" holds by
   * construction rather than by a decode step here.
   */
  private async authorizeByPolicy(
    context: DispatchContext,
    operation: OperationDefinition,
    command: OperationCommand,
  ): Promise<OperationResult | null> {
    if (!this.authorization) return null;

    const outcome = await this.authorization.authorize({
      operation,
      registryHash: context.registryHash,
      input: command.input,
      ...(context.principal === undefined ? {} : { principal: context.principal }),
      ...(context.clientInfo === undefined ? {} : { clientInfo: context.clientInfo }),
      ...(context.confirmation === undefined ? {} : { confirmation: context.confirmation }),
    });

    if (outcome.kind === 'allow') return null;
    return { ok: false, error: outcome.error };
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
    _operation: OperationDefinition,
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
    // Resolve executor from operation binding
    const executorType = operation.executor.type;
    const executor = this.executors.get(executorType);

    if (!executor) {
      // No executor registered for this type - return error
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: `No executor registered for type '${executorType}'`,
        },
      };
    }

    // Delegate to the actual executor (viaHandler, viaHttp, etc.)
    try {
      return await executor.execute(operation, input, context);
    } catch (error) {
      // Catch any unhandled executor exceptions and map to INTERNAL_ERROR
      // Executors should return OperationResult, not throw, but this is a safety net
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
    _operation: OperationDefinition,
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
export type { DispatcherHooks, DispatchContext, MCPResult } from './types.js';
