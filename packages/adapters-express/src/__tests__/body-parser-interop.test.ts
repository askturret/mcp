/**
 * Interop with a host app's own body parser (#147).
 *
 * ## The hazard
 *
 * The MCP transport reads the RAW request stream — `readRequestBody` consumes
 * it via `req.on('data')`. `express.json()` also reads that stream, and a host
 * app registering it globally is completely ordinary. When it runs first, the
 * stream is already ended by the time the transport attaches its listeners:
 * `data` never fires, `end` never fires, and the promise never settles.
 *
 * The request HANGS. Not a 500, not an error — no response at all, which is the
 * hardest failure to attribute to the right layer. #41 fixed the identical
 * hazard for Fastify with an encapsulated pass-through parser; Express has no
 * equivalent encapsulation, because the host's middleware has already run by
 * the time anything scoped to our router can act.
 *
 * ## Why these tests are bounded by a timer
 *
 * A hang is the ABSENCE of a response, and `await request(app)...` on a hung
 * request simply never resolves — the test would sit until the suite-level
 * timeout and report as a timeout rather than as this defect. Racing against an
 * explicit timer turns "it hung" into a normal assertion failure with a
 * meaningful message, which is what #147's acceptance asks for: proof of the
 * absence of a hang, not merely the presence of a response.
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

/**
 * Mount the adapter under a host app, optionally with a global JSON parser.
 *
 * `parser` is the whole point of the fixture: the ONLY difference between the
 * passing and hanging cases is whether the host drained the stream first.
 */
function mount(parser?: express.RequestHandler) {
  const app = express();
  if (parser) app.use(parser);
  const router = expressMcp({ sources: [source], enableExplorer: false });
  app.use('/mcp', router);
  const ready = ((router as unknown as { _init?: Promise<void> })._init ?? Promise.resolve()).catch(
    () => undefined,
  );
  return { app, ready };
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

/**
 * Send a request and fail with a legible message if it never comes back.
 *
 * Returns the supertest response, or throws "hung" — never resolves to a
 * sentinel the caller might forget to check.
 */
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

describe('host body-parser interop (#147)', () => {
  it('completes when the host registered a global express.json() before the router', async () => {
    // The regression. Before the fix this never responds.
    const { app, ready } = mount(express.json());
    await ready;

    const res = await withinBudget(() => request(app).post('/mcp').send(TOOLS_LIST));

    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe(1);
    // Not merely "a response" — the CORRECT response. A 500 or an empty result
    // would also complete within the budget, and would also be a defect.
    expect(Array.isArray(res.body.result?.tools)).toBe(true);
    expect(res.body.result.tools.length).toBeGreaterThan(0);
  });

  it('still works with no host parser at all — the path that already worked', async () => {
    // The control. If this ever fails, the fix broke the ordinary case rather
    // than the fix being unnecessary, and the two are easy to confuse.
    const { app, ready } = mount();
    await ready;

    const res = await withinBudget(() => request(app).post('/mcp').send(TOOLS_LIST));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.result?.tools)).toBe(true);
  });

  it('completes when the host parser ran but the body was not JSON-shaped', async () => {
    // `express.json()` sets an EMPTY object when there is no body to parse, and
    // still marks the stream consumed. Replaying nothing must produce a normal
    // JSON-RPC parse error rather than a hang — "could not parse" is a fine
    // answer, no answer is not.
    const { app, ready } = mount(express.json());
    await ready;

    const res = await withinBudget(() =>
      request(app).post('/mcp').set('Content-Type', 'application/json').send(''),
    );

    // Asserted precisely rather than as "some status came back". A range check
    // would pass for almost any outcome, including ones that would be defects.
    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.error.code).toBe(-32601);

    // Worth knowing rather than glossing: `express.json()` turns an empty body
    // into `{}`, so that is what gets replayed and the transport answers
    // "method not found" where an un-drained empty body would have produced a
    // PARSE error. A different error code for the same malformed request — the
    // honest cost of reconstructing a body from a parsed value, and the reason
    // the replay documents itself as a reconstruction rather than a pass-through.
  });

  it('completes when the host parser is urlencoded rather than json', async () => {
    // NOT a regression test, and labelled so rather than counted as one: this
    // passes against the UNFIXED adapter too. `express.urlencoded()` only reads
    // `application/x-www-form-urlencoded`, so it never drains a JSON body and
    // the hazard does not arise — I assumed otherwise when writing this and the
    // pre-fix run corrected me.
    //
    // Kept because it pins that scope: if the replay ever started firing for
    // requests nothing had consumed, this is where it would show up.
    const { app, ready } = mount(express.urlencoded({ extended: true }));
    await ready;

    const res = await withinBudget(() => request(app).post('/mcp').send(TOOLS_LIST));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.result?.tools)).toBe(true);
  });

  it('leaves a sibling route’s parsed body untouched', async () => {
    // The fix must not disturb the host app. A sibling route still sees the
    // body its own parser produced — the encapsulation §41 asks for, checked
    // from the host's side rather than assumed.
    const app = express();
    app.use(express.json());
    const router = expressMcp({ sources: [source], enableExplorer: false });
    app.use('/mcp', router);
    app.post('/echo', (req, res) => {
      res.json({ seen: req.body });
    });
    await ((router as unknown as { _init?: Promise<void> })._init ?? Promise.resolve()).catch(
      () => undefined,
    );

    const res = await withinBudget(() => request(app).post('/echo').send({ hello: 'world' }));

    expect(res.status).toBe(200);
    expect(res.body.seen).toEqual({ hello: 'world' });
  });
});
