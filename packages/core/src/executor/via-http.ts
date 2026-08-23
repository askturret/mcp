// SPDX-License-Identifier: Apache-2.0
/**
 * viaHttp executor - HTTP-proxy operation execution
 *
 * HTTP client (undici default), SSRF safety (base URL fixed at config time),
 * credential resolution at runtime, AbortSignal wired to socket,
 * deadline enforcement, proper error mapping (401/403/429 etc.),
 * OUTCOME_UNKNOWN on socket-reset/timeout-after-send for non-idempotent ops.
 */

import type { OperationDefinition, OperationResult } from '../types.js';
import type { DispatchContext } from '../dispatcher/types.js';
import type {
  OperationExecutor,
  HttpExecutorOptions,
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
} from './types.js';
import { omitUndefined } from '../utils.js';
import { buildUpstreamRequest, RequestBuildError } from './http-request.js';

/**
 * Create an HTTP-based executor.
 *
 * @param options - HTTP executor configuration
 * @returns OperationExecutor that proxies to upstream HTTP service
 */
export function viaHttp(options: HttpExecutorOptions): OperationExecutor {
  return new HttpExecutor(options);
}

/**
 * HTTP executor implementation.
 */
class HttpExecutor implements OperationExecutor {
  private readonly baseUrl: string | undefined;
  private readonly client: HttpClient;
  private readonly credentials?: () => Promise<Record<string, string>>;
  private readonly timeoutMs: number;

  constructor(options: HttpExecutorOptions) {
    // SSRF safety: base URL is fixed at config time
    // User input can only influence path+query, never host/port/scheme
    // May be undefined when each operation's compiled binding carries its own
    // baseUrl (e.g. several specs behind one server) — still config, not input.
    this.baseUrl = options.baseUrl;
    this.client = options.client ?? createDefaultHttpClient();
    if (options.credentials !== undefined) {
      this.credentials = options.credentials;
    }
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  async execute(
    operation: OperationDefinition,
    input: unknown,
    context: DispatchContext,
  ): Promise<OperationResult> {
    try {
      // Check for cancellation before making request
      if (context.signal.aborted) {
        return {
          ok: false,
          error: {
            code: 'CANCELLED',
            message: 'Request cancelled',
          },
        };
      }

      // Enforce deadline independently of client timeout
      // Shorter of context.deadline and timeoutMs wins
      const now = new Date();
      const deadlineMs = context.deadline.getTime() - now.getTime();
      const effectiveTimeoutMs = Math.min(deadlineMs, this.timeoutMs);

      if (effectiveTimeoutMs <= 0) {
        return {
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: 'Deadline exceeded',
          },
        };
      }

      // Create AbortController for deadline + cancellation
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), effectiveTimeoutMs);

      // Wire context.signal to our AbortController
      if (context.signal.aborted) {
        abortController.abort();
      } else {
        context.signal.addEventListener('abort', () => abortController.abort());
      }

      // Resolve credentials at execution time (never logged)
      const credentialHeaders = this.credentials
        ? await this.credentials()
        : {};

      // Build request URL and method from the operation's executor binding.
      // SSRF safety: user input only influences path+query, not baseUrl.
      let built;
      try {
        built = buildUpstreamRequest(operation, input, this.baseUrl);
      } catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof RequestBuildError) {
          // Actionable by design: an unroutable operation should say what is
          // wrong, not surface as a generic internal error.
          return { ok: false, error: { code: err.code, message: err.message } };
        }
        throw err;
      }

      const url = built.url;

      // Build request
      const requestOptions: HttpRequestOptions = omitUndefined({
        method: built.method,
        headers: {
          'Content-Type': 'application/json',
          ...credentialHeaders,
        },
        body: built.body,
        signal: abortController.signal,
      }) as HttpRequestOptions;

      let response: HttpResponse;
      let requestSent = false;

      try {
        // Set BEFORE the await, so it means "we attempted to send", not "bytes
        // reached the server". Deliberately optimistic, and it is what both
        // OUTCOME_UNKNOWN branches key on.
        //
        // The imprecision only ever errs toward declaring uncertainty: a
        // connection that failed before a single byte left the process is
        // reported as uncertain rather than as a clean failure. That is the
        // right direction — over-reporting uncertainty costs a caller one
        // manual check, whereas under-reporting it invites a retry that
        // double-applies a non-idempotent effect. Flagged for QA rather than
        // presented as precise.
        requestSent = true;
        response = await this.client.request(url, requestOptions);
      } catch (error) {
        clearTimeout(timeoutId);

        // Check if aborted
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

          // The deadline fired. WHICH error depends on whether retrying is
          // safe, and that is the whole point of the distinction (§44, §8.3).
          //
          // This branch previously returned TIMEOUT unconditionally. For a
          // non-idempotent operation whose request was already in flight, that
          // is the dangerous answer: TIMEOUT reads as "it did not happen", so
          // a caller retries — and the upstream may have processed the first
          // request perfectly well. The retry then charges the card twice.
          //
          // OUTCOME_UNKNOWN says the one true thing: we stopped waiting, and
          // we do not know what the server did. It is explicitly documented as
          // do-NOT-retry.
          //
          // The socket-reset path below already made this distinction; the
          // deadline path did not, so the same uncertainty produced different
          // advice depending on how the wait ended.
          if (requestSent && !operation.effects.idempotent) {
            return {
              ok: false,
              error: {
                code: 'OUTCOME_UNKNOWN',
                message: 'Deadline exceeded after the request was sent; outcome uncertain',
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

        // Socket reset or connection error after request was sent
        // For non-idempotent operations, this is OUTCOME_UNKNOWN
        if (requestSent && !operation.effects.idempotent) {
          return {
            ok: false,
            error: {
              code: 'OUTCOME_UNKNOWN',
              message: 'Lost upstream response, outcome uncertain',
            },
          };
        }

        // For idempotent operations or pre-send errors, this is UPSTREAM_UNAVAILABLE
        return {
          ok: false,
          error: {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Upstream service unreachable',
          },
        };
      }

      clearTimeout(timeoutId);

      // Map HTTP status codes to typed errors
      if (response.status === 401) {
        return {
          ok: false,
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required',
          },
        };
      }

      if (response.status === 403) {
        return {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Insufficient permissions',
          },
        };
      }

      if (response.status === 429) {
        // Parse retry-after header if present
        const retryAfterHeader = response.headers['retry-after'];
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

        return {
          ok: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Rate limit exceeded',
            ...(retryAfter !== undefined && { retryAfter }),
          },
        };
      }

      if (response.status >= 400) {
        return {
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Upstream service error',
          },
        };
      }

      // Parse response body
      let result: unknown;
      try {
        result = JSON.parse(response.body);
      } catch {
        return {
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Invalid response format',
          },
        };
      }

      return { ok: true, value: result };
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

/**
 * Create default HTTP client using native fetch.
 * Undici can be swapped in via options.client for production.
 */
function createDefaultHttpClient(): HttpClient {
  return {
    async request(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
      const response = await fetch(
        url,
        omitUndefined({
          method: options.method,
          headers: options.headers,
          body: options.body,
          signal: options.signal,
        }),
      );

      const body = await response.text();

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    },
  };
}
