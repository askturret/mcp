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

import type { Request, Response, NextFunction, Router } from 'express';
import { randomUUID } from 'crypto';
import {
  createCompiler,
  createDispatcher,
  AtomicRegistryReference,
  type RegistrySnapshot,
  type OperationDefinition,
  type Principal,
} from '@askturret/mcp-core';
import { fromOpenApi } from '@askturret/mcp-openapi';
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
): Router {
  const options: McpFromOpenApiOptions =
    typeof specOrOptions === 'string' ? { spec: specOrOptions } : specOrOptions;

  // Create OpenAPI source
  const source = fromOpenApi({ spec: options.spec });

  // Delegate to composable form
  return expressMcp({
    sources: [source],
    basePath: options.basePath,
    include: options.include,
    enableExplorer: options.enableExplorer,
    hooks: options.hooks,
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
  // Use dynamic import to avoid bundling Express
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const express = require('express');
  const router: Router = express.Router();

  // Apply Light preset defaults
  const basePath = options.basePath ?? '/mcp';
  const maxRequestBodySize = options.maxRequestBodySize ?? 1048576; // 1 MiB
  const maxResponseSize = options.maxResponseSize ?? 1048576; // 1 MiB
  const deadlineMs = options.deadlineMs ?? 30000; // 30s
  const enableExplorer =
    options.enableExplorer ?? process.env.NODE_ENV !== 'production';

  // Compile sources into registry snapshot
  const compiler = createCompiler();
  const compileResult = compiler.compile(options.sources);

  // Apply Light preset mutation filter
  let snapshot: RegistrySnapshot;
  if (options.include === '*') {
    // Include all (mutations explicitly allowed)
    snapshot = compileResult.snapshot;
  } else if (Array.isArray(options.include)) {
    // Explicit inclusion list
    const includedOps = new Map<string, OperationDefinition>();
    for (const opId of options.include) {
      const op = compileResult.snapshot.operations.get(opId);
      if (op) {
        includedOps.set(opId, op);
      }
    }
    snapshot = {
      ...compileResult.snapshot,
      operations: includedOps,
    };
  } else {
    // Light preset: read-only only, mutations excluded
    const readOnlyOps = new Map<string, OperationDefinition>();
    for (const [id, op] of compileResult.snapshot.operations.entries()) {
      if (op.effects.readOnly) {
        readOnlyOps.set(id, op);
      }
    }
    snapshot = {
      ...compileResult.snapshot,
      operations: readOnlyOps,
    };
  }

  // Create registry reference
  const registry = new AtomicRegistryReference(snapshot);

  // Create dispatcher
  const dispatcher = createDispatcher(registry, options.hooks);

  // Create HTTP transport
  const transport = createHttpTransport({
    registry,
    hooks: options.hooks,
    basePath,
    deadlineMs,
    maxRequestBodySize,
    maxResponseSize,
    ...options.transport,
  });

  // Mount HTTP transport handler
  router.use(basePath, createTransportMiddleware(transport, deadlineMs));

  // Mount Explorer UI if enabled
  if (enableExplorer) {
    router.get(`${basePath}/explorer`, (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(createExplorerHtml(basePath));
    });
  } else {
    // Return 404 in production
    router.get(`${basePath}/explorer`, (_req: Request, res: Response) => {
      res.status(404).json({ error: 'Explorer not available in production' });
    });
  }

  return router;
}

/**
 * Create Express middleware wrapper for HTTP transport
 */
function createTransportMiddleware(
  transport: ReturnType<typeof createHttpTransport>,
  deadlineMs: number,
) {
  const handler = transport.handler();

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Extract request context from Express req
      const context: RequestContext = {
        requestId: (req.headers['x-request-id'] as string) || randomUUID(),
        user: extractUserContext(req),
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
  return {
    id: typeof user.id === 'string' ? user.id : undefined,
    email: typeof user.email === 'string' ? user.email : undefined,
    name: typeof user.name === 'string' ? user.name : undefined,
    roles: Array.isArray(user.roles) ? user.roles : undefined,
  };
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
  <h1>MCP Explorer (Development Only)</h1>
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
