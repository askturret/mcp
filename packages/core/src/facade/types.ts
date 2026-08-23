// SPDX-License-Identifier: Apache-2.0
/**
 * The facade configuration surface, shared by every framework adapter (§4, §12.3).
 *
 * ## Why this lives in core rather than in each adapter
 *
 * §41 requires that "a user should be able to swap the import and change nothing
 * else". If each adapter declared its own options interface, that promise would
 * be enforced by nothing: two structurally identical interfaces satisfy the same
 * call sites today and drift the moment one gains a field. The parity would be
 * asserted in a README and checked by no one.
 *
 * Declaring it ONCE makes the promise true by construction. `ExpressMcpOptions`
 * and `FastifyMcpOptions` are aliases of this type, so a config object that
 * type-checks against one type-checks against the other because they ARE the
 * same type.
 *
 * These types are framework-neutral by construction — nothing here references a
 * request, a response, or a router. That is also the test of whether the facade
 * was accidentally Express-shaped: anything that could not be expressed here
 * would be a leak.
 */

import type { DispatcherHooks } from '../dispatcher/types.js';
import type { OperationSource } from '../sources/types.js';
import type { OperationExecutor } from '../executor/types.js';

/**
 * Which operations a facade exposes.
 *
 * - `undefined` — Light preset: read-only operations only. Mutations are
 *   excluded, because auto-exposing a mutation from a spec is how an agent gets
 *   the ability to charge a card nobody meant to grant.
 * - `string[]` — exactly these operation ids, mutations included.
 * - `'*'` — everything, mutations included. Deliberately explicit.
 */
export type IncludeFilter = string[] | '*';

/**
 * Transport options a facade forwards.
 *
 * Structurally typed rather than imported from `@askturret/mcp-transports`:
 * core cannot depend on the transports package (transports depends on core), and
 * duplicating the full interface here would be a second definition to keep in
 * sync. Adapters pass their own `Partial<HttpTransportOptions>` through, which
 * satisfies this shape.
 */
export interface FacadeTransportOptions {
  readonly executors?:
    | ReadonlyMap<string, OperationExecutor>
    | Iterable<readonly [string, OperationExecutor]>;
  readonly [key: string]: unknown;
}

/**
 * The composable form's options — `expressMcp({...})` / `fastifyMcp({...})`.
 */
export interface McpFacadeOptions {
  /** Operation sources to compile and expose. */
  sources: OperationSource[];

  /** Dispatcher hooks for auth, policy, audit. */
  hooks?: DispatcherHooks;

  /** Base path for MCP endpoints (default: '/mcp'). */
  basePath?: string;

  /** Transport configuration. Default: stateless HTTP with Light preset bounds. */
  transport?: FacadeTransportOptions;

  /** Explorer UI (default: on when NODE_ENV !== 'production'). */
  enableExplorer?: boolean;

  /** Which operations to expose. See `IncludeFilter`. */
  include?: IncludeFilter;

  /** Maximum request body size in bytes (default: 1048576 = 1 MiB). */
  maxRequestBodySize?: number;

  /** Maximum response size in bytes (default: 1048576 = 1 MiB). */
  maxResponseSize?: number;

  /** Default deadline per call in milliseconds (default: 30000). */
  deadlineMs?: number;
}

/**
 * The one-call form's options — `mcpFromOpenApi('./openapi.yaml')`.
 */
export interface McpFromOpenApiFacadeOptions {
  /** OpenAPI spec source (file path or URL). */
  spec: string;

  /** Base path for MCP endpoints (default: '/mcp'). */
  basePath?: string;

  /** Which operations to expose. See `IncludeFilter`. */
  include?: IncludeFilter;

  /**
   * Explicit upstream base URL for calling the described API.
   *
   * Overrides the spec's `servers` array. Supply this when the spec declares no
   * absolute server, declares several and you want a specific one, or points at
   * an environment you are not targeting.
   */
  baseUrl?: string;

  /** Explorer UI (default: on when NODE_ENV !== 'production'). */
  enableExplorer?: boolean;

  /** Dispatcher hooks. */
  hooks?: DispatcherHooks;
}

/**
 * Request context a facade extracts from its framework's request object.
 *
 * The SHAPE is shared; how each adapter populates it is not. Express reads
 * `req.user`, Fastify reads `request.user` (a decorator). Both land here, so a
 * hook written against this context works on either.
 */
export interface FacadeRequestContext {
  /** Authenticated user, when the host framework put one on the request. */
  user?: {
    id?: string;
    email?: string;
    name?: string;
    roles?: string[];
  };

  /** Request id for tracing. */
  requestId: string;
}

/** Facade defaults, after `resolveFacadeDefaults` has applied them. */
export interface ResolvedFacadeDefaults {
  readonly basePath: string;
  readonly maxRequestBodySize: number;
  readonly maxResponseSize: number;
  readonly deadlineMs: number;
  readonly enableExplorer: boolean;
}
