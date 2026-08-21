// SPDX-License-Identifier: Apache-2.0
/**
 * Executor types - operation execution strategies
 *
 * ADR-014: Executor strategies must be interchangeable - viaHandler and viaHttp
 * produce identical golden output for the same operation definition.
 */

import type { OperationDefinition, OperationResult } from '../types.js';
import type { DispatchContext } from '../dispatcher/types.js';

/**
 * Operation executor - executes an operation and returns a result.
 *
 * Contract:
 * - Must respect AbortSignal cancellation (propagate to downstream calls)
 * - Must respect deadline (enforce independently of client timeout)
 * - Must map exceptions to OperationError at the boundary
 * - Must never leak internal exception stacks or type names
 * - Switching executors must produce identical output (golden output contract)
 */
export interface OperationExecutor {
  /**
   * Execute an operation.
   *
   * @param operation - Operation definition
   * @param input - Operation input (already validated)
   * @param context - Dispatch context (principal, deadline, signal, etc.)
   * @returns OperationResult (success or typed error)
   */
  execute(
    operation: OperationDefinition,
    input: unknown,
    context: DispatchContext,
  ): Promise<OperationResult>;
}

/**
 * Handler function - direct in-process operation handler.
 *
 * Type-safe function that takes input and context, returns a result.
 * Exceptions are caught and mapped to INTERNAL_ERROR by viaHandler.
 */
export type OperationHandler = (
  input: unknown,
  context: DispatchContext,
) => Promise<unknown>;

/**
 * HTTP executor options - configuration for viaHttp executor.
 */
export interface HttpExecutorOptions {
  /**
   * Base URL for the upstream service.
   * SSRF safety: fixed at config time, never influenced by user input.
   *
   * Optional: when omitted, each operation must supply its own `baseUrl` in its
   * executor binding config (as operations discovered from an API spec do).
   * An operation with neither fails with EXECUTOR_MISCONFIGURED rather than
   * issuing a request to an unintended host.
   */
  readonly baseUrl?: string;

  /**
   * Optional HTTP client (defaults to undici).
   * Injected for testing (nock/msw) and custom client strategies.
   */
  readonly client?: HttpClient;

  /**
   * Optional credential resolver.
   * Credentials resolved at execution time, never logged.
   */
  readonly credentials?: CredentialResolver;

  /**
   * Optional timeout in milliseconds (defaults to 30000).
   * Deadline is enforced independently - shorter of this and context.deadline wins.
   */
  readonly timeoutMs?: number;
}

/**
 * HTTP client interface - abstraction over fetch/undici.
 * Enables testing with nock/msw and custom client implementations.
 */
export interface HttpClient {
  /**
   * Make an HTTP request.
   *
   * @param url - Full URL (base + path)
   * @param options - Request options
   * @returns HTTP response
   */
  request(url: string, options: HttpRequestOptions): Promise<HttpResponse>;
}

/**
 * HTTP request options.
 */
export interface HttpRequestOptions {
  readonly method: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/**
 * HTTP response.
 */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Credential resolver - resolves credentials at execution time.
 * Never logs credential values.
 */
export type CredentialResolver = () => Promise<Record<string, string>>;
