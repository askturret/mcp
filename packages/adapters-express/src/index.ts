// SPDX-License-Identifier: Apache-2.0
/**
 * AskTurret MCP - Express Framework Adapter (Light Facade)
 *
 * Primary adoption surface - the "5 minute quick start" experience.
 * Two entry points:
 * 1. One-call: mcpFromOpenApi('./openapi.yaml')
 * 2. Composable: expressMcp({ sources: [...], executor: ... })
 *
 * Light preset defaults:
 * - Read-only operations exposed automatically (if schemas validate)
 * - Mutating operations require explicit inclusion
 * - Stateless HTTP transport
 * - Bounded payloads (1 MiB), deadline 30s
 * - Local Explorer only when NODE_ENV !== 'production'
 */

import express, { type Request, Response, NextFunction, Router } from 'express';
import { randomUUID } from 'crypto';
import {
  viaHttp,
  bootstrapRegistry,
  createFacadeLogger,
  explorerProductionWarning,
  extractUserContext,
  resolveFacadeDefaults,
  type OperationExecutor,
} from '@askturret/mcp-core';
import { fromOpenApi } from '@askturret/mcp-sources-openapi';
import { createHttpTransport } from '@askturret/mcp-transports';
import { buildExplorerViewModel, renderExplorerHtml } from '@askturret/mcp-explorer';
import type { ExpressMcpOptions, McpFromOpenApiOptions, RequestContext } from './types.js';

/**
 * One-call form: mcpFromOpenApi('./openapi.yaml')
 *
 * Returns a mountable Express middleware with Light preset defaults.
 *
 * @param specOrOptions - OpenAPI spec path/URL or full options
 * @returns Express Router
 */
export function mcpFromOpenApi(
  specOrOptions: string | McpFromOpenApiOptions,
  extraOptions?: Omit<McpFromOpenApiOptions, 'spec'>,
): Router {
  const options: McpFromOpenApiOptions =
    typeof specOrOptions === 'string'
      ? { spec: specOrOptions, ...extraOptions }
      : specOrOptions;

  // Create OpenAPI source, forwarding an explicit upstream base URL when given
  const source = fromOpenApi(
    options.spec,
    options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {},
  );

  // Delegate to composable form
  return expressMcp({
    sources: [source],
    ...(options.basePath !== undefined && { basePath: options.basePath }),
    ...(options.include !== undefined && { include: options.include }),
    ...(options.enableExplorer !== undefined && { enableExplorer: options.enableExplorer }),
    ...(options.hooks !== undefined && { hooks: options.hooks }),
  });
}

/**
 * Composable form: expressMcp({ sources: [...], executor: ... })
 *
 * Returns Express Router with full Light preset configuration.
 *
 * @param options - Configuration options
 * @returns Express Router
 */
export function expressMcp(options: ExpressMcpOptions): Router {
  const router: Router = express.Router();

  // Light preset defaults, the logger, and the discover/compile/filter
  // bootstrap all come from core's framework-neutral facade module. Express and
  // Fastify share them so a default cannot drift between the two adapters —
  // see `@askturret/mcp-core`'s `facade/` for why that is structural rather
  // than a convention (#41).
  const { basePath, maxRequestBodySize, maxResponseSize, deadlineMs, enableExplorer } =
    resolveFacadeDefaults(options);

  const logger = createFacadeLogger();

  const { registry, ready: initPromise } = bootstrapRegistry(
    options.sources,
    options.include,
    logger,
  );

  // Attach init promise to router for tests to await
  (router as any)._init = initPromise;

  // Register a default executor for spec-discovered operations.
  //
  // Without this, every tools/call fails with "No executor registered" — the
  // registry knows the tools but nothing can run them (#103). Operations
  // discovered from an API spec carry executor type 'http' plus their own
  // method, path and base URL, so viaHttp needs no constructor baseUrl here;
  // an operation whose spec declared no usable server fails with an actionable
  // message rather than being routed to an unintended host.
  const executors = new Map<string, OperationExecutor>([['http', viaHttp({})]]);

  // A caller-supplied executor always wins, per type — including replacing
  // 'http' outright.
  for (const [type, executor] of options.transport?.executors ?? []) {
    executors.set(type, executor);
  }

  // Create HTTP transport
  const transport = createHttpTransport({
    registry,
    ...(options.hooks !== undefined && { hooks: options.hooks }),
    basePath,
    deadlineMs,
    maxRequestBodySize,
    maxResponseSize,
    ...(options.transport !== undefined && options.transport),
    // After the spread: the merged map already contains the caller's entries.
    executors,
  });

  // Mount Explorer UI BEFORE transport so it gets priority
  // Routes are relative to router mount point (user mounts at basePath)
  if (enableExplorer) {
    // §10.1 invariant 9: Explorer is off by default in production. Reaching
    // here with NODE_ENV=production means the operator opted in explicitly, so
    // name the setting that did it — the risk is not blocked, but it is loud.
    if (process.env['NODE_ENV'] === 'production' && options.enableExplorer === true) {
      logger.warn(explorerProductionWarning(basePath), {
        setting: 'enableExplorer: true',
        nodeEnv: 'production',
        path: `${basePath}/explorer`,
      });
    }

    router.get('/explorer', async (_req: Request, res: Response) => {
      // Await discovery/compile so a fast first request doesn't render an
      // empty registry. Errors surface through the transport, not here.
      await initPromise.catch(() => undefined);

      const model = buildExplorerViewModel(registry.current(), basePath);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // Dev tool: never cache, never index.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.send(renderExplorerHtml(model));
    });
  } else {
    // Return 404 in production
    router.get('/explorer', (_req: Request, res: Response) => {
      res.status(404).json({ error: 'Explorer not available in production' });
    });
  }

  // Mount HTTP transport handler
  // Check path match before delegating to transport to avoid swallowing sibling routes
  router.use(createTransportMiddleware(transport, basePath, deadlineMs, initPromise));

  // Catch-all 404 handler for unknown paths
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: -32601, message: 'Not found' } });
  });

  return router;
}

/**
 * Create Express middleware wrapper for HTTP transport
 */
function createTransportMiddleware(
  transport: ReturnType<typeof createHttpTransport>,
  basePath: string,
  deadlineMs: number,
  ready: Promise<void>,
) {
  const handler = transport.handler();

  return async (req: Request, res: Response, next: NextFunction) => {
    // Check if request path matches basePath or its sub-routes
    // Use req.originalUrl to see the full path before Express prefix-stripping
    const requestPath = req.originalUrl?.split('?')[0] || req.url?.split('?')[0] || '';

    // If path doesn't start with basePath, pass to next middleware (allows sibling routes)
    if (!requestPath.startsWith(basePath)) {
      return next();
    }

    try {
      // Wait for the registry to finish its async discover/compile before
      // handling the first request — otherwise an early caller can race
      // ahead of initialization and see an empty tools list.
      // Wait for the registry to finish its async discover/compile before
      // handling the first request — otherwise an early caller can race
      // ahead of initialization and see an empty tools list.
      await ready;

      // Extract request context from Express req. The allowlist itself lives in
      // core so Express and Fastify cannot disagree about which user fields are
      // safe to forward into hooks, logs and spans.
      const user = extractUserContext((req as any).user);
      const context: RequestContext = {
        requestId: (req.headers['x-request-id'] as string) || randomUUID(),
        ...(user !== undefined && { user }),
      };

      // Set deadline for this request
      const deadline = new Date(Date.now() + deadlineMs);

      // Attach context to req for handler access
      (req as any).mcpContext = {
        ...context,
        deadline,
      };

      // Delegate to transport handler
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Re-export types
 */
export * from './types.js';
