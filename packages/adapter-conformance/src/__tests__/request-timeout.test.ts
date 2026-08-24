// SPDX-License-Identifier: Apache-2.0
/**
 * A hung adapter fails a row instead of stalling the suite (#151).
 *
 * ## The failure this pins
 *
 * The bank guards hard against vacuous passes — an empty adapter selection, a
 * filter typo, a shrunken category list all fail loudly. It had no per-request
 * deadline. An adapter that accepted a connection and never answered — a hang,
 * not an error — stalled the whole run: no table, no row, just a CI job timeout
 * with nothing to read. #42's QA reproduced it by disabling the Fastify
 * pass-through parser and watching the suite sit past 600 seconds.
 *
 * A hang is the worst-behaved failure a suite can have, because it is the one
 * that destroys its own report. Everything else this bank does is designed to
 * be self-explanatory in the table; this made the table not exist.
 *
 * ## How the hang is simulated
 *
 * With a raw `node:http` server that accepts the request and never responds.
 * That is the shape of the regression rather than an imitation of it: the
 * socket is open, the adapter is reachable, and nothing is ever going to come
 * back. It needs no framework and no mutation of a real adapter, so the test
 * stays honest if the adapters change.
 *
 * ## Why the assertions go through `runBank` and `renderTable`
 *
 * The acceptance criterion is about the TABLE, not about `rpc`. Asserting that
 * `rpc` rejects would leave the interesting half — that a rejection becomes an
 * ordinary failed row rather than an unhandled error that kills the run —
 * untested. So the main case drives the real runner and the real renderer.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { getEventListeners } from 'node:events';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  renderTable,
  requestTimeoutMs,
  rpc,
  runBank,
} from '../bank.js';
import type { AdapterFactory } from '../registry.js';

const TIMEOUT_ENV = 'ASKTURRET_CONFORMANCE_REQUEST_TIMEOUT_MS';

/** A server that accepts the request and never answers it. */
async function startHangingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer(() => {
    // Deliberately no response, ever.
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      // Destroy first: `close` waits for open connections, and this server
      // exists precisely to hold one open. Waiting here would reintroduce the
      // hang inside the test that exists to prove hangs are bounded.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A responsive server, for the control case. */
async function startRespondingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const id = (JSON.parse(body || '{}') as { id?: number }).id ?? null;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(() => {
  delete process.env[TIMEOUT_ENV];
});

describe('per-request timeout (#151)', () => {
  it('turns a hung adapter into a failed row in the comparison table', async () => {
    process.env[TIMEOUT_ENV] = '250';
    const hung = await startHangingServer();

    // A factory that hands the bank a server which never answers. Everything
    // downstream is the real thing: the real category, the real runner, the
    // real renderer.
    const factory: AdapterFactory = async () => ({
      url: hung.url,
      close: async () => undefined,
    });

    try {
      const started = Date.now();
      const results = await runBank('hung', factory, { categories: ['discovery'] });
      const elapsed = Date.now() - started;

      expect(results).toHaveLength(1);
      expect(results[0]?.passed).toBe(false);
      expect(results[0]?.note).toContain('TIMEOUT');

      // The point of the issue: bounded, not "eventually". Generous enough not
      // to flake on a loaded runner, still far below any CI job timeout.
      expect(elapsed).toBeLessThan(4_000);

      // And it must reach the TABLE, which is the artifact a human reads.
      expect(renderTable(results)).toMatch(/discovery\s*\|\s*FAIL/);
    } finally {
      await hung.close();
    }
  });

  it('rejects with a message naming the method, the url and the budget', async () => {
    process.env[TIMEOUT_ENV] = '250';
    const hung = await startHangingServer();

    try {
      // A bare `rejects.toThrow` would pass on any error at all, including one
      // from a mistyped url. Pin the parts that make the row diagnosable.
      await expect(rpc(hung.url, 'tools/list')).rejects.toThrow(/TIMEOUT: tools\/list/);
      await expect(rpc(hung.url, 'tools/list')).rejects.toThrow(/250ms/);
    } finally {
      await hung.close();
    }
  });

  it('still completes a request against a server that answers', async () => {
    // The control. Without it, every assertion above is satisfied by a deadline
    // that simply fails everything — which would "pass" this file while making
    // the conformance suite useless.
    process.env[TIMEOUT_ENV] = '5000';
    const responsive = await startRespondingServer();

    try {
      const response = await rpc(responsive.url, 'tools/list');

      expect(response.status).toBe(200);
      expect(response.body.result?.tools).toEqual([]);
    } finally {
      await responsive.close();
    }
  });

  it("reports a caller's own abort as itself, not as a timeout", async () => {
    // `rpc` is exported for the #54 adapter-test kit, so `init.signal` is a
    // public surface. The deadline composes with it rather than replacing it,
    // and only a DEADLINE abort is relabelled — otherwise a kit that cancelled
    // its own request would be told the adapter hung.
    process.env[TIMEOUT_ENV] = '10000';
    const hung = await startHangingServer();
    const controller = new AbortController();

    try {
      const pending = rpc(hung.url, 'tools/list', {}, { signal: controller.signal });
      controller.abort();

      await expect(pending).rejects.toThrow();
      await expect(pending).rejects.not.toThrow(/TIMEOUT/);
    } finally {
      await hung.close();
    }
  });

  describe('composing a caller signal with the deadline (#253)', () => {
    // `AbortSignal.any` would do this natively but landed partway through the
    // Node 20 line, while the package declares `engines: >=20.0.0` — so on the
    // earliest 20.x a caller-supplied signal produced a TypeError instead of a
    // timeout. The composition is done by hand instead, which needs no version
    // claim; these cover the paths that hand-rolling introduces.

    it('still enforces the DEADLINE when a caller signal is present', async () => {
      // The case the old code got for free and hand-rolling has to earn: the
      // composed signal must forward the deadline, not only the caller's abort.
      // Nothing before #253 covered it — the existing caller-abort test uses a
      // 10s budget, so its deadline never fires.
      process.env[TIMEOUT_ENV] = '250';
      const hung = await startHangingServer();
      const controller = new AbortController();

      try {
        await expect(
          rpc(hung.url, 'tools/list', {}, { signal: controller.signal }),
        ).rejects.toThrow(/TIMEOUT/);
      } finally {
        await hung.close();
      }
    });

    it('aborts immediately when the caller signal is ALREADY aborted', async () => {
      // An already-aborted input never emits `abort`, so a composition that only
      // subscribed would wait out the whole deadline on a request the caller
      // had already given up on.
      process.env[TIMEOUT_ENV] = '10000';
      const hung = await startHangingServer();

      try {
        const started = Date.now();
        await expect(
          rpc(hung.url, 'tools/list', {}, { signal: AbortSignal.abort() }),
        ).rejects.toThrow();
        // Far below the 10s budget — proof it did not simply wait it out.
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await hung.close();
      }
    });

    it('removes its listeners, so a signal reused across requests does not leak', async () => {
      // The #54 kit may hold ONE signal for a whole run. Without teardown every
      // request leaves a listener on it, and Node starts warning at 11 — a leak
      // that only appears in a long run, which is the worst time to find it.
      process.env[TIMEOUT_ENV] = '150';
      const hung = await startHangingServer();
      const controller = new AbortController();

      try {
        for (let i = 0; i < 12; i++) {
          await rpc(hung.url, 'tools/list', {}, { signal: controller.signal }).catch(
            () => undefined,
          );
        }

        // Counted, not inferred: `getEventListeners` reads the real registry on
        // any EventTarget, so this fails if `dispose` stops being called.
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      } finally {
        await hung.close();
      }
    });
  });

  describe('the budget itself', () => {
    it('defaults when the override is unset', () => {
      delete process.env[TIMEOUT_ENV];

      expect(requestTimeoutMs()).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    });

    it('honours a valid override', () => {
      process.env[TIMEOUT_ENV] = '1234';

      expect(requestTimeoutMs()).toBe(1234);
    });

    it.each(['0', '-1', 'soon', 'NaN', 'Infinity'])(
      'refuses the malformed override %p instead of falling back',
      (value) => {
        process.env[TIMEOUT_ENV] = value;

        // Falling back to the DEFAULT would be survivable. Falling back to NO
        // deadline would restore the exact hang this exists to prevent, and do
        // it invisibly — so a bad value is an error, not a shrug.
        expect(() => requestTimeoutMs()).toThrow(new RegExp(TIMEOUT_ENV));
      },
    );
  });
});
