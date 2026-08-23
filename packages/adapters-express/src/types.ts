// SPDX-License-Identifier: Apache-2.0
/**
 * Express adapter type definitions.
 *
 * These are ALIASES of the shared facade types in `@askturret/mcp-core`, not
 * copies. §41 requires that a user can swap `@askturret/mcp-adapters-express`
 * for `@askturret/mcp-adapters-fastify` and change nothing else — and two
 * structurally identical interfaces satisfy that today while drifting the
 * moment either one gains a field. Aliasing makes the guarantee hold by
 * construction: `ExpressMcpOptions` and `FastifyMcpOptions` ARE the same type,
 * so there is no version of this repo in which one accepts a config the other
 * rejects.
 *
 * The names are kept because they are the published surface.
 */

import type {
  FacadeRequestContext,
  McpFacadeOptions,
  McpFromOpenApiFacadeOptions,
} from '@askturret/mcp-core';

/** Express MCP configuration options (composable form). */
export type ExpressMcpOptions = McpFacadeOptions;

/** One-call form options for `mcpFromOpenApi()`. */
export type McpFromOpenApiOptions = McpFromOpenApiFacadeOptions;

/** Request context extracted from the Express request. */
export type RequestContext = FacadeRequestContext;
