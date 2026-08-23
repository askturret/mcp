// SPDX-License-Identifier: Apache-2.0
/**
 * Shutdown and health endpoints through the REAL transport (§8.6, §8.7, #47).
 *
 * `shutdown.test.ts` in core proves the sequence order; `health.test.ts`
 * proves the readiness rules. This proves the transport is wired to both:
 * that the endpoints are actually routed, that new calls are refused during a
 * drain, and that in-flight calls really do complete before `close()` returns.
 */

import { describe, it, expect } from '@jest/globals';

import { createHttpTransport } from './index.js';
import {
  AtomicRegistryReference,
  viaHandler,
  type OperationDefinition,
  type OperationExecutor,
  type RegistrySnapshot,
} from '@askturret/mcp-core';

class MockRequest {
  headers: Record<string, string> = { host: 'localhost' };
  method = 'POST';
  url = '/mcp';
  private chunks: Buffer[] = [];

  setBody(body: string) {
    this.chunks = [Buffer.from(body, 'utf-8')];
  }

  on(event: string, handler: (data?: any) => void) {
    if (event === 'data') this.chunks.forEach((chunk) => handler(chunk));
    else if (event === 'end') handler();
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(body?: string) {
    if (body !== undefined) this.body += body;
  }

  write(data: string) {
    this.body += data;
  }

  json(): any {
    return JSON.parse(this.body);
  }
}

function operation(): OperationDefinition {
  return {
    id: 'slow',
    name: 'slow',
    description: 'slow',
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'handler' },
  };
}

function registry(): AtomicRegistryReference {
  const snapshot: RegistrySnapshot = {
    hash: 'test-hash',
    operations: new Map([['slow', operation()]]),
    version: 1,
    createdAt: new Date(),
  };
  return new AtomicRegistryReference(snapshot);
}

/** A transport whose handler blocks until the returned gate is released. */
function gatedTransport(
  options: Record<string, unknown> = {},
): {
  transport: ReturnType<typeof createHttpTransport>;
  release: () => void;
  entered: () => number;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;

  const executors = new Map<string, OperationExecutor>([
    [
      'handler',
      viaHandler(async () => {
        entered += 1;
        await gate;
        return { ok: true };
      }),
    ],
  ]);

  const transport = createHttpTransport({
    registry: registry(),
    basePath: '/mcp',
    executors,
    ...options,
  } as any);

  return { transport, release, entered: () => entered };
}

/** Fire a tools/call without awaiting it. */
function callTool(transport: ReturnType<typeof createHttpTransport>, id: string) {
  const req = new MockRequest();
  const res = new MockResponse();
  req.setBody(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'slow', arguments: {} },
    }),
  );
  const done = transport.handler()(req as any, res as any).then(() => res);
  return { res, done };
}

async function get(transport: ReturnType<typeof createHttpTransport>, path: string) {
  const req = new MockRequest();
  req.method = 'GET';
  req.url = path;
  const res = new MockResponse();
  await transport.handler()(req as any, res as any);
  return res;
}

describe('/health endpoints are routed (§8.7)', () => {
  it('serves /health/live with 200 on a responsive process', async () => {
    const { transport } = gatedTransport();

    const res = await get(transport, '/mcp/health/live');

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('serves /health/ready with 200 when a snapshot is published', async () => {
    const { transport } = gatedTransport();

    const res = await get(transport, '/mcp/health/ready');

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('does not treat the health paths as the MCP endpoint', async () => {
    // They sit under basePath, so a router that only compared prefixes would
    // send them to the JSON-RPC handler and answer with a parse error.
    const { transport } = gatedTransport();

    expect((await get(transport, '/mcp/health/live')).json()).toHaveProperty('status');
  });
});

describe('shutdown gate (§8.6 phases 1-2)', () => {
  it('refuses NEW calls with 503 once shutdown starts', async () => {
    const { transport, release } = gatedTransport();
    release();

    void transport.close();

    const req = new MockRequest();
    const res = new MockResponse();
    req.setBody(
      JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'slow' } }),
    );
    await transport.handler()(req as any, res as any);

    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toContain('shutting down');
  });

  it('still serves /health/ready during shutdown, with a 503 and a reason', async () => {
    // The ordering that matters: if the shutdown gate came first, readiness
    // would return the generic rejection and a load balancer could not tell a
    // draining instance from a dead one.
    const { transport, release } = gatedTransport();
    release();

    void transport.close();
    const res = await get(transport, '/mcp/health/ready');

    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toBe('shutting-down');
    expect(res.json().detail).toContain('draining');
  });

  it('keeps /health/live at 200 during shutdown', async () => {
    // Liveness answers "should this process be restarted?" — during an
    // orderly drain the answer is no. Returning 503 here would have the
    // orchestrator kill the process mid-drain and lose the audit flush.
    const { transport, release } = gatedTransport();
    release();

    void transport.close();

    expect((await get(transport, '/mcp/health/live')).statusCode).toBe(200);
  });
});

describe('drain (§8.6 phase 4)', () => {
  it('waits for in-flight calls, and they all complete before close() returns', async () => {
    // §8.6's stated test: calls in flight when SIGTERM arrives must finish.
    const { transport, release, entered } = gatedTransport();

    const calls = Array.from({ length: 100 }, (_, i) => callTool(transport, `req-${i}`));

    // Let all 100 reach the handler before shutting down.
    await new Promise((resolve) => setTimeout(resolve, 20));

    let closed = false;
    const closing = transport.close({ drainMs: 5_000 }).then((r) => {
      closed = true;
      return r;
    });

    // Still draining: the gate is shut, so nothing has finished.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    release();
    const result = await closing;

    const responses = await Promise.all(calls.map((c) => c.done));

    expect(result.drainTimedOut).toBe(false);
    expect(entered()).toBe(100);
    // Every one answered successfully — a drain that returned early would
    // leave some of these unanswered or cancelled.
    expect(responses.every((r) => r.json().result !== undefined)).toBe(true);
  });

  it('returns at the drain deadline and hung calls receive CANCELLED', async () => {
    // §8.6: "close returns at the deadline, hung calls receive CANCELLED".
    // The gate stays shut for the duration of the assertions.
    const { transport, release } = gatedTransport();

    const call = callTool(transport, 'hung');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const startedAt = Date.now();
    const result = await transport.close({ drainMs: 50 });
    const elapsed = Date.now() - startedAt;

    expect(result.drainTimedOut).toBe(true);
    // Returned at the deadline, not at the (never-arriving) completion.
    expect(elapsed).toBeLessThan(2_000);

    const res = await call.done;
    expect(res.json().error.code).toBe('CANCELLED');

    // Release so the handler settles and `viaHandler`'s own deadline timer is
    // cleared. Leaving it hung keeps a 30s timer alive past the test and Jest
    // reports an open handle — the leak is in the FIXTURE, but an open-handle
    // warning that is normal-for-this-suite is one nobody reads afterwards.
    release();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('returns immediately when nothing is in flight', async () => {
    const { transport } = gatedTransport();

    const startedAt = Date.now();
    const result = await transport.close({ drainMs: 5_000 });

    expect(result.drainTimedOut).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('audit delivery (§8.6 phase 5, acceptance)', () => {
  it('flushes audit on a graceful close', async () => {
    let flushed = 0;
    const { transport, release } = gatedTransport({
      flushAudit: async () => {
        flushed += 1;
      },
    });
    release();

    const result = await transport.close();

    expect(flushed).toBe(1);
    expect(result.auditFlushed).toBe(true);
  });

  it('flushes audit even under forceClose', async () => {
    // The invariant §8.6 states explicitly: an immediate close "still tries
    // to flush audit". This is the no-audit-loss acceptance criterion.
    let flushed = 0;
    const { transport, release } = gatedTransport({
      flushAudit: async () => {
        flushed += 1;
      },
    });

    // A call is hung, so a graceful close would block on the drain; force
    // skips it and must still reach phase 5.
    const call = callTool(transport, 'hung');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await transport.forceClose();

    expect(flushed).toBe(1);
    expect(result.forced).toBe(true);
    expect(result.auditFlushed).toBe(true);

    // Settle the fixture's handler — see the note in the drain-deadline test.
    await call.done;
    release();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('flushes audit exactly once across repeated close calls', async () => {
    let flushed = 0;
    const { transport, release } = gatedTransport({
      flushAudit: async () => {
        flushed += 1;
      },
    });
    release();

    await Promise.all([transport.close(), transport.close(), transport.forceClose()]);

    expect(flushed).toBe(1);
  });
});

describe('readiness reads live runtime state (§8.7)', () => {
  it('reports all-breakers-open only when dependencies are enforced', async () => {
    // Wires REAL breakers (#46) rather than a stub, so this exercises the
    // dispatcher's own cached stats — the seam §8.7 says readiness reads.
    const breakers = {
      default: {
        failureThreshold: 1,
        failureWindowMs: 60_000,
        cooldownMs: 60_000,
        halfOpenProbes: 1,
      },
    };

    const failing = new Map<string, OperationExecutor>([
      [
        'handler',
        {
          execute: async () => ({
            ok: false as const,
            error: { code: 'UPSTREAM_UNAVAILABLE' as const, message: 'boom' },
          }),
        },
      ],
    ]);

    const transport = createHttpTransport({
      registry: registry(),
      basePath: '/mcp',
      executors: failing,
      breakers,
      enforceDependencies: true,
    } as any);

    expect(transport.readiness().httpStatus).toBe(200);

    // One failure opens the only breaker.
    const { done } = callTool(transport, 'x');
    await done;

    const report = transport.readiness();
    expect(report.httpStatus).toBe(503);
    expect(report.reason).toBe('all-breakers-open');
  });

  it('stays ready with breakers disabled, which is the default', async () => {
    // The empty-list case, through the real transport: with no breaker config
    // the dispatcher returns no stats, and `[].every()` being true must not
    // make this instance report itself unreachable.
    const { transport } = gatedTransport({ enforceDependencies: true });

    expect(transport.readiness().httpStatus).toBe(200);
  });
});
