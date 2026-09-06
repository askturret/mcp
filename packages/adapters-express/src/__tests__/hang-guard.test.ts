/**
 * The #147 hang guard is load-bearing, and does not depend on a private field (#706).
 *
 * ## What this suite adds over `body-parser-interop.test.ts`
 *
 * That suite proves the hazard is fixed for the shapes it names. This one is
 * about the GUARD ITSELF staying honest across an Express major bump, which is
 * a different question and was answered by nothing:
 *
 * 1. **Breadth.** `bodyAlreadyConsumed` must fire for every host-parser shape
 *    that drains the stream, not only `express.json()`. Measurement for #706
 *    found eight distinct shapes that leave a late subscriber with no `end`
 *    event; the interop suite exercised two of them.
 *
 * 2. **Mechanism independence.** The guard used to read `req._body`, a
 *    `body-parser` INTERNAL. body-parser 1 sets it; body-parser 2 never does.
 *    Nothing failed when express 5 made that clause dead, because the clause
 *    was also redundant on express 4 — so its removal was invisible in both
 *    directions, which is precisely why it needed a test rather than a reading.
 *
 * ## Why the `_body`-stripping test is the important one
 *
 * `stripPrivateBodyFlag` deletes `req._body` after the host parser has run,
 * which makes express 4 behave the way express 5 already does. On express 4 it
 * is therefore a SIMULATION of the newer body-parser, and it is the test that
 * would have caught #706 before express 5 was ever installed here. On express 5
 * it is a no-op that documents the real state. Either way it fails if anyone
 * reintroduces detection via that private field.
 *
 * ## Bounded, like its sibling
 *
 * A hang is the ABSENCE of a response, so every request races an explicit
 * timer. Without it a regression reports as a suite-level jest timeout — slow,
 * and it leaks a worker rather than naming the defect.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { expressMcp } from '../index.js';
import type { OperationSource, DiscoveredOperation } from '@askturret/mcp-core';

/** How long a request may take before we call it hung. */
const HANG_BUDGET_MS = 3000;

function op(id: string): DiscoveredOperation {
  return {
    candidateId: id,
    name: id,
    description: `Test operation ${id}`,
    source: 'mock-source',
    rawInput: { type: 'object' },
    rawOutput: { type: 'object' },
    effects: { readOnly: true, idempotent: true, retryable: true },
  };
}

const source: OperationSource = {
  name: 'mock-source',
  discover: async () => [op('getUser'), op('listUsers')],
};

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

/** Delete body-parser 1's private marker, so express 4 behaves like express 5. */
function stripPrivateBodyFlag(): express.RequestHandler {
  return (req, _res, next) => {
    delete (req as unknown as { _body?: boolean })._body;
    next();
  };
}

function mount(...middleware: express.RequestHandler[]) {
  const app = express();
  for (const mw of middleware) app.use(mw);
  const router = expressMcp({ sources: [source], enableExplorer: false });
  app.use('/mcp', router);
  const ready = ((router as unknown as { _init?: Promise<void> })._init ?? Promise.resolve()).catch(
    () => undefined,
  );
  return { app, ready };
}

async function withinBudget(send: () => Promise<request.Response>): Promise<request.Response> {
  let timer: NodeJS.Timeout | undefined;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`request did not complete within ${HANG_BUDGET_MS}ms — it hung`)),
      HANG_BUDGET_MS,
    );
  });

  try {
    return await Promise.race([send(), hang]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Host parsers that DRAIN the stream before our router sees the request.
 *
 * The wildcard `type` option on raw and text is deliberate: with their default
 * content types they would DECLINE a JSON-RPC POST and never consume it, so the
 * case under test would silently not arise — a test that cannot fail. Each of
 * these leaves a late subscriber with no `end` event, the #147 hang exactly.
 */
const CONSUMING_PARSERS: ReadonlyArray<{ name: string; mw: express.RequestHandler }> = [
  { name: 'express.json()', mw: express.json() },
  { name: "express.raw({ type: '*/*' })", mw: express.raw({ type: '*/*' }) },
  { name: "express.text({ type: '*/*' })", mw: express.text({ type: '*/*' }) },
];

describe('#147 hang guard is load-bearing across host-parser shapes (#706)', () => {
  for (const { name, mw } of CONSUMING_PARSERS) {
    it(`completes when the host ran ${name} before the router`, async () => {
      const { app, ready } = mount(mw);
      await ready;

      const res = await withinBudget(() => request(app).post('/mcp').send(TOOLS_LIST));

      // Not merely "a response" — the CORRECT one. A 500 or an empty result
      // also completes within the budget, and both are defects.
      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.id).toBe(1);
      expect(Array.isArray(res.body.result?.tools)).toBe(true);
      expect(res.body.result.tools.length).toBeGreaterThan(0);
    });
  }

  it('completes when the host parser leaves no private `_body` marker behind', async () => {
    // THE #706 TEST. On express 4 this simulates body-parser 2 by removing the
    // field body-parser 1 sets; on express 5 nothing sets it in the first place.
    // A guard that detects a consumed body via `req._body` fails here on BOTH
    // majors, which is the property that was missing.
    const { app, ready } = mount(express.json(), stripPrivateBodyFlag());
    await ready;

    const res = await withinBudget(() => request(app).post('/mcp').send(TOOLS_LIST));

    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe(1);
    expect(Array.isArray(res.body.result?.tools)).toBe(true);
    expect(res.body.result.tools.length).toBeGreaterThan(0);
  });

  it('still answers when no host parser ran at all — the control', async () => {
    // If this fails, the guard broke the ordinary un-drained path rather than
    // the guard being unnecessary. The two are easy to confuse from a red suite.
    const { app, ready } = mount();
    await ready;

    const res = await withinBudget(() => request(app).post('/mcp').send(TOOLS_LIST));

    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe(1);
    expect(Array.isArray(res.body.result?.tools)).toBe(true);
    expect(res.body.result.tools.length).toBeGreaterThan(0);
  });
});
