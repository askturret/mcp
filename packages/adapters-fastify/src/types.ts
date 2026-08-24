// SPDX-License-Identifier: Apache-2.0
/**
 * Fastify adapter type definitions.
 *
 * ALIASES of the shared facade types in `@askturret/mcp-core` — the same types
 * the Express adapter exports under its own names. §41 requires that a user can
 * swap the import and change nothing else, and this is what makes that a
 * property of the code rather than a claim: `FastifyMcpOptions` and
 * `ExpressMcpOptions` are not merely compatible, they are the SAME TYPE. There
 * is no version of this repo where one accepts a config the other rejects.
 */

import type {
  FacadeRequestContext,
  McpFacadeOptions,
  McpFromOpenApiFacadeOptions,
} from '@askturret/mcp-core';
import type { ExplorerPanelsOption } from '@askturret/mcp-explorer';

/**
 * Fastify MCP configuration options (composable form).
 *
 * The Explorer panel supplier (#56) is intersected in from the explorer
 * package rather than added to the shared facade type, because core cannot
 * depend on a package that depends on core. Express intersects the SAME
 * declaration, so the swap guarantee above still holds by construction.
 */
export type FastifyMcpOptions = McpFacadeOptions & ExplorerPanelsOption;

/** One-call form options for `mcpFromOpenApi()`. */
export type McpFromOpenApiOptions = McpFromOpenApiFacadeOptions;

/** Request context extracted from the Fastify request. */
export type RequestContext = FacadeRequestContext;
