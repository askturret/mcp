// SPDX-License-Identifier: Apache-2.0
/**
 * Client-initiated cancellation — `notifications/cancelled` (§44, §8.3).
 *
 * §44 requires that a client can cancel an in-flight call and that the
 * executor's `signal.aborted` becomes true "within ms". Before this, the
 * transport handled no such method: the notification fell through to
 * `Method not found` and the call ran to its deadline regardless.
 *
 * These drive the transport's real handler, because the thing under test is
 * the wiring between two SEPARATE requests — the tool call and the notification
 * that names it. A unit test of the AbortController would prove nothing about
 * whether one request can reach the other.
 */

import { describe, it, expect } from '@jest/globals';

import { createHttpTransport } from './index.js';
import { AtomicRegistryReference } from '@askturret/mcp-core';
import type {
  OperationDefinition,
  OperationExecutor,
  OperationResult,
  RegistrySnapshot,
} from '@askturret/mcp-core';

function operation(id: string): OperationDefinition {
  return {
    id,
    name: id,
    description: id,
    input: { type: 'object', properties: {} },
    output: { type: 'object', properties: {} },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'test' },
  };
}

function snapshotWith(op: OperationDefinition): RegistrySnapshot {
  return {
    hash: 'cancel-test',
    version: 1,
    createdAt: new Date(),
    operations: new Map([[op.id, op]]),
  };
}

/** Minimal Node-ish req/res pair the transport can drive. */
function reqRes(body: unknown) {
  const chunks = Buffer.from(JSON.stringify(body));
  const listeners = new Map<string, ((arg?: unknown) => void)[]>();

  const req = {
    method: 'POST',
    url: '/mcp',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    on(event: string, handler: (arg?: unknown) => void) {
      if (event === 'data') handler(chunks);
      if (event === 'end') handler();
      return req;
    },
  };

  let body_ = '';
  const res = {
    statusCode: 200,
    writableEnded: false,
    writeHead(code: number) {
      this.statusCode = code;
      return this;
    },
    end(payload?: string) {
      if (payload !== undefined) body_ += payload;
      this.writableEnded = true;
      const closers = listeners.get('close') ?? [];
      for (const c of closers) c();
      return this;
    },
    on(event: string, handler: (arg?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return this;
    },
    off() {
      return this;
    },
    get body() {
      return body_;
    },
  };

  return { req, res };
}

describe('notifications/cancelled', () => {
  it('aborts the executor signal of the named in-flight call', async () => {
    // The §44 assertion: signal.aborted becomes true within ms, not at the
    // deadline. The executor blocks until aborted, so if the notification did
    // nothing this would hang until the deadline instead.
    let sawAbort = false;
    let entered!: () => void;
    const executorEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const executor: OperationExecutor = {
      execute: async (_op: unknown, _input: unknown, context: { signal: AbortSignal }) =>
        new Promise<OperationResult>((resolve) => {
          entered();
          if (context.signal.aborted) {
            sawAbort = true;
            return resolve({ ok: false, error: { code: 'CANCELLED', message: 'aborted' } });
          }
          context.signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve({ ok: false, error: { code: 'CANCELLED', message: 'aborted' } });
          });
        }),
    } as unknown as OperationExecutor;

    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotWith(operation('slowOp'))),
      basePath: '/mcp',
      deadlineMs: 30000, // far away: only the notification can end this call
      executors: new Map([['test', executor]]),
    } as Parameters<typeof createHttpTransport>[0]);

    const handler = transport.handler();

    const call = reqRes({
      jsonrpc: '2.0',
      id: 'call-1',
      method: 'tools/call',
      params: { name: 'slowOp', arguments: {} },
    });
    const inFlight = handler(call.req, call.res);

    await executorEntered;

    const cancel = reqRes({
      jsonrpc: '2.0',
      id: 'notify-1',
      method: 'notifications/cancelled',
      params: { requestId: 'call-1' },
    });
    await handler(cancel.req, cancel.res);

    expect(JSON.parse(cancel.res.body).result).toEqual({ cancelled: true });

    await inFlight;
    expect(sawAbort).toBe(true);
  }, 10000);

  it('reports cancelled:false for an id it does not know', async () => {
    // "Cancelled nothing" must be distinguishable from "cancelled
    // successfully". A notification that silently no-ops, with no way to tell
    // the two apart, is worse than none — the caller believes work stopped.
    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotWith(operation('op'))),
      basePath: '/mcp',
      executors: new Map(),
    } as Parameters<typeof createHttpTransport>[0]);

    const cancel = reqRes({
      jsonrpc: '2.0',
      id: 'n',
      method: 'notifications/cancelled',
      params: { requestId: 'never-existed' },
    });
    await transport.handler()(cancel.req, cancel.res);

    expect(JSON.parse(cancel.res.body).result).toEqual({ cancelled: false });
  });

  it('deregisters a completed call, so a late notification cannot hit a recycled id', async () => {
    // A leaked entry would let a cancellation land on a DIFFERENT request that
    // happened to reuse the id — worse than one that lands nowhere.
    const executor: OperationExecutor = {
      execute: async (): Promise<OperationResult> => ({ ok: true, value: {} }),
    } as unknown as OperationExecutor;

    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotWith(operation('fastOp'))),
      basePath: '/mcp',
      executors: new Map([['test', executor]]),
    } as Parameters<typeof createHttpTransport>[0]);

    const handler = transport.handler();

    const call = reqRes({
      jsonrpc: '2.0',
      id: 'reused-id',
      method: 'tools/call',
      params: { name: 'fastOp', arguments: {} },
    });
    await handler(call.req, call.res);

    const cancel = reqRes({
      jsonrpc: '2.0',
      id: 'n',
      method: 'notifications/cancelled',
      params: { requestId: 'reused-id' },
    });
    await handler(cancel.req, cancel.res);

    expect(JSON.parse(cancel.res.body).result).toEqual({ cancelled: false });
  });
});
