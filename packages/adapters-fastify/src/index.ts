// SPDX-License-Identifier: Apache-2.0
/**
 * AskTurret MCP - Fastify Framework Adapter (Light Facade)
 *
 * The Express facade's sibling, and the proof that it was not accidentally
 * Express-shaped (§4, §12.3, §41). Two entry points, identical to Express:
 *
 *   1. One-call:    mcpFromOpenApi('./openapi.yaml')
 *   2. Composable:  fastifyMcp({ sources: [...] })
 *
 * Everything framework-neutral — Light preset defaults, discovery, compilation,
 * the include filter, the user-context allowlist — comes from
 * `@askturret/mcp-core`'s `facade/` module, which Express calls too. What is
 * left in this file is exactly the Fastify-shaped part, and that is the point:
 * it is short, and none of it is policy.
 */

import { randomUUID } from 'node:crypto';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
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
import type { ExplorerPanels, ExplorerPanelsSupplier } from '@askturret/mcp-explorer';
import type { FastifyMcpOptions, McpFromOpenApiOptions, RequestContext } from './types.js';

/**
 * One-call form: `mcpFromOpenApi('./openapi.yaml')`.
 *
 * Returns a Fastify plugin. Register it with a prefix:
 *
 * ```ts
 * await app.register(mcpFromOpenApi('./openapi.yaml'), { prefix: '/mcp' });
 * ```
 */
export function mcpFromOpenApi(
  specOrOptions: string | McpFromOpenApiOptions,
  extraOptions?: Omit<McpFromOpenApiOptions, 'spec'>,
): FastifyPluginAsync {
  const options: McpFromOpenApiOptions =
    typeof specOrOptions === 'string' ? { spec: specOrOptions, ...extraOptions } : specOrOptions;

  const source = fromOpenApi(
    options.spec,
    options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {},
  );

  return fastifyMcp({
    sources: [source],
    ...(options.basePath !== undefined && { basePath: options.basePath }),
    ...(options.include !== undefined && { include: options.include }),
    ...(options.enableExplorer !== undefined && { enableExplorer: options.enableExplorer }),
    ...(options.hooks !== undefined && { hooks: options.hooks }),
  });
}

/**
 * Composable form: `fastifyMcp({ sources: [...] })`.
 *
 * ## Encapsulation
 *
 * Returned as a PLAIN async plugin, deliberately NOT wrapped in
 * `fastify-plugin`. Wrapping is the usual reflex for a library plugin, and it
 * is exactly wrong here: `fastify-plugin` exists to BREAK encapsulation so a
 * plugin's decorators and hooks reach the parent scope. §41 requires the
 * opposite — "respects encapsulation, doesn't leak scope to sibling routes".
 *
 * Unwrapped, everything registered below (the content-type parser especially)
 * is confined to this plugin's scope, so a host app's own routes keep their own
 * body parsing and their own hooks. Not depending on `fastify-plugin` also
 * keeps the dependency list at zero beyond the peer.
 */
export function fastifyMcp(options: FastifyMcpOptions): FastifyPluginAsync {
  return async (fastify: FastifyInstance): Promise<void> => {
    const defaults = resolveFacadeDefaults(options);
    const { maxRequestBodySize, maxResponseSize, deadlineMs, enableExplorer } = defaults;

    // `basePath` must equal the path the plugin is actually mounted at, because
    // the transport compares it against the request's FULL path and 404s on a
    // mismatch.
    //
    // Express cannot know its own mount path — `app.use('/mcp', router)` tells
    // the router nothing — so there the user must keep `basePath` and the mount
    // point in sync by hand, and a mismatch produces a silent 404 with no clue
    // as to which of the two was wrong.
    //
    // Fastify DOES know: `fastify.prefix` is the resolved registration prefix.
    // So the default is taken from it, and an explicit `basePath` still wins.
    // This is a deliberate behavioural divergence from Express, in the
    // direction of removing a footgun rather than adding one — and it does not
    // touch the CONFIG surface §41 requires be identical, since the same
    // options object still means the same thing on both.
    const basePath = options.basePath ?? (fastify.prefix || defaults.basePath);

    const logger = createFacadeLogger();

    const { registry, ready } = bootstrapRegistry(options.sources, options.include, logger);

    // Exposed for tests to await, mirroring the Express adapter's `_init`.
    (fastify as unknown as { _init?: Promise<void> })._init = ready;

    registerPassthroughBodyParser(fastify);

    const executors = resolveExecutors(options);

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
    } as Parameters<typeof createHttpTransport>[0]);

    const handler = transport.handler();

    registerExplorerRoute(fastify, {
      enableExplorer,
      explicitlyEnabled: options.enableExplorer === true,
      basePath,
      logger,
      registry,
      ready,
      ...(options.explorerPanels !== undefined && { explorerPanels: options.explorerPanels }),
    });

    // The MCP endpoint itself. Registered at the plugin's own root so that
    // `register(plugin, { prefix: '/mcp' })` serves `/mcp` — matching the
    // transport's `basePath`, which it compares against the full request path.
    fastify.all('/', async (request: FastifyRequest, reply: FastifyReply) => {
      // Await discovery/compile before the first request. Without it an early
      // caller races the bootstrap and sees an empty tools list, which reads as
      // "this server exposes nothing" rather than as a race.
      await ready;

      const user = extractUserContext((request as { user?: unknown }).user);
      const context: RequestContext = {
        requestId: (request.headers['x-request-id'] as string) || randomUUID(),
        ...(user !== undefined && { user }),
      };

      // Attached for handler access, mirroring Express's `req.mcpContext`.
      (request as unknown as { mcpContext?: unknown }).mcpContext = {
        ...context,
        deadline: new Date(Date.now() + deadlineMs),
      };

      // Hand the raw Node objects to the transport, having told Fastify this
      // route manages its own response.
      //
      // `hijack()` is the documented way to take over the raw socket, and it is
      // kept for that reason — but an earlier version of this comment claimed
      // that omitting it causes a double-send (ERR_STREAM_WRITE_AFTER_END).
      // That was asserted, not measured, and it is FALSE: removing this line
      // and driving a real HTTP server still returns 200 with the correct body,
      // and fires no additional `onSend` hooks. The transport ends `reply.raw`
      // before the handler returns, so Fastify's reply lifecycle finds nothing
      // left to do either way.
      //
      // So this line is correct practice and currently inert, and no test
      // distinguishes its presence — two attempts to build one (real-HTTP
      // response shape, and onSend hook firing) both showed no difference.
      // Recorded plainly rather than defended with a failure mode that does not
      // happen, because a comment that names a consequence nobody has observed
      // is how the next reader gets misled.
      reply.hijack();
      await handler(request.raw, reply.raw);
    });
  };
}

/**
 * Leave `application/json` bodies UNPARSED within this plugin's scope.
 *
 * ## Why this is the load-bearing line in the adapter
 *
 * Fastify parses JSON bodies by default; Express does not. By the time a route
 * handler runs, `request.raw` has already been drained — so the transport's
 * `readRequestBody`, which consumes the raw stream via `req.on('data')`, would
 * attach listeners to a stream that has already ended. It would never see
 * `data`, never see `end`, and its promise would never settle: the request
 * HANGS until the client times out. Not an error, not a 500 — a hang, which is
 * the hardest failure to attribute to the right layer.
 *
 * A pass-through parser hands the stream along without reading it, so the raw
 * request reaches the transport intact.
 *
 * ## Why not simply re-serialize Fastify's parsed body
 *
 * That is the obvious alternative and it quietly breaks a §41 requirement.
 * Fastify would have already buffered the whole body, so the transport's
 * `maxRequestBodySize` — which enforces by counting chunks as they arrive —
 * could no longer reject anything. The option would still be accepted, still
 * be documented, and silently enforce nothing. "Same body-size limits" would
 * be false in the one direction nobody checks.
 *
 * ## Scope
 *
 * `addContentTypeParser` is encapsulated in Fastify v4+, so this applies to
 * this plugin's routes only. A sibling route in the host app keeps Fastify's
 * normal JSON parsing — which is the encapsulation §41 asks for, and is tested.
 */
function registerPassthroughBodyParser(fastify: FastifyInstance): void {
  fastify.addContentTypeParser(
    'application/json',
    (_request: unknown, payload: unknown, done: (err: Error | null, body?: unknown) => void) => {
      // Deliberately does not read `payload`. Reading it here is what would
      // drain the stream before the transport gets it.
      done(null, payload);
    },
  );
}

/**
 * Register a default executor for spec-discovered operations, letting a
 * caller-supplied executor win per type.
 *
 * Identical policy to Express: without the default, every `tools/call` fails
 * with "No executor registered" — the registry knows the tools but nothing can
 * run them.
 */
function resolveExecutors(options: FastifyMcpOptions): Map<string, OperationExecutor> {
  const executors = new Map<string, OperationExecutor>([['http', viaHttp({})]]);
  for (const [type, executor] of options.transport?.executors ?? []) {
    executors.set(type, executor);
  }
  return executors;
}

interface ExplorerRouteOptions {
  readonly enableExplorer: boolean;
  readonly explicitlyEnabled: boolean;
  readonly basePath: string;
  readonly logger: ReturnType<typeof createFacadeLogger>;
  readonly registry: { current: () => Parameters<typeof buildExplorerViewModel>[0] };
  readonly ready: Promise<void>;
  readonly explorerPanels?: ExplorerPanelsSupplier;
}

function registerExplorerRoute(fastify: FastifyInstance, options: ExplorerRouteOptions): void {
  const { enableExplorer, explicitlyEnabled, basePath, logger, registry, ready, explorerPanels } =
    options;

  if (!enableExplorer) {
    fastify.get('/explorer', async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(404).send({ error: 'Explorer not available in production' });
    });
    return;
  }

  // §10.1 invariant 9: Explorer is off by default in production. Reaching here
  // with NODE_ENV=production means the operator opted in explicitly, so name the
  // setting that did it — the risk is not blocked, but it is loud.
  if (process.env['NODE_ENV'] === 'production' && explicitlyEnabled) {
    logger.warn(explorerProductionWarning(basePath), {
      setting: 'enableExplorer: true',
      nodeEnv: 'production',
      path: `${basePath}/explorer`,
    });
  }

  fastify.get('/explorer', async (_request: FastifyRequest, reply: FastifyReply) => {
    // Await discovery/compile so a fast first request does not render an empty
    // registry. Errors surface through the transport, not here.
    await ready.catch(() => undefined);

    const model = buildExplorerViewModel(registry.current(), basePath);

    // Resolved per request — see the same block in the Express adapter for why
    // live panel state cannot be captured once at construction (#56), and why a
    // throwing supplier degrades to the tool browser instead of 500-ing the
    // page an operator reaches for when something is already wrong.
    let panels: ExplorerPanels | undefined;
    if (explorerPanels !== undefined) {
      try {
        panels = await explorerPanels();
      } catch (error) {
        logger.warn('Explorer panel supplier threw; rendering without diagnostic panels', {
          error: error instanceof Error ? error.message : String(error),
          path: `${basePath}/explorer`,
        });
      }
    }

    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      // Dev tool: never cache, never index.
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .send(renderExplorerHtml(model, panels));
  });
}

export * from './types.js';
