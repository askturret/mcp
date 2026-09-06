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

      // Panels are resolved per request, not per server: breaker states, span
      // tails and bulkhead depths are live, and a value captured at startup
      // would render as though it were current (#56).
      //
      // A supplier that throws degrades to the tool browser rather than 500-ing
      // the page. The Explorer is the surface an operator reaches for WHEN
      // something is already wrong, so a broken metrics read must not take the
      // whole diagnostic away — but it is named in the log, never swallowed.
      let panels: Awaited<ReturnType<NonNullable<typeof options.explorerPanels>>> | undefined;
      if (options.explorerPanels !== undefined) {
        try {
          panels = await options.explorerPanels();
        } catch (error) {
          logger.warn('Explorer panel supplier threw; rendering without diagnostic panels', {
            error: error instanceof Error ? error.message : String(error),
            path: `${basePath}/explorer`,
          });
        }
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // Dev tool: never cache, never index.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.send(renderExplorerHtml(model, panels));
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
 * Has something already read this request's body to the end?
 *
 * `readableEnded` is the stream's own answer, it is public Node API, and it
 * covers any consumer — not only `body-parser`. It is the whole predicate.
 *
 * ## Why `req._body` is no longer consulted (#706)
 *
 * This function also read `req._body`, a `body-parser` INTERNAL, justified by
 * the claim that "a parser can mark the body handled without the stream
 * reporting ended (an empty body, or a `type` mismatch that still
 * short-circuits)". **Both halves of that claim are false.** An empty body DOES
 * report `readableEnded === true`, because the parser still reads the stream to
 * its end. A `type` mismatch leaves the stream UNREAD, so `_body` is not set
 * either and no guard is wanted — the transport can read the body itself.
 *
 * Measured across json, urlencoded, raw, text, type mismatch, empty body,
 * gzipped body, malformed and over-limit error paths, a bodyless GET, and no
 * parser at all, on BOTH majors:
 *
 * | | `_body` set when `readableEnded` is false? | hang cases `readableEnded` misses |
 * |---|---|---|
 * | express 4 / body-parser 1.20.6 | ONE shape — see below | **0** |
 * | express 5 / body-parser 2.3.0 | never sets `_body` at all | **0** |
 *
 * ## The one shape where they diverge, and why it does not save the clause
 *
 * A **mid-body client abort** on express 4 leaves `_body === true` with
 * `readableEnded === false`. body-parser 1.20.6 sets the field EARLY, at
 * `lib/read.js:46`, before the read completes, so a connection that dies partway
 * through is marked handled without the stream ever ending. (Found by QA running
 * a broader probe than the one this comment originally cited, which had no abort
 * case; reproduced independently before this was written.)
 *
 * It does not make the clause load-bearing, for three independent reasons:
 *
 * 1. **This function is never reached on that path.** body-parser calls
 *    `next(err)` with `request.aborted`, which routes to ERROR middleware; the
 *    transport is mounted as ordinary middleware and is skipped entirely.
 * 2. **There is nothing to guard.** The socket is already gone — `req.aborted`
 *    is true. No response can be delivered, so there is no hang to prevent.
 * 3. **express 5 never had the guard here anyway.** body-parser 2 does not set
 *    the field, so that path was already unguarded under the OLD predicate. The
 *    deletion changes nothing about it.
 *
 * So the clause was redundant on every path where this predicate actually runs,
 * and dead under body-parser 2 regardless. Removing it drops a bet on a
 * transitive dependency's private field WITHOUT replacing it with a weaker
 * mechanism, because the public one was already complete. That is why this is a
 * deletion rather than a documented version bound: there is no version range to
 * bound — there is no behaviour to preserve.
 *
 * **No test covers the abort shape, deliberately.** Since the abort never
 * reaches this function, such a test would assert Express's error-routing rather
 * than this predicate — it would pass identically under any predicate, including
 * one that is plainly wrong. That is the cannot-fail shape this repository keeps
 * filing issues about, and adding one here while correcting an inaccurate
 * self-description would be trading one instance of the species for another.
 *
 * The guard as a whole is NOT redundant, and `hang-guard.test.ts` is what says
 * so: disable this predicate and that suite goes red on both majors.
 */
function bodyAlreadyConsumed(req: Request): boolean {
  const raw = req as unknown as { readableEnded?: boolean };
  return raw.readableEnded === true;
}

/**
 * Recover the bytes a host parser left behind, as close to the wire as we can.
 *
 * `express.raw()` and `express.text()` keep the payload verbatim, so those are
 * exact. `express.json()` keeps only the PARSED value, so the original bytes are
 * gone and re-serializing is the best available reconstruction — semantically
 * equal JSON, not byte-identical. That is fine for JSON-RPC, which is what this
 * route carries, and it is the honest limit of fixing this after the fact.
 */
function payloadFromParsedBody(req: Request): Buffer {
  const body = (req as unknown as { body?: unknown }).body;

  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf-8');
  if (body === undefined || body === null) return Buffer.alloc(0);

  try {
    return Buffer.from(JSON.stringify(body), 'utf-8');
  } catch {
    // A circular or otherwise unserializable body is not something we can
    // replay. Send nothing rather than throwing: the transport answers an empty
    // body with a normal JSON-RPC parse error, and an answer beats a hang.
    return Buffer.alloc(0);
  }
}

/**
 * Replay an already-consumed body so the transport's stream listeners still fire.
 *
 * ## The hazard (#147)
 *
 * The transport reads the RAW stream — `readRequestBody` consumes it via
 * `req.on('data')`. A host app registering a global `express.json()` is
 * completely ordinary, and it drains that stream first. By the time the
 * transport attaches listeners the stream has ended: `data` never fires, `end`
 * never fires, the promise never settles, and the request HANGS. No error, no
 * 500 — no response at all, which is the hardest failure to attribute to the
 * right layer.
 *
 * ## Why Express cannot use Fastify's fix
 *
 * #41 solved this for Fastify with an encapsulated pass-through content-type
 * parser, so the body is never parsed inside the plugin's scope. Express has no
 * equivalent: middleware order is global, the host's parser has ALREADY run
 * before anything scoped to our router can act, and nothing can un-drain a
 * stream. So Fastify PREVENTS the parse and Express can only REPAIR it. Those
 * are different mechanisms for the same defect, and the difference is Express's
 * middleware model rather than a choice.
 *
 * ## Why the replay is armed rather than emitted immediately
 *
 * Emitting on the spot would fire into an empty room — the transport attaches
 * its listeners later, inside `readRequestBody`. Instead the first `data`/`end`
 * subscription arms a `nextTick` replay: that executor attaches all of its
 * listeners synchronously, so the tick lands once `data`, `end` AND `error` are
 * all present. It therefore does not depend on the order the transport happens
 * to subscribe in.
 *
 * ## What this preserves
 *
 * `maxRequestBodySize` still enforces. The transport counts bytes per chunk and
 * rejects when the running total exceeds the limit, so replaying the payload as
 * a single chunk trips exactly the same check.
 */
function armBodyReplay(req: Request): void {
  const stream = req as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    emit: (event: string, ...args: unknown[]) => boolean;
  };

  const payload = payloadFromParsedBody(req);
  const subscribe = stream.on.bind(stream);
  let armed = false;

  stream.on = function patchedOn(event: string, listener: (...args: unknown[]) => void) {
    const result = subscribe(event, listener);

    if (!armed && (event === 'data' || event === 'end')) {
      armed = true;
      process.nextTick(() => {
        // An empty payload emits no `data` at all, which is what a genuinely
        // empty request body looks like on the wire.
        if (payload.length > 0) stream.emit('data', payload);
        stream.emit('end');
      });
    }

    return result;
  } as typeof stream.on;
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

      // If a host body parser already drained the stream, replay it so the
      // transport's listeners still fire (#147). Scoped to requests this
      // middleware is actually handling — a sibling route in the host app is
      // never touched. When nothing consumed the body this is a no-op and the
      // transport reads the real stream exactly as before.
      if (bodyAlreadyConsumed(req)) {
        armBodyReplay(req);
      }

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
