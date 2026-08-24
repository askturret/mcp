// SPDX-License-Identifier: Apache-2.0
/**
 * A category that hangs in CLEANUP still reports a row (#253).
 *
 * ## What #151 left open
 *
 * #151 bounded every request, at `rpc`. The `cancellation` category does not go
 * through `rpc` — it uses a direct `fetch`, because it aborts one specific
 * in-flight request — and its `finally { server.close() }` then waits on the
 * half-dead connection it deliberately left behind. No request deadline reaches
 * a close.
 *
 * The result was not a wrong verdict but a MISSING one. The category ran past
 * `conformance.test.ts`'s own 30s jest cap, the harness killed the test before
 * `runBank` recorded anything, and the table printed `—` for it. A reader could
 * not tell "this hung" from "not applicable" — which is mild when seven
 * neighbouring rows already say FAIL, and actively misleading if the hung
 * category were the only one failing.
 *
 * ## Why the bound is around the category, not inside each `finally`
 *
 * Eight categories end in `finally { await server.close() }`. A bound placed in
 * those eight blocks would throw FROM the finally, replacing whatever the
 * category was already failing with — usually the more diagnostic error. Around
 * the whole category, the specific failure survives when there is one, and a
 * row still appears when there is not.
 *
 * ## The fixture
 *
 * A server that answers nothing and whose `close()` never settles. That is the
 * shape of the real failure without needing the Fastify parser mutation: the
 * category body fails or completes, the `finally` waits forever, and the
 * category promise never settles.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CATEGORY_TIMEOUT_MS,
  categoryTimeoutMs,
  renderTable,
  runBank,
  runCategory,
  type CategoryResult,
} from '../bank.js';
import type { AdapterFactory } from '../registry.js';

const CATEGORY_ENV = 'ASKTURRET_CONFORMANCE_CATEGORY_TIMEOUT_MS';
const REQUEST_ENV = 'ASKTURRET_CONFORMANCE_REQUEST_TIMEOUT_MS';

afterEach(() => {
  delete process.env[CATEGORY_ENV];
  delete process.env[REQUEST_ENV];
});

/** A listening server whose `close()` never resolves. */
async function startUnclosableServer(): Promise<{ url: string; destroy: () => void }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer(() => {
    // Answers nothing, so the category body fails on its own budget first.
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    destroy: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

describe('a category that hangs in cleanup (#253)', () => {
  it('records a FAILED ROW instead of never returning', async () => {
    process.env[CATEGORY_ENV] = '900';
    process.env[REQUEST_ENV] = '200';
    const hung = await startUnclosableServer();

    // The close is what hangs — this is the #253 shape, not #151's.
    const factory: AdapterFactory = async () => ({
      url: hung.url,
      close: () => new Promise<void>(() => undefined),
    });

    try {
      const started = Date.now();
      const results = await runBank('stuck', factory, { categories: ['discovery'] });
      const elapsed = Date.now() - started;

      expect(results).toHaveLength(1);
      expect(results[0]?.passed).toBe(false);
      expect(results[0]?.note).toContain("category 'discovery' did not complete");

      // The point of the issue: the bank's own bound fires BEFORE the harness's
      // cap, so the row exists. Generous enough not to flake, far below the 30s
      // jest cap that used to kill the test first.
      expect(elapsed).toBeLessThan(6_000);
    } finally {
      hung.destroy();
    }
  });

  it('renders that row as FAIL, which is what makes it distinguishable', async () => {
    // The two halves of #253 meeting: the hang produces a row (part 1), and the
    // row is a labelled failure rather than the ambiguous cell (part 2).
    process.env[CATEGORY_ENV] = '900';
    process.env[REQUEST_ENV] = '200';
    const hung = await startUnclosableServer();

    const factory: AdapterFactory = async () => ({
      url: hung.url,
      close: () => new Promise<void>(() => undefined),
    });

    try {
      const results = await runBank('stuck', factory, { categories: ['discovery'] });

      expect(renderTable(results)).toMatch(/discovery\s*\|\s*FAIL/);
      expect(renderTable(results)).not.toMatch(/discovery\s*\|\s*NOT RUN/);
    } finally {
      hung.destroy();
    }
  });
});

describe('the bound is on the path that publishes the table (#253)', () => {
  it('bounds a category directly through runCategory', async () => {
    // runBank is not the only caller — conformance.test.ts runs each category
    // as its own `it()`. This pins the shared entry point itself.
    process.env[CATEGORY_ENV] = '400';

    const forever = {
      id: 99,
      name: 'never-settles',
      run: () => new Promise<string>(() => undefined),
    };

    await expect(runCategory(forever, { adapter: 'x', start: async () => ({ url: '', close: async () => undefined }) })).rejects.toThrow(
      /category 'never-settles' did not complete/,
    );
  });

  it('is what conformance.test.ts actually calls', () => {
    // The regression this file exists to prevent, and the one the first attempt
    // at #253 shipped: the bound went into runBank only, conformance.test.ts
    // kept calling `category.run` directly, and the real scenario still died at
    // jest's cap with the row still missing. The unit tests all passed.
    //
    // Asserted against the source because the failure is a WIRING fact, not a
    // behavioural one — the bound worked perfectly, on a path nobody used.
    const suite = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'conformance.test.ts'),
      'utf-8',
    );

    expect(suite).toContain('runCategory(category,');
    expect(suite).not.toMatch(/await category\.run\(/);
  });
});

describe('the table says what an empty cell means (#253)', () => {
  const result = (category: string, passed: boolean): CategoryResult => ({
    adapter: 'a',
    category,
    id: 1,
    passed,
    note: 'n',
  });

  it('labels a category with no result NOT RUN rather than an em-dash', () => {
    // `—` meant both "produced no result" and "hung and died before reporting"
    // in a table whose whole purpose is to be self-explanatory.
    const table = renderTable([result('discovery', true)]);

    expect(table).toContain('NOT RUN');
    expect(table).not.toContain('—');
  });

  it('explains the label, but only when one appears', () => {
    const withMissing = renderTable([result('discovery', true)]);
    expect(withMissing).toContain('NOT RUN = no result recorded');

    // A complete table stays clean — a legend for a label nobody can see is
    // noise, and this suite's output is read by humans on a failing build.
    const complete = renderTable(
      [
        'discovery',
        'schema-preservation',
        'context-propagation',
        'cancellation',
        'error-mapping',
        'authorization-context',
        'lifecycle-cleanup',
        'duplicate-handling',
      ].map((name) => result(name, true)),
    );

    expect(complete).not.toContain('NOT RUN');
    expect(complete).not.toContain('NOT RUN = no result recorded');
  });

  it('keeps FAIL and NOT RUN as different things', () => {
    // The distinction the issue is about. If these ever collapse, a hung
    // category reads as "not applicable" again.
    const table = renderTable([result('discovery', false)]);

    expect(table).toMatch(/discovery\s*\|\s*FAIL/);
    expect(table).toMatch(/schema-preservation\s*\|\s*NOT RUN/);
  });
});

describe('the category budget', () => {
  it('defaults when unset', () => {
    delete process.env[CATEGORY_ENV];

    expect(categoryTimeoutMs()).toBe(DEFAULT_CATEGORY_TIMEOUT_MS);
  });

  it('sits below the harness cap that used to kill the run first', () => {
    // conformance.test.ts caps each category test at 30_000ms. If this default
    // ever rose above that, the harness would kill the test before the bank
    // could record a row — which is exactly the #253 defect, restored.
    expect(DEFAULT_CATEGORY_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it('refuses a malformed override rather than falling back to none', () => {
    process.env[CATEGORY_ENV] = 'soon';

    expect(() => categoryTimeoutMs()).toThrow(new RegExp(CATEGORY_ENV));
  });
});
