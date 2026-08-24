// SPDX-License-Identifier: Apache-2.0
/**
 * MCP Streamable HTTP transport adapter.
 *
 * Implements the JSON-RPC endpoints directly — session management, host
 * validation, protocol negotiation, and dispatch into AskTurret's own
 * dispatcher.
 *
 * ## The SDK boundary (#61, §12.3, §17 criterion 11)
 *
 * This package is the ONLY one permitted to import `@modelcontextprotocol/sdk`,
 * and that is now ENFORCED rather than observed: see
 * `.github/scripts/check-sdk-boundary.mjs`, which fails CI on an import from
 * anywhere else and on any SDK type reaching a published `.d.ts`. The previous
 * note here said enforcement was "planned but not yet configured" and that the
 * boundary was "maintained by convention and code review" — it is not any more.
 *
 * A correction while we are here: an earlier version of this header said this
 * module "wraps the official MCP TypeScript SDK's Streamable HTTP server". It
 * does not. The JSON-RPC handling below is written by hand, and the SDK is not
 * called at runtime at all. That mattered enough to fix, because a reader
 * trusting the old sentence would look for SDK behaviour that is not here — and
 * would over-estimate how much an SDK upgrade actually touches.
 */

import { randomUUID } from 'crypto';
import type {
  RegistrySnapshot,
  CommandDispatcher,
  OperationCommand,
  MCPResult,
  ClientInfo,
  VisibilityEngine,
} from '@askturret/mcp-core';
import type {
  BreakerStats,
  HealthReport,
  ReloadController,
  ShutdownResult,
} from '@askturret/mcp-core';
import {
  DEFAULT_LIVENESS_BUDGET_MS,
  createAuthorizationEngine,
  createDispatcher,
  createShutdownCoordinator,
  createVisibilityEngine,
  evaluateLiveness,
  evaluateReadiness,
  negotiateProtocolVersion,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from '@askturret/mcp-core';
import type { DivergenceState } from '@askturret/mcp-core';
import type {
  HttpTransport,
  HttpTransportOptions,
  SessionStore,
  SessionData,
} from './types.js';
import { createInMemorySessionStore } from './session-store.js';

// MCP SDK imports — ONLY here, nowhere else in the codebase.
//
// This single type import is currently the entire SDK surface the project
// touches, and it is UNUSED: nothing below references `Server`. It is kept
// deliberately rather than deleted, because it is what makes the boundary
// guard's happy path a real assertion — with zero SDK imports anywhere, the
// guard would pass on a repository that had simply removed the dependency, and
// "the boundary holds" would be indistinguishable from "there is no boundary".
//
// Being honest about the consequence: the SDK is not exercised at runtime, so
// the isolation this file claims is currently cheap to hold. See the upgrade
// drill in docs/architecture-overview.md, which reports that fact rather than
// implying a stronger result than the code supports.
//
// The `_` prefix is what exempts this from `noUnusedLocals`, and it replaces a
// `@ts-expect-error` whose stated reason was wrong: the comment claimed the SDK
// "may not be installed during development", but the directive was actually
// suppressing "declared but never read". The SDK resolves fine — removing the
// directive is what proved it, since TypeScript then reported the directive
// itself as unused.
import type { Server as _McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * Create an HTTP transport adapter
 *
 * @param options - Transport configuration
 * @returns HttpTransport instance
 */
export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  return new StreamableHttpTransport(options);
}

/**
 * The request body exceeded `maxRequestBodySize` (#125).
 *
 * A distinct type rather than a flag on a generic `Error`, because the handler
 * has to separate this from a genuine socket failure: one is a client-
 * correctable condition that deserves a `413`, the other is an internal fault
 * that must keep its `500`. Collapsing them is the defect this fixes, and
 * matching on `error.message` would reintroduce it the first time somebody
 * rewords the string.
 */
class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds the ${maxBytes} byte limit`);
    this.name = 'RequestBodyTooLargeError';
  }
}

/**
 * Streamable HTTP transport implementation
 */
class StreamableHttpTransport implements HttpTransport {
  private readonly registry;
  /**
   * In-flight tool calls, keyed by the client's JSON-RPC envelope id (#44).
   *
   * ## What this can and cannot do
   *
   * `notifications/cancelled` arrives as a SEPARATE HTTP POST. In a stateless
   * multi-instance deployment that POST may land on a different process than
   * the call it names, and this map is per-process — so cancellation is
   * best-effort across instances. Making it work everywhere needs shared
   * state, which is a session-store concern and not this issue's.
   *
   * Stated rather than implied: a cancellation that silently did nothing,
   * with no way to tell that apart from one that worked, would be worse than
   * none at all. `handleCancelled` therefore reports whether it found the call.
   */
  private readonly inFlightCalls = new Map<string, AbortController>();

  private readonly dispatcher: CommandDispatcher;
  private readonly basePath: string;
  private readonly sessionStore: SessionStore | null;
  private readonly allowedHosts: Set<string>;
  private readonly deadlineMs: number;
  private readonly maxRequestBodySize: number;
  private readonly maxResponseSize: number;
  private readonly visibility: VisibilityEngine | null;

  /** §8.6 lifecycle. Built lazily so the hooks can close over `this`. */
  private readonly lifecycle: ReturnType<typeof createShutdownCoordinator>;
  private readonly reload: ReloadController | undefined;
  private readonly enforceDependencies: boolean;
  private readonly auditSinkReachable: (() => boolean) | undefined;
  private readonly registryDivergence: (() => DivergenceState) | undefined;
  private readonly livenessBudgetMs: number;

  /**
   * Resolves when the last in-flight call finishes.
   *
   * Rebuilt on demand rather than kept as a live counter: drain happens once,
   * and a counter maintained on every request would be a hot-path cost paid
   * continuously for a value read at most once per process.
   */
  private drainWaiters: (() => void)[] = [];

  constructor(options: HttpTransportOptions) {
    this.registry = options.registry;
    // Call-time authorization (stage 3). Absent policy means unchanged
    // behaviour: the dispatcher falls back to the authorize hook.
    const authorization = options.authorizationPolicy
      ? createAuthorizationEngine({
          policy: options.authorizationPolicy,
          ...(options.authorization?.confirmations === undefined
            ? {}
            : { confirmations: options.authorization.confirmations }),
          ...(options.authorization?.metrics === undefined
            ? {}
            : { metrics: options.authorization.metrics }),
          ...(options.authorization?.timings === undefined
            ? {}
            : { timings: options.authorization.timings }),
        })
      : undefined;

    this.dispatcher = createDispatcher(
      options.registry,
      options.hooks,
      options.executors,
      {
        ...(authorization === undefined ? {} : { authorization }),
        ...(options.bulkheads === undefined ? {} : { bulkheads: options.bulkheads }),
        ...(options.retry === undefined ? {} : { retry: options.retry }),
        ...(options.breakers === undefined ? {} : { breakers: options.breakers }),
        ...(options.auditSink === undefined ? {} : { auditSink: options.auditSink }),
        // Without these two the dispatcher fell back to its no-op tracer and
        // no-op recorder no matter what an adapter was handed — the option
        // existed on DispatcherOptions with nothing routing to it (#57).
        ...(options.observability === undefined ? {} : { observability: options.observability }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
    );

    // No policy configured means no filtering, which is the behaviour that
    // existed before this option — adding the option must not change what an
    // existing caller sees.
    this.visibility = options.visibilityPolicy
      ? createVisibilityEngine({
          policy: options.visibilityPolicy,
          ...(options.visibility?.ttlMs === undefined ? {} : { ttlMs: options.visibility.ttlMs }),
          ...(options.visibility?.maxEntries === undefined
            ? {}
            : { maxEntries: options.visibility.maxEntries }),
          ...(options.visibility?.policyVersion === undefined
            ? {}
            : { policyVersion: options.visibility.policyVersion }),
          ...(options.visibility?.metrics === undefined
            ? {}
            : { metrics: options.visibility.metrics }),
        })
      : null;
    this.basePath = options.basePath ?? '/mcp';
    this.deadlineMs = options.deadlineMs ?? 30000;
    this.maxRequestBodySize = options.maxRequestBodySize ?? 1048576; // 1 MiB
    this.maxResponseSize = options.maxResponseSize ?? 1048576; // 1 MiB

    // Session store setup
    if (options.session === 'inMemory') {
      this.sessionStore = createInMemorySessionStore();
    } else if (options.session) {
      this.sessionStore = options.session;
    } else {
      this.sessionStore = null; // Stateless
    }

    // Host-header validation (DNS rebinding mitigation)
    const defaultHosts = ['localhost', '127.0.0.1', '[::1]'];
    this.allowedHosts = new Set(options.allowedHosts ?? defaultHosts);

    this.reload = options.reload;
    this.enforceDependencies = options.enforceDependencies ?? false;
    this.auditSinkReachable = options.auditSinkReachable;
    this.registryDivergence = options.registryDivergence;
    this.livenessBudgetMs = options.livenessBudgetMs ?? DEFAULT_LIVENESS_BUDGET_MS;

    this.lifecycle = createShutdownCoordinator({
      // Phase 1 and 2 need no work here: readiness reads
      // `lifecycle.isShuttingDown`, which the coordinator sets before the
      // first phase runs, and `handler()` reads the same flag to start
      // returning 503. Both are therefore true the instant shutdown begins,
      // which is stricter than flipping them inside the phases.
      // Phase 3 (cancel-queued) has NO hook here, deliberately.
      //
      // §8.6 separates "queued" from "in-flight", but this transport has no
      // queue of its own: a call is either accepted and tracked in
      // `inFlightCalls`, or it has not arrived. The only real queue is the
      // dispatcher's bulkhead (#43), and from the transport's side a
      // bulkhead-queued call is indistinguishable from a running one — both
      // are awaiting the same `dispatch()` promise.
      //
      // Supplying a hook that aborted everything would collapse phase 3 into
      // phase 4 and cancel calls that were about to succeed. So the phase
      // runs with nothing to do and is recorded as such, which is the honest
      // report. Flagged for QA: a transport that grows its own admission
      // queue must fill this in. See #156.
      drainInFlight: () => this.waitForDrain(),
      cancelInFlight: () => this.abortAllInFlight('drain-deadline'),
      // An explicit hook wins; otherwise the configured sink IS the flush.
      // Without this default, an adopter could configure a sink, reach
      // shutdown, and have phase 5 flush nothing — the exact gap #48 exists
      // to close.
      flushAudit: () =>
        options.flushAudit?.() ?? options.auditSink?.flush() ?? Promise.resolve(),
      flushTelemetry: () => options.flushTelemetry?.() ?? Promise.resolve(),
      closeResources: () => options.closeResources?.() ?? Promise.resolve(),
    });
  }

  handler() {
    return async (req: any, res: any) => {
      try {
        // Host-header validation (DNS rebinding mitigation)
        const host = req.headers.host || req.headers[':authority'];
        if (!this.isHostAllowed(host)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: -32600,
                message: 'Invalid Host header',
              },
            }),
          );
          return;
        }

        // Route by method and path
        const rawPath = (req as any).originalUrl ?? req.url ?? '/';
        const url = new URL(rawPath, `http://${host}`);

        // Health endpoints are served BEFORE the shutdown gate below, and
        // that ordering is the whole point: during a drain the load balancer
        // needs `/ready` to answer 503 deliberately. If the gate came first,
        // readiness would return the generic "shutting down" rejection for
        // every path alike and the probe would be indistinguishable from an
        // instance that had simply stopped responding.
        if (url.pathname === `${this.basePath}/health/live`) {
          await this.respondHealth(res, await this.liveness());
          return;
        }

        if (url.pathname === `${this.basePath}/health/ready`) {
          await this.respondHealth(res, this.readiness());
          return;
        }

        if (url.pathname !== this.basePath) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: -32601, message: 'Not found' } }));
          return;
        }

        // §8.6 phase 2 — stop accepting new calls. Existing in-flight calls
        // continue and are drained; only NEW work is turned away.
        if (this.lifecycle.isShuttingDown) {
          res.writeHead(503, {
            'Content-Type': 'application/json',
            // Tells a well-behaved client and most load balancers to retry
            // elsewhere rather than treating this as a hard failure.
            Connection: 'close',
          });
          res.end(
            JSON.stringify({
              error: { code: -32000, message: 'Server is shutting down' },
            }),
          );
          return;
        }

        if (req.method === 'POST') {
          await this.handleJsonRpc(req, res);
        } else if (req.method === 'GET') {
          await this.handleSse(req, res);
        } else if (req.method === 'DELETE') {
          await this.handleSessionTermination(req, res);
        } else {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: -32601, message: 'Method not allowed' } }));
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: -32603,
              message: 'Internal server error',
            },
          }),
        );
      }
    };
  }

  /**
   * Write a health report.
   *
   * The body carries the machine-readable `reason` as well as the detail, so
   * an operator paging at 3am gets the cause from the probe itself rather
   * than having to correlate a bare 503 against logs — which is §8.7's
   * "returns 503 with a diagnostic body describing the degradation".
   */
  private async respondHealth(res: any, report: HealthReport): Promise<void> {
    res.writeHead(report.httpStatus, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: report.ready ? 'ok' : 'unavailable',
        ...(report.reason === undefined ? {} : { reason: report.reason }),
        ...(report.detail === undefined ? {} : { detail: report.detail }),
      }),
    );
  }

  private isHostAllowed(host: string | undefined): boolean {
    if (!host) {
      return false;
    }

    // Strip port if present
    const hostname = host.split(':')[0] || host;
    return this.allowedHosts.has(hostname);
  }

  private async handleJsonRpc(req: any, res: any): Promise<void> {
    // Read request body with size limit
    let body: string;
    try {
      body = await this.readRequestBody(req, this.maxRequestBodySize);
    } catch (error) {
      if (!(error instanceof RequestBodyTooLargeError)) {
        // A real I/O failure. Rethrow so it keeps the 500 it deserves —
        // narrowing to the size case is the entire point of the typed error.
        throw error;
      }

      // 413 with a specific code, mirroring the response-side OUTPUT_TOO_LARGE
      // path below (#125). Previously this fell through to the generic handler
      // catch and surfaced as 500 / -32603 "Internal server error", telling a
      // client that its own oversized payload was a server fault.
      //
      // `id: null` because the body never parsed, so there is no request id to
      // echo. JSON-RPC says to use null when the id cannot be determined —
      // omitting the field would be the one thing that is definitely wrong.
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: 'REQUEST_TOO_LARGE',
            message: 'Request exceeds size limit',
          },
        }),
      );
      return;
    }

    let jsonRpcRequest;
    try {
      jsonRpcRequest = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: -32700,
            message: 'Parse error',
          },
        }),
      );
      return;
    }

    // Extract session ID from headers (if sessions enabled)
    const sessionId = this.sessionStore ? this.getSessionId(req) : null;

    // Handle JSON-RPC method
    // Cancel in-flight work when the CLIENT goes away (#42 conformance
    // category 4).
    //
    // Before this, the per-request AbortController was aborted only by the
    // deadline timer, so a client that disconnected left the executor running
    // and the upstream call in flight — the work continued with nobody left to
    // receive it. The adapter conformance suite found this on both Express and
    // Fastify identically, which is what located it here in the transport
    // rather than in either adapter.
    //
    // Keyed on `res` closing rather than `req`: `req` emits 'close' on a
    // NORMAL request once its body has been consumed, so aborting on that
    // would cancel every healthy call. `res` closing with `writableEnded`
    // false means the response never finished — the client is gone.
    const clientAbort = new AbortController();
    const onResponseClosed = (): void => {
      if (res.writableEnded !== true) clientAbort.abort();
    };
    res.on?.('close', onResponseClosed);

    let response;
    try {
      response = await this.handleMethod(jsonRpcRequest, sessionId, clientAbort.signal);
    } finally {
      res.off?.('close', onResponseClosed);
    }

    // Check response size
    const responseBody = JSON.stringify(response);
    if (responseBody.length > this.maxResponseSize) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: jsonRpcRequest.id,
          error: {
            code: 'OUTPUT_TOO_LARGE',
            message: 'Response exceeds size limit',
          },
        }),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(responseBody);
  }

  private async handleMethod(
    request: any,
    sessionId: string | null,
    clientSignal?: AbortSignal,
  ): Promise<any> {
    const { method, params, id } = request;

    try {
      switch (method) {
        case 'initialize':
          return await this.handleInitialize(id, params, sessionId);

        case 'tools/list':
          return await this.handleToolsList(id, sessionId);

        case 'tools/call':
          return await this.handleToolsCall(id, params, sessionId, clientSignal);

        case 'ping':
          return { jsonrpc: '2.0', id, result: { status: 'ok' } };

        case 'notifications/cancelled':
          return this.handleCancelled(id, params);

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'Internal error',
        },
      };
    }
  }

  private async handleInitialize(id: any, params: any, sessionId: string | null): Promise<any> {
    // Actually negotiate, rather than announce (#61). Before this the client's
    // requested version was read and discarded: a client asking for a protocol
    // we do not speak was told "2024-11-05" and allowed to proceed, which fails
    // later as a confusing shape mismatch instead of here as a clear refusal.
    const negotiation = negotiateProtocolVersion(params?.protocolVersion);

    if (!negotiation.ok) {
      // REFUSED, as a JSON-RPC error — never process.exit().
      //
      // This runs inside an adopter's own server process. Exiting would let a
      // remote client halt every unrelated route in their application by
      // sending one wrong field, which turns a compatibility check into a
      // denial-of-service primitive. The session simply does not start.
      return {
        jsonrpc: '2.0',
        id,
        error: {
          // -32602 "Invalid params": the request was well-formed JSON-RPC and
          // one of its parameters is unacceptable, which is exactly this.
          code: -32602,
          message: negotiation.reason,
          data: {
            requested: negotiation.requested,
            supported: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
          },
        },
      };
    }

    const protocolVersion = negotiation.version;

    // Store session data if sessions enabled
    if (this.sessionStore && sessionId) {
      const sessionData: SessionData = {
        clientInfo: params.clientInfo,
        // Recorded so every later call on this session can stamp the version
        // the session actually negotiated (#61).
        protocolVersion,
        createdAt: new Date(),
        lastActivityAt: new Date(),
      };
      await this.sessionStore.set(sessionId, sessionData);
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        serverInfo: {
          name: '@askturret/mcp',
          version: '0.1.0',
        },
        capabilities: {
          tools: {},
        },
      },
    };
  }

  private async handleToolsList(id: any, sessionId: string | null): Promise<any> {
    // Update session activity if sessions enabled, and capture clientInfo the
    // same way handleToolsCall does — it was already fetched here and simply
    // discarded before the visibility policy had a use for it.
    let clientInfo: ClientInfo | undefined;
    if (this.sessionStore && sessionId) {
      const session = await this.sessionStore.get(sessionId);
      if (session) {
        await this.sessionStore.set(sessionId, {
          ...session,
          lastActivityAt: new Date(),
        });
        clientInfo = session.clientInfo;
      }
    }

    // Get current registry snapshot. Read once per request: the registry
    // reference has no swap notification, so the snapshot hash read here is
    // what keys the visibility cache, and a swap simply produces a new key.
    const snapshot: RegistrySnapshot = this.registry.current();

    // NOTE: no principal is available at discovery time in v0.1. The
    // authenticate hook runs on the CALL path only (dispatcher), and nothing
    // carries a Principal onto the session, so `principal` is necessarily
    // undefined here. A policy built from `authenticated()` therefore hides
    // EVERY tool at discovery. See the PR for #34.
    const operations = this.visibility
      ? await this.visibility.visibleOperations({
          snapshot,
          ...(clientInfo === undefined ? {} : { clientInfo }),
        })
      : Array.from(snapshot.operations.values());

    // Convert operations to MCP tools format
    const tools = operations.map((op) => ({
      name: op.name,
      description: op.description,
      inputSchema: op.input,
    }));

    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools,
      },
    };
  }

  /**
   * `notifications/cancelled` — client-initiated cancellation (§44).
   *
   * Fires the AbortController for the named request, which reaches the
   * executor's `signal` and, through `viaHttp`, the socket itself.
   */
  private handleCancelled(id: any, params: any): any {
    const target = params?.requestId;
    const controller =
      target === undefined || target === null
        ? undefined
        : this.inFlightCalls.get(String(target));

    controller?.abort();

    // JSON-RPC notifications carry no id and expect no response, but this
    // transport is request/response over POST and must write something. The
    // body reports whether a matching call was actually found — see the note
    // on `inFlightCalls` for why "cancelled nothing" must be distinguishable
    // from "cancelled successfully".
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      result: { cancelled: controller !== undefined },
    };
  }

  private async handleToolsCall(
    id: any,
    params: any,
    sessionId: string | null,
    clientSignal?: AbortSignal,
  ): Promise<any> {
    // Update session activity and get client info if sessions enabled
    let clientInfo;
    let protocolVersion: string | undefined;
    if (this.sessionStore && sessionId) {
      const session = await this.sessionStore.get(sessionId);
      if (session) {
        await this.sessionStore.set(sessionId, {
          ...session,
          lastActivityAt: new Date(),
        });
        clientInfo = session.clientInfo;
        // The version THIS session negotiated, carried to the span (#61).
        protocolVersion = session.protocolVersion;
      }
    }

    // Get current registry snapshot
    const snapshot: RegistrySnapshot = this.registry.current();

    // Build OperationCommand with full context
    const deadline = new Date(Date.now() + this.deadlineMs);
    const abortController = new AbortController();

    // Link the client's disconnect to this call's cancellation. Checked for an
    // already-aborted signal first: a client that vanished while the body was
    // being read would otherwise never fire 'abort' again.
    // Register for explicit client cancellation (#44). Keyed on the client's
    // JSON-RPC envelope id, because that is what `notifications/cancelled`
    // names — NOT the internal `requestId`, which the client has never seen.
    if (id !== undefined && id !== null) {
      this.inFlightCalls.set(String(id), abortController);
    }

    if (clientSignal) {
      if (clientSignal.aborted) {
        abortController.abort();
      } else {
        clientSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }
    const requestId = params.id || randomUUID();
    const traceId = params._meta?.traceId || randomUUID();

    const command: OperationCommand = {
      requestId,
      traceId,
      ...(clientInfo !== undefined && { clientInfo }),
      // Sessionless mode has no negotiation to report, so the dispatcher's
      // announced default applies — which is the same value, from the same
      // module. Left absent rather than filled in here so there is exactly one
      // place that decides the fallback.
      ...(protocolVersion !== undefined && { protocolVersion }),
      operationId: params.name,
      input: params.arguments || {},
      deadline,
      signal: abortController.signal,
      registryHash: snapshot.hash,
    };

    // Enforce deadline using Promise.race (same pattern as viaHandler fix in #14)
    const deadlineMs = deadline.getTime() - Date.now();
    let timeoutId: NodeJS.Timeout | undefined;

    const dispatchPromise = this.dispatcher.dispatch(command);
    const timeoutPromise = new Promise<MCPResult>((resolve) => {
      timeoutId = setTimeout(() => {
        // Settle the race BEFORE aborting, not after.
        //
        // `abort()` dispatches its event SYNCHRONOUSLY, so the cancel branch
        // below resolves inside this call — and if that happened first, the
        // race settled as CANCELLED and this TIMEOUT was dead code on every
        // deadline expiry. The client then could not tell "you ran out of
        // time" from "someone cancelled you": one is a property of their own
        // request that they may retry, the other is a decision the server
        // made about it. Same class as the UNAUTHENTICATED/FORBIDDEN
        // collapse in #124.
        //
        // Ordering is the whole fix. `Promise.race` keeps the FIRST
        // settlement, so resolving here makes the deadline win its own race,
        // while an abort from anywhere else (shutdown drain §8.6,
        // notifications/cancelled) still resolves as CANCELLED because this
        // timer never fired. Both causes stay distinguishable.
        resolve({
          isError: true,
          error: {
            code: 'TIMEOUT',
            message: 'Request exceeded deadline',
          },
        });
        abortController.abort(); // Still signal the executor to stop working.
      }, deadlineMs);
    });

    // Cancellation resolves the race too (§8.6 drain deadline, §44).
    //
    // Aborting the controller only SIGNALS the executor; it does not settle
    // the dispatch promise, and an executor that ignores its signal keeps the
    // race pending until the deadline. Before this, a shutdown that cancelled
    // a hung call still left the client waiting the full deadline for an
    // answer — §8.6 requires those calls to "receive CANCELLED".
    //
    // The executor may keep running afterwards; JavaScript cannot cancel an
    // in-flight promise. That is already true of the deadline branch above,
    // and answering the client promptly is the point of both.
    let onAbort: (() => void) | undefined;
    const cancelPromise = new Promise<MCPResult>((resolve) => {
      onAbort = () =>
        resolve({
          isError: true,
          error: { code: 'CANCELLED', message: 'Request cancelled' },
        });
      if (abortController.signal.aborted) onAbort();
      else abortController.signal.addEventListener('abort', onAbort, { once: true });
    });

    // Race dispatch against deadline and cancellation
    let result: MCPResult;
    try {
      result = await Promise.race([dispatchPromise, timeoutPromise, cancelPromise]);
    } finally {
      if (onAbort !== undefined) {
        abortController.signal.removeEventListener('abort', onAbort);
      }
      // Deregister on EVERY exit path. A leaked entry keeps an AbortController
      // alive for a call that has already finished, and a later
      // notifications/cancelled naming a recycled id would abort the wrong
      // thing — a cancellation that lands on someone else's request is worse
      // than one that lands nowhere.
      if (id !== undefined && id !== null) {
        this.inFlightCalls.delete(String(id));
      }
      // Release a waiting drain (§8.6 phase 4) here rather than at the abort
      // site: an aborted call is not finished, it is unwinding, and a drain
      // that resolved on `abort()` would report the server quiet while
      // handlers were still running.
      this.releaseDrainIfIdle();
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    // Map to MCP wire format
    // Note: `id` here is the client's JSON-RPC envelope id, distinct from
    // `requestId`, which is the internal dispatcher/command trace id.
    if (result.isError) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: result.error!.code,
          message: result.error!.message,
          // `details` is the only channel a CONFIRMATION_REQUIRED challenge has
          // to reach the caller, and it was being dropped here — so a client
          // was told to confirm without being told what to confirm. The field
          // is already documented as safe for transport (OperationError), and
          // the dispatcher redacts before it gets here.
          ...(result.error!.details === undefined ? {} : { data: result.error!.details }),
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.content),
          },
        ],
      },
    };
  }

  private async handleSse(req: any, res: any): Promise<void> {
    // v0.1: SSE heartbeat/ping only
    // Full bi-directional SSE support deferred to v0.2

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send periodic heartbeat
    const interval = setInterval(() => {
      res.write('event: ping\ndata: {}\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(interval);
    });
  }

  private async handleSessionTermination(req: any, res: any): Promise<void> {
    if (!this.sessionStore) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    const sessionId = this.getSessionId(req);
    if (sessionId) {
      await this.sessionStore.delete(sessionId);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }

  private getSessionId(req: any): string | null {
    // Try X-Session-ID header first
    let sessionId = req.headers['x-session-id'];
    if (sessionId) {
      return sessionId;
    }

    // Try Cookie header
    const cookie = req.headers.cookie;
    if (cookie) {
      const match = cookie.match(/sessionId=([^;]+)/);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  private async readRequestBody(req: any, maxSize: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxSize) {
          // A TYPED rejection, not a bare Error (#125). The caller has to tell
          // "the client sent too much" from "the socket failed", and matching on
          // a message string would silently start misclassifying the day
          // somebody reworded it.
          reject(new RequestBodyTooLargeError(maxSize));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });

      req.on('error', reject);
    });
  }

  /**
   * Graceful shutdown (§8.6). Idempotent — see the coordinator.
   */
  async close(options: { drainMs?: number } = {}): Promise<ShutdownResult> {
    return this.lifecycle.shutdown(
      options.drainMs === undefined ? {} : { drainMs: options.drainMs },
    );
  }

  /** Immediate close: skip the drain, still attempt the audit flush (§8.6). */
  async forceClose(): Promise<ShutdownResult> {
    return this.lifecycle.shutdown({ force: true });
  }

  /**
   * Retained for API compatibility — `close()` is the §8.6 entry point.
   *
   * This was an empty stub before #47, so anything already calling it got no
   * shutdown at all. Pointing it at the real sequence is strictly better than
   * leaving it inert, and better than deleting it and breaking a caller.
   */
  async shutdown(): Promise<void> {
    await this.close();
  }

  /** Cached readiness (§8.7). Never probes a dependency. */
  readiness(): HealthReport {
    const report = evaluateReadiness({
      shuttingDown: this.lifecycle.isShuttingDown,
      hasRegistrySnapshot: this.hasRegistrySnapshot(),
      enforceDependencies: this.enforceDependencies,
      breakers: this.dispatcher.breakerStats(),
      // Option B (#64). Reads the monitor's cached verdict; never probes.
      ...(this.registryDivergence === undefined
        ? {}
        : { divergence: this.registryDivergence() }),
      ...(this.reload === undefined ? {} : { reload: this.reload.readiness() }),
      ...(this.auditSinkReachable === undefined
        ? {}
        : { auditSinkReachable: this.auditSinkReachable() }),
    });

    // §11.2 / #64: the hash goes on the body whether or not the instance is
    // ready. Comparing it across pods by hand is how divergence gets diagnosed
    // when neither detector is wired, and a field that only appeared on failure
    // would be missing exactly when someone went looking for it.
    const registryHash = this.currentRegistryHash();
    return registryHash === undefined ? report : { ...report, registryHash };
  }

  /** This instance's registry hash, or undefined when no snapshot is published. */
  private currentRegistryHash(): string | undefined {
    try {
      return this.registry.current()?.hash;
    } catch {
      return undefined;
    }
  }

  /** Event-loop responsiveness (§8.7). */
  async liveness(): Promise<HealthReport> {
    return evaluateLiveness(this.livenessBudgetMs);
  }

  /** Breaker state, forwarded from the dispatcher (#46). */
  breakerStats(): readonly BreakerStats[] {
    return this.dispatcher.breakerStats();
  }

  private hasRegistrySnapshot(): boolean {
    try {
      const snapshot = this.registry.current();
      return snapshot !== undefined && snapshot !== null;
    } catch {
      // A registry reference that throws is exactly the "no valid snapshot"
      // condition, not an internal error to propagate into a health probe.
      return false;
    }
  }

  /**
   * Resolve once no call is in flight.
   *
   * Checked first so a shutdown with an idle server returns immediately
   * rather than waiting for a completion that will never come.
   */
  private waitForDrain(): Promise<void> {
    if (this.inFlightCalls.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  /** Called whenever a call finishes, to release a waiting drain. */
  private releaseDrainIfIdle(): void {
    if (this.inFlightCalls.size > 0) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Abort every in-flight call.
   *
   * Aborting the controller is what makes the call return `CANCELLED` rather
   * than hanging until its own deadline — §8.6's drain-deadline case, where
   * "hung calls receive CANCELLED".
   */
  private abortAllInFlight(_reason: string): void {
    for (const controller of this.inFlightCalls.values()) {
      controller.abort();
    }
    // The aborted calls still have to unwind before their `finally` blocks
    // remove them from the map, so drain waiters are released there, not here.
  }
}
