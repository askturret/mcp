// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end executor wiring (#103).
 *
 * Before this, `mcpFromOpenApi` registered no executors, so every tools/call
 * failed with "No executor registered for type 'handler'" — the quick-start
 * path could list tools and invoke none.
 *
 * These tests run against a REAL local upstream rather than a mocked client, so
 * they assert the actual method and path that arrive on the wire. That matters:
 * a call can reach an executor and still issue completely the wrong request.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';

import { mcpFromOpenApi } from '../index.js';

/** Every request the stub upstream received. */
interface Hit {
  method: string;
  url: string;
}

let upstream: Server;
let upstreamUrl: string;
let hits: Hit[] = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '' });
    res.setHeader('Content-Type', 'application/json');

    if (req.url?.startsWith('/pets/')) {
      const id = decodeURIComponent(req.url.slice('/pets/'.length).split('?')[0] ?? '');
      res.writeHead(200);
      res.end(JSON.stringify({ id, name: 'Rex' }));
      return;
    }
    if (req.url?.startsWith('/pets')) {
      res.writeHead(200);
      res.end(JSON.stringify([{ id: '1', name: 'Rex' }]));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address() as AddressInfo;
  upstreamUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

/**
 * A minimal spec whose operations mirror the Petstore shapes that matter:
 * a collection GET with a query param, and an item GET with a path param.
 */
const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Pets', version: '1.0.0' },
  servers: [{ url: 'PLACEHOLDER' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List all pets in the store',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } } },
      },
    },
    '/pets/{petId}': {
      get: {
        operationId: 'getPetById',
        summary: 'Get a single pet by its identifier',
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
  },
};

function specWithServer(url: string) {
  return JSON.parse(JSON.stringify({ ...SPEC, servers: [{ url }] }));
}

function mount(router: express.Router) {
  const app = express();
  app.use('/mcp', router);
  const ready = ((router as unknown as { _init?: Promise<void> })._init ?? Promise.resolve()).catch(
    () => undefined,
  );
  return { app, ready };
}

function call(app: express.Express, name: string, args: Record<string, unknown> = {}) {
  return request(app)
    .post('/mcp')
    .send({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name, arguments: args } })
    .expect(200);
}

beforeEach(() => {
  hits = [];
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('mcpFromOpenApi executes tools (#103)', () => {
  it('no longer fails with "No executor registered"', async () => {
    const { app, ready } = mount(mcpFromOpenApi({ spec: specWithServer(upstreamUrl) as never }));
    await ready;

    const res = await call(app, 'listPets');

    // The exact regression: this used to be the only possible outcome.
    expect(JSON.stringify(res.body)).not.toContain('No executor registered');
    expect(res.body.error).toBeUndefined();
    expect(res.body.result).toBeDefined();
  });

  it('issues the method and path the spec declares, not POST /{operationId}', async () => {
    const { app, ready } = mount(mcpFromOpenApi({ spec: specWithServer(upstreamUrl) as never }));
    await ready;

    await call(app, 'listPets');

    expect(hits).toHaveLength(1);
    expect(hits[0]!.method).toBe('GET');
    expect(hits[0]!.url.split('?')[0]).toBe('/pets');
    // The pre-fix shape would have been POST /listPets.
    expect(hits[0]!.url).not.toContain('listPets');
  });

  it('substitutes a path parameter into the URL', async () => {
    const { app, ready } = mount(mcpFromOpenApi({ spec: specWithServer(upstreamUrl) as never }));
    await ready;

    const res = await call(app, 'getPetById', { petId: '42' });

    expect(hits[0]!.method).toBe('GET');
    expect(hits[0]!.url).toBe('/pets/42');
    expect(JSON.parse(res.body.result.content[0].text)).toEqual({ id: '42', name: 'Rex' });
  });

  it('passes non-path arguments as query parameters', async () => {
    const { app, ready } = mount(mcpFromOpenApi({ spec: specWithServer(upstreamUrl) as never }));
    await ready;

    await call(app, 'listPets', { limit: 5 });

    expect(hits[0]!.url).toBe('/pets?limit=5');
  });

  it('returns the upstream payload as the tool result', async () => {
    const { app, ready } = mount(mcpFromOpenApi({ spec: specWithServer(upstreamUrl) as never }));
    await ready;

    const res = await call(app, 'listPets');

    expect(JSON.parse(res.body.result.content[0].text)).toEqual([{ id: '1', name: 'Rex' }]);
  });

  it('honours an explicit baseUrl over the spec servers entry', async () => {
    const { app, ready } = mount(
      mcpFromOpenApi({
        spec: specWithServer('https://ignored.example.com') as never,
        baseUrl: upstreamUrl,
      }),
    );
    await ready;

    await call(app, 'listPets');

    // Reached our local upstream, not the spec's declared host.
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url.split('?')[0]).toBe('/pets');
  });
});

describe('unresolvable upstream', () => {
  it('lists tools but fails calls with an actionable message, not a generic internal error', async () => {
    // Relative server URL + a spec supplied inline: no origin to resolve against.
    const spec = JSON.parse(JSON.stringify({ ...SPEC, servers: [{ url: '/api/v1' }] }));
    const { app, ready } = mount(mcpFromOpenApi({ spec: spec as never }));
    await ready;

    // Discovery still works — the surface is browsable.
    const listed = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(200);
    expect(listed.body.result.tools.length).toBeGreaterThan(0);

    // The call fails, but says what to do about it.
    const res = await call(app, 'listPets');
    expect(res.body.error).toBeDefined();
    expect(res.body.error.message).toMatch(/base URL/i);
    expect(res.body.error.message).toContain('listPets');
    expect(res.body.error.message).not.toContain('No executor registered');

    // And nothing was sent anywhere.
    expect(hits).toHaveLength(0);
  });
});

describe('caller-supplied executors still win', () => {
  it('does not clobber an executor the caller registered for the same type', async () => {
    const { expressMcp } = await import('../index.js');
    const { fromDefinitions, viaHandler } = await import('@askturret/mcp-core');

    const source = fromDefinitions([
      {
        id: 'echo',
        name: 'echo',
        description: 'Echo the input back to the caller',
        input: { type: 'object', properties: { message: { type: 'string' } } },
        output: { type: 'object', properties: { echo: { type: 'string' } } },
        effects: {
          readOnly: true,
          idempotent: true,
          retryable: true,
          idempotencyKeyRequired: false,
          classifications: [],
        },
        executor: { type: 'http' },
      },
    ]);

    const { app, ready } = mount(
      expressMcp({
        sources: [source],
        transport: {
          executors: new Map([['http', viaHandler(async () => ({ echo: 'from caller executor' }))]]),
        },
      }),
    );
    await ready;

    const res = await call(app, 'echo', { message: 'hi' });

    expect(JSON.parse(res.body.result.content[0].text).echo).toBe('from caller executor');
    // The caller's executor ran instead of the default HTTP one.
    expect(hits).toHaveLength(0);
  });
});
