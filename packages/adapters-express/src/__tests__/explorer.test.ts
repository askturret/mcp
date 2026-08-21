// SPDX-License-Identifier: Apache-2.0
/**
 * Explorer UI route tests (issue #19).
 *
 * Covers the three cases the issue calls for:
 *  1. renders the visible tools against the Petstore fixture,
 *  2. a test-fire through the Explorer's own request shape matches the API
 *     result byte-for-byte,
 *  3. NODE_ENV=production defaults to 404.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fromDefinitions, viaHandler, type OperationExecutor } from '@askturret/mcp-core';

import { mcpFromOpenApi, expressMcp } from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PETSTORE = join(__dirname, '../../../sources-openapi/src/__tests__/fixtures/petstore.json');

/**
 * Recover the view model the Explorer page embedded, undoing the angle-bracket
 * escaping applied at render time.
 */
function extractModel(html: string): any {
  const marker = 'window.__EXPLORER__=';
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf(';</script>', start);
  const json = html
    .slice(start + marker.length, end)
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>');
  return JSON.parse(json);
}

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];

let warnSpy: ReturnType<typeof jest.spyOn>;

/**
 * These tests deliberately move NODE_ENV off 'test', which is what the adapter
 * uses to silence its logger. Registry init is async, so without this the
 * compile logs can land after a test finishes and fail the run with "Cannot log
 * after tests are done" — intermittently, which is worse than always.
 */
beforeEach(() => {
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
  jest.restoreAllMocks();
});

/**
 * Mount a router and expose its init promise, so a test can await discovery and
 * compilation instead of racing them.
 */
function mount(basePath: string, router: express.Router) {
  const app = express();
  app.use(basePath, router);
  const ready = ((router as unknown as { _init?: Promise<void> })._init ?? Promise.resolve()).catch(
    () => undefined,
  );
  return { app, ready };
}

/** Everything console.warn saw during this test. */
function warnings(): string {
  return warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('GET {basePath}/explorer', () => {
  it('serves an HTML page listing the visible tools from the Petstore fixture', async () => {
    const { app, ready } = mount('/mcp', mcpFromOpenApi(PETSTORE));
    await ready;

    const res = await request(app).get('/mcp/explorer').expect(200);

    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text.startsWith('<!DOCTYPE html>')).toBe(true);

    const model = extractModel(res.text);
    expect(model.tools.length).toBeGreaterThan(0);
    expect(model.header.toolCount).toBe(model.tools.length);
    // Header carries registry identity.
    expect(typeof model.header.registryHash).toBe('string');
    expect(model.header.registryHash.length).toBeGreaterThan(0);
    expect(typeof model.header.version).toBe('number');
    expect(new Date(model.header.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('shows exactly the tools tools/list exposes — no more, no fewer', async () => {
    const { app, ready } = mount('/mcp', mcpFromOpenApi(PETSTORE));
    await ready;

    const listed = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(200);

    const page = await request(app).get('/mcp/explorer').expect(200);
    const model = extractModel(page.text);

    const apiNames = listed.body.result.tools.map((t: any) => t.name).sort();
    const uiNames = model.tools.map((t: any) => t.name).sort();

    // The Explorer must not become a second, drifting view of the surface.
    expect(uiNames).toEqual(apiNames);
  });

  it('carries detail fields tools/list omits (output schema, effects, executor type)', async () => {
    const { app, ready } = mount('/mcp', mcpFromOpenApi(PETSTORE));
    await ready;

    const model = extractModel((await request(app).get('/mcp/explorer').expect(200)).text);
    const tool = model.tools[0];

    expect(tool).toHaveProperty('outputSchema');
    expect(tool).toHaveProperty('executorType');
    expect(typeof tool.executorType).toBe('string');
    expect(tool.effects).toEqual(
      expect.objectContaining({
        readOnly: expect.any(Boolean),
        idempotent: expect.any(Boolean),
      }),
    );
  });

  it('tells the page to invoke the same basePath it is mounted under', async () => {
    const { app, ready } = mount('/api/mcp', mcpFromOpenApi({ spec: PETSTORE, basePath: '/api/mcp' }));
    await ready;

    const model = extractModel((await request(app).get('/api/mcp/explorer').expect(200)).text);

    expect(model.basePath).toBe('/api/mcp');
  });

  it('is not cached or indexed', async () => {
    const { app, ready } = mount('/mcp', mcpFromOpenApi(PETSTORE));
    await ready;

    const res = await request(app).get('/mcp/explorer').expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});

describe('test-fire from the Explorer', () => {
  /** An app whose single tool really executes, so a call returns a real result. */
  function appWithEchoTool() {
    const executors = new Map<string, OperationExecutor>([
      ['handler', viaHandler(async (input: any) => ({ echo: input.message }))],
    ]);

    const source = fromDefinitions([
      {
        id: 'echo',
        name: 'echo',
        description: 'Echo the input',
        input: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
        output: { type: 'object', properties: { echo: { type: 'string' } } },
        effects: {
          readOnly: true,
          idempotent: true,
          retryable: true,
          idempotencyKeyRequired: false,
          classifications: [],
        },
        executor: { type: 'handler' },
      },
    ]);

    return mount('/mcp', expressMcp({ sources: [source], transport: { executors } }));
  }

  it('matches the API result byte-for-byte', async () => {
    const { app, ready } = appWithEchoTool();
    await ready;

    // Exactly the JSON-RPC envelope the Explorer's client script builds.
    const explorerShaped = {
      jsonrpc: '2.0',
      id: 'explorer-1',
      method: 'tools/call',
      params: { name: 'echo', arguments: { message: 'hello world' } },
    };
    // What any other MCP client would send for the same call.
    const clientShaped = { ...explorerShaped, id: 'client-1' };

    const viaExplorer = await request(app).post('/mcp').send(explorerShaped).expect(200);
    const viaClient = await request(app).post('/mcp').send(clientShaped).expect(200);

    // Byte-for-byte once the caller-chosen id is normalised — the Explorer has
    // no side channel and gets no privileged result shape.
    const normalise = (body: any) => JSON.stringify({ ...body, id: null });
    expect(normalise(viaExplorer.body)).toBe(normalise(viaClient.body));

    // And the result is the real executor's output, not a stub.
    const content = JSON.parse(viaExplorer.body.result.content[0].text);
    expect(content.echo).toBe('hello world');
  });

  it('invokes through the advertised basePath, so the page needs no private endpoint', async () => {
    const { app, ready } = appWithEchoTool();
    await ready;
    const model = extractModel((await request(app).get('/mcp/explorer').expect(200)).text);

    const res = await request(app)
      .post(model.basePath)
      .send({
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: { name: model.tools[0].name, arguments: { message: 'via advertised path' } },
      })
      .expect(200);

    expect(JSON.parse(res.body.result.content[0].text).echo).toBe('via advertised path');
  });
});

describe('production disable switch (§10.1 invariant 9)', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'production';
  });

  it('returns 404 by default when NODE_ENV=production', async () => {
    const { app, ready } = mount('/mcp', mcpFromOpenApi(PETSTORE));
    await ready;

    const res = await request(app).get('/mcp/explorer').expect(404);

    expect(res.body).toEqual({ error: 'Explorer not available in production' });
  });

  it('does not leak the tool surface in the production 404 body', async () => {
    const { app, ready } = mount('/mcp', mcpFromOpenApi(PETSTORE));
    await ready;

    const res = await request(app).get('/mcp/explorer').expect(404);

    expect(res.text).not.toContain('window.__EXPLORER__');
    expect(res.text).not.toContain('listPets');
  });

  it('still serves the Explorer when an operator opts in explicitly', async () => {
    const { app, ready } = mount('/mcp', mcpFromOpenApi({ spec: PETSTORE, enableExplorer: true }));
    await ready;

    const res = await request(app).get('/mcp/explorer').expect(200);

    expect(res.text).toContain('window.__EXPLORER__');
  });

  it('logs a startup warning naming the setting that enabled it', async () => {
    const { app, ready } = mount('/mcp', mcpFromOpenApi({ spec: PETSTORE, enableExplorer: true }));
    await ready;
    await request(app).get('/mcp/explorer').expect(200);

    const messages = warnings();
    expect(messages).toContain('enableExplorer: true');
    expect(messages).toMatch(/production/i);
  });

  it('does not warn when Explorer is enabled outside production', async () => {
    process.env['NODE_ENV'] = 'development';
    const { app, ready } = mount('/mcp', mcpFromOpenApi({ spec: PETSTORE, enableExplorer: true }));
    await ready;
    await request(app).get('/mcp/explorer').expect(200);

    const messages = warnings();
    expect(messages).not.toContain('enableExplorer: true');
  });

  it('does not warn when production simply uses the safe default', async () => {
    const { app, ready } = mount('/mcp', mcpFromOpenApi(PETSTORE));
    await ready;
    await request(app).get('/mcp/explorer').expect(404);

    const messages = warnings();
    expect(messages).not.toContain('enableExplorer: true');
  });
});
