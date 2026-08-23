// SPDX-License-Identifier: Apache-2.0
/**
 * Dispatcher types - hook interfaces and execution context
 *
 * ADR-010: Fixed execution envelope - the 12-stage pipeline is sealed.
 * User middleware may extend defined hooks but cannot bypass mandatory stages.
 */

import type {
  OperationResult,
  Principal,
  ConfirmationProof,
} from '../types.js';
import type { ClientInfo } from '../policy/types.js';

/**
 * Dispatch context - threaded through all 12 stages.
 * Immutable snapshot of execution state at dispatch entry.
 */
export interface DispatchContext {
  /**
   * Unique request identifier for tracing
   */
  readonly requestId: string;

  /**
   * Operation ID being executed
   */
  readonly operationId: string;

  /**
   * Registry snapshot hash at dispatch entry
   * (captured once, never re-read)
   */
  readonly registryHash: string;

  /**
   * Authenticated principal (if any)
   */
  readonly principal?: Principal;

  /**
   * Client information volunteered at initialize, carried from the command.
   *
   * Previously dropped between OperationCommand and DispatchContext, which
   * made it unreachable to everything downstream (noted in #33). Call-time
   * authorization needs it, so it is threaded through (#35).
   */
  readonly clientInfo?: ClientInfo;

  /**
   * Confirmation proof (if provided)
   */
  readonly confirmation?: ConfirmationProof;

  /**
   * Client-supplied idempotency key, carried from the command (§8.4, #45).
   *
   * The runtime does NOT persist or interpret these — deduplication is the
   * upstream's job. This exists so the key can REACH the upstream: `viaHttp`
   * sends it as an `Idempotency-Key` header, and `viaHandler` handlers read it
   * off this context. Without it the key stopped at the command boundary and
   * the enforcement in stage 4 would be demanding something that then went
   * nowhere.
   */
  readonly idempotencyKey?: string;

  /**
   * Execution deadline
   */
  readonly deadline: Date;

  /**
   * Cancellation signal
   */
  readonly signal: AbortSignal;
}

/**
 * Hook decision - short-circuit or continue.
 */
export type HookDecision<T = unknown> =
  | { continue: true }
  | { shortCircuit: true; result: OperationResult<T> };

/**
 * Authentication hook - extracts principal from transport context.
 * v0.1: default implementation returns undefined (unauthenticated).
 */
export type AuthenticateHook = (
  context: DispatchContext,
) => Promise<Principal | undefined>;

/**
 * Authorization hook - checks if principal can execute operation with given input.
 * v0.1: default implementation allows all (no-op).
 */
export type AuthorizeHook = (
  context: DispatchContext,
  input: unknown,
) => Promise<HookDecision>;

/**
 * Confirmation verification hook - validates confirmation proof if policy required one.
 * v0.1: default implementation is no-op (pass-through).
 */
export type VerifyConfirmationHook = (
  context: DispatchContext,
  input: unknown,
) => Promise<HookDecision>;

/**
 * Redaction hook - redacts sensitive data from observable surfaces.
 * v0.1: pass-through (no redaction). Real pipeline ships in Epic #3.
 */
export type RedactHook = <T>(value: T) => T;

/**
 * Audit hook - records execution event.
 * v0.1: no-op sink. Real sinks ship in Epic #3.
 */
export type AuditHook = (
  context: DispatchContext,
  result: OperationResult,
) => Promise<void>;

/**
 * Dispatcher hooks - user-extensible within each stage.
 * Stage sequence itself is NOT reorderable.
 */
export interface DispatcherHooks {
  /**
   * Authentication hook (stage 2)
   */
  readonly authenticate?: AuthenticateHook;

  /**
   * Authorization hook (stage 3)
   */
  readonly authorize?: AuthorizeHook;

  /**
   * Confirmation verification hook (stage 5)
   */
  readonly verifyConfirmation?: VerifyConfirmationHook;

  /**
   * Redaction hook (stage 10)
   */
  readonly redact?: RedactHook;

  /**
   * Audit hook (stage 11)
   */
  readonly audit?: AuditHook;
}

/**
 * MCP wire result - final transport shape.
 * Maps OperationResult to MCP protocol format.
 */
export interface MCPResult {
  /**
   * Success flag
   */
  readonly isError: false | true;

  /**
   * Result content (if success)
   */
  readonly content?: unknown;

  /**
   * Error details (if failure)
   */
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
    readonly retryAfter?: number;
  };
}
