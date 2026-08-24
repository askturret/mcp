// SPDX-License-Identifier: Apache-2.0
/**
 * The gateway server (#57, §11.3).
 *
 * ## What this topology is, and what it costs
 *
 * §11.3 calls the standalone gateway a SECONDARY topology and says why: it adds
 * a network hop and an auth boundary that the embedded runtime does not have.
 * It exists for adopters whose application cannot be modified, and this file is
 * the whole of it — spec in, MCP out, upstream calls over HTTP.
 *
 * ## It is the same runtime, not a reimplementation
 *
 * Discovery, compilation, the overlay pass, the dispatcher, the policy engine,
 * the audit sink and the transport are all the library's. What the gateway adds
 * is process-shaped: argument parsing, a config file, two `node:http` listeners
 * and a shutdown sequence. Nothing below decides anything §10.2 or §5.3 already
 * decides — where it looks like it might, there is a comment saying which
 * library function actually owns the rule.
 *
 * ## Two listeners, deliberately
 *
 * The MCP port carries agent traffic; the metrics port carries a scrape. They
 * are separate servers on separate ports so an operator can expose the first and
 * keep the second on an internal interface. Serving `/metrics` off the MCP port
 * would make that impossible without a proxy, and a metrics endpoint reachable
 * by anything that can reach the tool surface is a disclosure an operator did
 * not choose.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  asLegacyLogger,
  createCompiler,
  createLogger,
  jsonlAuditSink,
  loadOverlay,
  noopTracer,
  stdoutAuditSink,
  AtomicRegistryReference,
  viaHttp,
} from '@askturret/mcp-core';
import type {
  AuditSink,
  CompilerContext,
  DiscoveredOperation,
  Observability,
  OperationExecutor,
  OverlayDocument,
  StructuredLogger,
} from '@askturret/mcp-core';
import { fromOpenApi } from '@askturret/mcp-sources-openapi';
import { createHttpTransport } from '@askturret/mcp-transports';

import type { GatewayConfig } from './config.js';
import { createPrometheusRegistry, PROMETHEUS_CONTENT_TYPE, type PrometheusRegistry } from './metrics.js';
import { resolvePreset, type ResolvedPreset } from './preset.js';

/** A running gateway. */
export interface RunningGateway {
  /** Port the MCP server actually bound (differs from config when port 0 was asked for). */
  readonly port: number;
  /** Port the metrics server actually bound. */
  readonly metricsPort: number;
  readonly preset: ResolvedPreset;
  /** Operation count in the compiled registry. */
  readonly operationCount: number;
  /** Live scrape text, without going over HTTP. Used by tests and by `/metrics`. */
  renderMetrics(): string;
  /** §8.6 shutdown: drain, flush audit, close listeners. Idempotent. */
  close(): Promise<void>;
}

export interface StartGatewayOptions {
  /** Injected for tests so a suite need not reach the network or the clock. */
  readonly httpClient?: Parameters<typeof viaHttp>[0]['client'];
  /** Injected so tests can assert on logs without writing to the runner's stdout. */
  readonly logger?: StructuredLogger;
}

/**
 * Build the audit sink named by the config.
 *
 * The gateway chooses a sink; it does NOT decide whether that sink is
 * admissible. `resolvePreset` asks core, and core refuses — see preset.ts. So a
 * `stdout` sink is constructed here even under Regulated, and never reached,
 * because the preset expansion throws first.
 */
function buildAuditSink(config: GatewayConfig): AuditSink | undefined {
  switch (config.audit.sink) {
    case 'stdout':
      return stdoutAuditSink();
    case 'jsonl':
      // `path` is guaranteed present by resolveConfig — jsonl without one is
      // refused there, with a message naming the flag.
      return jsonlAuditSink({ path: config.audit.path as string });
    case 'none':
      return undefined;
  }
}

/**
 * Read and parse the overlay files, in the order given.
 *
 * `strict` mode: a malformed overlay REFUSES the boot rather than starting a
 * gateway whose tool surface silently omits the operator's customisations.
 * Overlays change what an agent is told it may do, so loading a partial one is
 * worse than not starting.
 */
async function loadOverlays(paths: readonly string[]): Promise<OverlayDocument[]> {
  const documents: OverlayDocument[] = [];
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    const { document } = loadOverlay(text, path, 'strict');
    if (document !== undefined) documents.push(document);
  }
  return documents;
}

/**
 * Compile the spec into a registry snapshot.
 *
 * This is the facade's bootstrap with two things it does not offer: overlays and
 * a preset name. `bootstrapRegistry` hardcodes `overlays: []` and
 * `preset: 'light'`, which is right for the embedded facades and wrong here —
 * §11.3 makes overlays the gateway's primary customisation surface, since an
 * adopter who cannot modify their application also cannot add code enhancements.
 */
async function compileRegistry(
  config: GatewayConfig,
  logger: StructuredLogger,
): Promise<AtomicRegistryReference> {
  const legacy = asLegacyLogger(logger);

  const source = fromOpenApi(config.spec, {
    location: config.spec,
    ...(config.upstream === undefined ? {} : { baseUrl: config.upstream }),
  });

  const discovered: DiscoveredOperation[] = [
    ...(await source.discover({ logger: legacy, abortSignal: new AbortController().signal })),
  ];

  const overlays = await loadOverlays(config.overlay);

  const context: Omit<CompilerContext, 'warnings'> = {
    logger: legacy,
    preset: config.preset,
    // `CompilerContext.overlays` is still typed as the v0.1 `Overlay`
    // (`{ id, [key: string]: unknown }`), which predates the #55 document
    // format. The apply-overlays pass documents this and re-validates every
    // entry through the SAME validator a file goes through, so the cast loses
    // no checking — `loadOverlay` above already produced a validated document,
    // and the pass will validate it again.
    overlays: overlays as unknown as CompilerContext['overlays'],
  };

  const snapshot = await createCompiler().compile(discovered, context);
  return new AtomicRegistryReference(snapshot);
}

/** Write a complete response, with the length set so the socket can be reused. */
function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Start the gateway.
 *
 * Order matters and is load-bearing: **the preset is expanded BEFORE anything
 * binds a port.** §10.2's refusals are boot-time refusals, and a gateway that
 * bound its listeners first would be briefly reachable while holding a
 * configuration the preset was about to reject. Expanding first means an
 * inadmissible configuration never serves a single request.
 */
export async function startGateway(
  config: GatewayConfig,
  options: StartGatewayOptions = {},
): Promise<RunningGateway> {
  const logger =
    options.logger ?? createLogger({ bindings: { component: 'gateway' } });

  // FIRST. See the doc comment — a RegulatedPresetRefusal thrown here means no
  // socket was ever opened.
  const preset = await resolvePreset(config);

  const registry = await compileRegistry(config, logger);
  const snapshot = registry.current();

  const metrics: PrometheusRegistry = createPrometheusRegistry();
  const observability: Observability = {
    // The gateway supplies METRICS only, and takes core's no-op tracer.
    //
    // A tracer belongs to whatever OTel SDK the operator configures — the
    // compose example wires a collector — and constructing one here would
    // export spans nobody asked to export, from a process whose whole reason
    // for existing is that its operator could not change the application.
    // §Delivery makes no-exporter the default; this is that default.
    tracer: noopTracer,
    metrics,
  };

  const auditSink = buildAuditSink(config);

  const executors = new Map<string, OperationExecutor>([
    [
      'http',
      viaHttp({
        // No constructor baseUrl: operations discovered from a spec carry their
        // own, resolved at compile time from `servers` or from `--upstream`.
        // Passing one here would silently override a multi-server spec.
        ...(options.httpClient === undefined ? {} : { client: options.httpClient }),
      }),
    ],
  ]);

  const bounds = preset.configuration?.bounds;

  const transport = createHttpTransport({
    registry,
    basePath: config.basePath,
    executors,
    observability,
    logger,
    ...(auditSink === undefined ? {} : { auditSink }),
    // Preset bounds lose to an explicit config value, because an operator who
    // typed a number meant it. Absent both, the transport's own defaults apply.
    ...(config.deadlineMs ?? bounds?.deadlineMs) === undefined
      ? {}
      : { deadlineMs: (config.deadlineMs ?? bounds?.deadlineMs) as number },
    ...(config.requestMaxBytes ?? bounds?.requestMaxBytes) === undefined
      ? {}
      : { maxRequestBodySize: (config.requestMaxBytes ?? bounds?.requestMaxBytes) as number },
    ...(config.responseMaxBytes ?? bounds?.responseMaxBytes) === undefined
      ? {}
      : { maxResponseSize: (config.responseMaxBytes ?? bounds?.responseMaxBytes) as number },
    // The composed policy from the preset expansion. Light supplies none, which
    // is the same "no filtering" the embedded facades give by default.
    ...(preset.configuration === undefined
      ? {}
      : {
          authorizationPolicy: preset.configuration.authorization.policy,
          visibilityPolicy: preset.configuration.authorization.policy,
        }),
  });

  const handler = transport.handler();

  const mcpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0] ?? '';

    // Health endpoints are served here rather than on the metrics port: a
    // container orchestrator probes the port it routes traffic to, and a
    // readiness check answered by a different listener can report healthy while
    // the one carrying requests is wedged.
    if (path === '/health/live') {
      void transport.liveness().then((report) => {
        // `httpStatus` is the report's own decision (200 or 503). Re-deriving
        // it from `ready` here would be a second place for the mapping to live.
        send(res, report.httpStatus, 'application/json', JSON.stringify(report));
      });
      return;
    }
    if (path === '/health/ready') {
      const report = transport.readiness();
      send(res, report.httpStatus, 'application/json', JSON.stringify(report));
      return;
    }

    if (!path.startsWith(config.basePath)) {
      send(res, 404, 'application/json', JSON.stringify({ error: { code: -32601, message: 'Not found' } }));
      return;
    }

    (req as { mcpContext?: unknown }).mcpContext = {
      requestId: (req.headers['x-request-id'] as string) || randomUUID(),
    };

    void handler(req, res);
  });

  const metricsServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path !== config.metricsPath) {
      send(res, 404, 'text/plain; charset=utf-8', 'Not found\n');
      return;
    }
    send(res, 200, PROMETHEUS_CONTENT_TYPE, metrics.render());
  });

  await listen(mcpServer, config.port, config.host);
  await listen(metricsServer, config.metricsPort, config.host);

  logger.info('Gateway listening', {
    port: boundPort(mcpServer),
    metricsPort: boundPort(metricsServer),
    preset: preset.name,
    operations: snapshot.operations.size,
    basePath: config.basePath,
  });

  let closed: Promise<void> | undefined;

  return {
    port: boundPort(mcpServer),
    metricsPort: boundPort(metricsServer),
    preset,
    operationCount: snapshot.operations.size,
    renderMetrics: () => metrics.render(),
    close(): Promise<void> {
      // Idempotent: two concurrent shutdowns would double-flush the audit sink
      // and race to close the same listeners (§8.6).
      closed ??= (async () => {
        await transport.close();
        await Promise.all([closeServer(mcpServer), closeServer(metricsServer)]);
      })();
      return closed;
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Idle keep-alive sockets hold `close` open indefinitely. Without this a
    // shutdown waits on a connection nobody is using, and a test suite hangs.
    server.closeIdleConnections?.();
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}
