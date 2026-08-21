// SPDX-License-Identifier: Apache-2.0
/**
 * Builds the upstream HTTP request for an operation.
 *
 * Two shapes are supported, chosen by whether the operation's executor binding
 * carries a `path`:
 *
 * - **Bound** (`config.path` present) — an operation discovered from a spec that
 *   declares its own method and path template, e.g. `GET /pets/{petId}`. Path
 *   parameters are taken from the input; whatever is left becomes a query
 *   string or a JSON body depending on the method.
 * - **RPC** (no `config.path`) — the original shape: `POST {baseUrl}/{id}` with
 *   the whole input as the JSON body. Unchanged, so existing bindings and
 *   hand-written executors keep working.
 *
 * SSRF invariant, in both shapes: the scheme/host/port come only from
 * configuration — the executor's own `baseUrl` or the compiled binding — and
 * never from caller input. Input can influence path segments and query values
 * only, and every interpolated value is percent-encoded.
 */

import type { OperationDefinition } from '../types.js';

/**
 * Executor-binding config keys this module understands.
 * Anything else in `config` is ignored here.
 */
export interface HttpBindingConfig {
  /** HTTP method, e.g. 'GET'. Defaults to POST. */
  readonly method?: string;
  /** Path template relative to the base URL, e.g. '/pets/{petId}'. */
  readonly path?: string;
  /** Per-operation base URL, overriding the executor's default. */
  readonly baseUrl?: string;
}

export interface BuiltRequest {
  readonly url: string;
  readonly method: string;
  /** Absent for methods that carry no request body. */
  readonly body?: string;
}

/**
 * A request that cannot be built. Carries the operation-result error code to
 * report, so the executor does not have to guess.
 */
export class RequestBuildError extends Error {
  constructor(
    // Deliberately reuses the existing OperationErrorCode set rather than adding
    // a new one: those codes are a documented, stable public contract. A
    // missing base URL is a server-side configuration fault, so INTERNAL_ERROR
    // is the honest classification — but the message stays actionable.
    readonly code: 'INTERNAL_ERROR' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'RequestBuildError';
  }
}

/** Methods that carry a request body. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Build the upstream request for an operation.
 *
 * @param operation - the compiled operation being executed
 * @param input - validated caller input
 * @param defaultBaseUrl - the executor's configured base URL, if any
 * @throws RequestBuildError when the binding or input cannot produce a request
 */
export function buildUpstreamRequest(
  operation: OperationDefinition,
  input: unknown,
  defaultBaseUrl: string | undefined,
): BuiltRequest {
  const config = (operation.executor?.config ?? {}) as HttpBindingConfig;

  const baseUrl = typeof config.baseUrl === 'string' && config.baseUrl.length > 0
    ? config.baseUrl
    : defaultBaseUrl;

  if (!baseUrl) {
    throw new RequestBuildError(
      'INTERNAL_ERROR',
      `No upstream base URL for operation '${operation.id}'. The API spec declared no ` +
        'absolute server URL, so it could not be resolved automatically. Pass an explicit ' +
        'upstream base URL when creating the server.',
    );
  }

  const root = baseUrl.replace(/\/+$/, '');

  // RPC shape — unchanged behaviour for bindings without a path template.
  if (!config.path) {
    return {
      url: `${root}/${operation.id}`,
      method: 'POST',
      body: JSON.stringify(input),
    };
  }

  const method = String(config.method ?? 'POST').toUpperCase();
  const values: Record<string, unknown> =
    input !== null && typeof input === 'object' ? { ...(input as Record<string, unknown>) } : {};

  // Interpolate {param} placeholders, consuming those keys.
  const path = config.path.replace(/\{([^}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    const value = values[name];
    if (value === undefined || value === null || value === '') {
      throw new RequestBuildError(
        'INVALID_INPUT',
        `Missing required path parameter '${name}' for operation '${operation.id}'.`,
      );
    }
    delete values[name];
    // Encoded: a path parameter must never introduce path segments or escape
    // the base URL.
    return encodeURIComponent(String(value));
  });

  const suffix = path.startsWith('/') ? path : `/${path}`;

  if (BODY_METHODS.has(method)) {
    return { url: `${root}${suffix}`, method, body: JSON.stringify(values) };
  }

  // No body for GET/HEAD/DELETE/… — leftovers become query parameters.
  const query = buildQuery(values);
  return { url: query ? `${root}${suffix}?${query}` : `${root}${suffix}`, method };
}

/**
 * Serialise leftover input as a query string.
 *
 * Arrays repeat the key (the OpenAPI `form`/`explode` default); objects are
 * JSON-encoded, which is lossy for exotic styles but predictable, and beats
 * silently dropping them.
 */
function buildQuery(values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) params.append(key, String(item));
      }
    } else if (typeof value === 'object') {
      params.append(key, JSON.stringify(value));
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}
