// SPDX-License-Identifier: Apache-2.0
/**
 * Fastify facade integration (§41).
 *
 * Drives a REAL Fastify instance through `inject`, which runs the full request
 * lifecycle — content-type parsing included. That matters more here than in the
 * Express suite: the single hardest part of this adapter is that Fastify parses
 * JSON bodies by default and the transport reads the RAW stream, and a test that
 * called the handler directly would skip the exact stage where those two meet.
 */

import { describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { mcpFromOpenApi, fastifyMcp } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PETSTORE = join(
  __dirname,
  '../../../sources-openapi/src/__tests__/fixtures/petstore.json',
);

async function petstoreApp(options?: Parameters<typeof mcpFromOpenApi>[1]) {
  const app = Fastify();
  await app.register(mcpFromOpenApi(PETSTORE, options), { prefix: '/mcp' });
  await app.ready();
  return app;
}

const rpc = (method: string, params: Record<string, unknown> = {}, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
});

describe('Fastify facade integration', () => {
  it('answers tools/list over a real POST', async () => {
    const app = await petstoreApp();

    const response = await app.inject({ method: 'POST', url: '/mcp', payload: rpc('tools/list') });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(Array.isArray(body.result.tools)).toBe(true);

    await app.close();
  });

  it('reads the request body at all — the failure mode is a HANG, not an error', async () => {
    // Fastify parses application/json by default. If the adapter did not install
    // a pass-through parser, `request.raw` would already be drained by the time
    // the transport attached its 'data'/'end' listeners: they would never fire,
    // the promise would never settle, and the request would hang until the
    // client gave up. Asserting a real body came back is what proves the raw
    // stream survived — and the timeout is what turns a hang into a failure
    // rather than a stuck suite.
    const app = await petstoreApp();

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result).toBeTruthy();

    await app.close();
  }, 10000);

  it('applies the Light preset: read-only tools exposed, mutations withheld', async () => {
    // Petstore has two read-only operations and one mutation (POST /pets).
    // Auto-exposing that mutation is precisely what the default prevents.
    const app = await petstoreApp();

    const response = await app.inject({ method: 'POST', url: '/mcp', payload: rpc('tools/list') });
    const names = JSON.parse(response.body).result.tools.map((t: { name: string }) => t.name);

    expect(names).toEqual(expect.arrayContaining(['listPets', 'getPet']));
    expect(names).not.toContain('createPet');

    await app.close();
  });

  it("includes mutations when the caller opts in with '*'", async () => {
    const app = await petstoreApp({ include: '*' });

    const response = await app.inject({ method: 'POST', url: '/mcp', payload: rpc('tools/list') });
    const names = JSON.parse(response.body).result.tools.map((t: { name: string }) => t.name);

    expect(names).toContain('createPet');

    await app.close();
  });

  it('serves the Explorer outside production and 404s inside it', async () => {
    const app = await petstoreApp();
    const dev = await app.inject({ method: 'GET', url: '/mcp/explorer' });

    expect(dev.statusCode).toBe(200);
    expect(dev.headers['content-type']).toMatch(/text\/html/);
    // A dev tool must not be cached or indexed.
    expect(dev.headers['cache-control']).toBe('no-store');
    expect(dev.headers['x-robots-tag']).toBe('noindex, nofollow');
    await app.close();

    const off = Fastify();
    await off.register(mcpFromOpenApi(PETSTORE, { enableExplorer: false }), { prefix: '/mcp' });
    await off.ready();

    expect((await off.inject({ method: 'GET', url: '/mcp/explorer' })).statusCode).toBe(404);
    await off.close();
  });

  it('waits for discovery before answering, rather than reporting an empty registry', async () => {
    // The race this guards is silent: an early caller gets tools: [] and reads
    // it as "this server exposes nothing", which is indistinguishable from a
    // misconfiguration. No `await app.ready()` warm-up here on purpose.
    const app = Fastify();
    await app.register(mcpFromOpenApi(PETSTORE), { prefix: '/mcp' });

    const response = await app.inject({ method: 'POST', url: '/mcp', payload: rpc('tools/list') });

    expect(JSON.parse(response.body).result.tools.length).toBeGreaterThan(0);

    await app.close();
  });

  it('accepts the composable form with an explicit source', async () => {
    const { fromOpenApi } = await import('@askturret/mcp-sources-openapi');
    const app = Fastify();

    await app.register(fastifyMcp({ sources: [fromOpenApi(PETSTORE)] }), { prefix: '/mcp' });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/mcp', payload: rpc('tools/list') });

    expect(JSON.parse(response.body).result.tools.length).toBeGreaterThan(0);

    await app.close();
  });
});
