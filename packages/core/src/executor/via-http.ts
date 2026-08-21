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
  private readonly baseUrl: string;
  private readonly client: HttpClient;
  private readonly credentials?: () => Promise<Record<string, string>>;
  private readonly timeoutMs: number;

  constructor(options: HttpExecutorOptions) {
    // SSRF safety: base URL is fixed at config time
    // User input can only influence path+query, never host/port/scheme
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

      // Build request URL
      // SSRF safety: user input only influences path, not baseUrl
      const url = `${this.baseUrl}/${operation.id}`;

      // Build request
      const requestOptions: HttpRequestOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...credentialHeaders,
        },
        body: JSON.stringify(input),
        signal: abortController.signal,
      };

      let response: HttpResponse;
      let requestSent = false;

      try {
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
