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
import type { ExplorerPanelsOption } from '@askturret/mcp-explorer';

/**
 * Express MCP configuration options (composable form).
 *
 * The Explorer panel supplier (#56) is intersected in from the explorer
 * package rather than added to the shared facade type, because core cannot
 * depend on a package that depends on core. Fastify intersects the SAME
 * declaration, so the swap guarantee above still holds by construction.
 */
export type ExpressMcpOptions = McpFacadeOptions & ExplorerPanelsOption;

/** One-call form options for `mcpFromOpenApi()`. */
export type McpFromOpenApiOptions = McpFromOpenApiFacadeOptions;

/** Request context extracted from the Express request. */
export type RequestContext = FacadeRequestContext;
