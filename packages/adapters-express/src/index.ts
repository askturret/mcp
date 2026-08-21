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
  createCompiler,
  AtomicRegistryReference,
  type RegistrySnapshot,
  type OperationDefinition,
  type Logger,
  type DiscoveredOperation,
  type DiscoveryContext,
  type CompilerContext,
} from '@askturret/mcp-core';
import { fromOpenApi } from '@askturret/mcp-sources-openapi';
import { createHttpTransport } from '@askturret/mcp-transports';
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

  // Create OpenAPI source
  const source = fromOpenApi(options.spec);

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

  // Apply Light preset defaults
  const basePath = options.basePath ?? '/mcp';
  const maxRequestBodySize = options.maxRequestBodySize ?? 1048576; // 1 MiB
  const maxResponseSize = options.maxResponseSize ?? 1048576; // 1 MiB
  const deadlineMs = options.deadlineMs ?? 30000; // 30s
  const enableExplorer =
    options.enableExplorer ?? (process.env['NODE_ENV'] !== 'production');

  // Create logger (no-op in tests to avoid "Cannot log after tests are done")
  const isTest = process.env['NODE_ENV'] === 'test';
  const logger: Logger = {
    debug: (msg: string, meta?: Record<string, unknown>) => {
      if (!isTest) console.debug(msg, meta);
    },
    info: (msg: string, meta?: Record<string, unknown>) => {
      if (!isTest) console.info(msg, meta);
    },
    warn: (msg: string, meta?: Record<string, unknown>) => {
      if (!isTest) console.warn(msg, meta);
    },
    error: (msg: string, meta?: Record<string, unknown>) => {
      if (!isTest) console.error(msg, meta);
    },
  };

  // Create empty registry reference (will be populated async)
  const emptySnapshot: RegistrySnapshot = {
    hash: '',
    operations: new Map(),
    version: 1,
    createdAt: new Date(),
  };
  const registry = new AtomicRegistryReference(emptySnapshot);

  // Async initialization - discover and compile in background
  // Store promise on router for tests to await (prevents logging after teardown)
  const initPromise = (async () => {
    try {
      // Discover operations from all sources
      const abortController = new AbortController();
      const discoveryContext: DiscoveryContext = {
        logger,
        abortSignal: abortController.signal,
      };

      const discovered: DiscoveredOperation[] = [];
      for (const source of options.sources) {
        const ops = await source.discover(discoveryContext);
        discovered.push(...ops);
      }

      // Compile discovered operations into registry snapshot
      const compiler = createCompiler();
      const compilerContext: Omit<CompilerContext, 'warnings'> = {
        logger,
        preset: 'light' as const,
        overlays: [],
      };
      const fullSnapshot = await compiler.compile(discovered, compilerContext);

      // Apply Light preset mutation filter
      let snapshot: RegistrySnapshot;
      if (options.include === '*') {
        // Include all (mutations explicitly allowed)
        snapshot = fullSnapshot;
      } else if (Array.isArray(options.include)) {
        // Explicit inclusion list
        const includedOps = new Map<string, OperationDefinition>();
        for (const opId of options.include) {
          const op = fullSnapshot.operations.get(opId);
          if (op) {
            includedOps.set(opId, op);
          }
        }
        snapshot = {
          ...fullSnapshot,
          operations: includedOps,
        };
      } else {
        // Light preset: read-only only, mutations excluded
        const readOnlyOps = new Map<string, OperationDefinition>();
        for (const [id, op] of fullSnapshot.operations.entries()) {
          if (op.effects.readOnly) {
            readOnlyOps.set(id, op);
          }
        }
        snapshot = {
          ...fullSnapshot,
          operations: readOnlyOps,
        };
      }

      // Update registry with compiled snapshot
      registry.swap(snapshot);
      logger.info('Registry initialized', { operationCount: snapshot.operations.size });
    } catch (error) {
      logger.error('Failed to initialize registry', { error });
      throw error;
    }
  })();

  // Attach init promise to router for tests to await
  (router as any)._init = initPromise;

  // Create HTTP transport
  const transport = createHttpTransport({
    registry,
    ...(options.hooks !== undefined && { hooks: options.hooks }),
    basePath,
    deadlineMs,
    maxRequestBodySize,
    maxResponseSize,
    ...(options.transport !== undefined && options.transport),
  });

  // Mount Explorer UI BEFORE transport so it gets priority
  // Routes are relative to router mount point (user mounts at basePath)
  if (enableExplorer) {
    router.get('/explorer', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(createExplorerHtml(basePath));
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

      // Extract request context from Express req
      const user = extractUserContext(req);
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
 * Extract user context from Express req.user
 * Small allowlist - no broad reflection
 */
function extractUserContext(req: Request): RequestContext['user'] | undefined {
  const user = (req as any).user;
  if (!user || typeof user !== 'object') {
    return undefined;
  }

  // Allowlist known fields only
  const result: RequestContext['user'] = {};
  if (typeof user.id === 'string') result.id = user.id;
  if (typeof user.email === 'string') result.email = user.email;
  if (typeof user.name === 'string') result.name = user.name;
  if (Array.isArray(user.roles)) result.roles = user.roles;
  return result;
}

/**
 * Create minimal Explorer HTML
 * (Full implementation deferred to #19 - Explorer UI epic)
 */
function createExplorerHtml(basePath: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>MCP Explorer (Dev)</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
    h1 { color: #333; }
    .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 4px; }
    code { background: #e0e0e0; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>AskTurret MCP Explorer</h1>
  <p>This is a minimal development explorer. Full Explorer UI ships in Epic #1.3 (issue #19).</p>

  <div class="endpoint">
    <h3>POST ${basePath}</h3>
    <p>JSON-RPC endpoint for MCP operations:</p>
    <ul>
      <li><code>initialize</code> - Protocol negotiation</li>
      <li><code>tools/list</code> - List available operations</li>
      <li><code>tools/call</code> - Execute an operation</li>
      <li><code>ping</code> - Health check</li>
    </ul>
  </div>

  <div class="endpoint">
    <h3>GET ${basePath}</h3>
    <p>SSE stream for server-initiated notifications (heartbeat only in v0.1)</p>
  </div>

  <div class="endpoint">
    <h3>DELETE ${basePath}</h3>
    <p>Session termination (if sessions enabled)</p>
  </div>

  <p><em>Note: This explorer is only available when NODE_ENV !== 'production'</em></p>
</body>
</html>`;
}

/**
 * Re-export types
 */
export * from './types.js';
