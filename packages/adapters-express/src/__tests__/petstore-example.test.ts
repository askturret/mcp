// SPDX-License-Identifier: Apache-2.0
/**
 * The shipped petstore-light example is end-to-end callable (#99).
 *
 * `executor-wiring.test.ts` next door proves the executor MECHANISM against a
 * synthetic inline spec. This file proves something narrower and easier to break
 * by accident: that the spec we actually ship in `examples/petstore-light`
 * compiles through the real facade and answers a `tools/call` when pointed at a
 * backend implementing it.
 *
 * Before #99 the example could only demonstrate `tools/list`. Its spec names the
 * fictional `petstore.example.com`, so a call returned `UPSTREAM_UNAVAILABLE` —
 * well-formed, and a poor first impression for a 5-minute quick start. The
 * example now serves that API locally and passes `baseUrl`; this asserts the
 * combination works, and keeps working.
 *
 * ## Why the example's own index.js is not imported here
 *
 * `examples/petstore-light` is a demo app, not a library: it declares
 * `askturret.testsNotRequired` and points its coverage at this package, and it
 * calls `app.listen()` at import time. So this test reproduces the example's
 * backend SEMANTICS (three pets, `limit`, a 404) against the example's REAL
 * spec file, rather than importing its server. The wiring in `index.js` is
 * therefore not itself asserted — what is asserted is that the spec it ships
 * remains callable, which is the part that breaks silently.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { dirname, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';

import { mcpFromOpenApi } from '../index.js';

/**
 * Locate the example relative to THIS module, not to `process.cwd()` — which is
 * the package root under `npm test` and the repo root under other runners. Same
 * reasoning as `packages/reliability`'s `petstoreSpecPath()`, which resolves the
 * very same file.
 */
function exampleDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/__tests__ (ts-jest) or dist/__tests__ (built) -> package -> packages -> repo
  return resolvePath(here, '../../../..', 'examples/petstore-light');
}

const SPEC_PATH = resolvePath(exampleDir(), 'openapi.yaml');

/** The example's seed data, mirrored so `limit` and the 404 are exercised. */
const PETS = [
  { id: 'pet-1', name: 'Rex', species: 'dog', age: 3 },
  { id: 'pet-2', name: 'Mittens', species: 'cat', age: 5 },
  { id: 'pet-3', name: 'Kiwi', species: 'bird', age: 1 },
];

let upstream: Server;
let upstreamUrl: string;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    res.setHeader('Content-Type', 'application/json');

    const itemMatch = /^\/pets\/(.+)$/.exec(url.pathname);
    if (itemMatch) {
      const pet = PETS.find((p) => p.id === decodeURIComponent(itemMatch[1]!));
      if (!pet) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(pet));
      return;
    }

    if (url.pathname === '/pets') {
      const raw = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
      const limit = Number.isNaN(raw) ? 20 : Math.min(Math.max(raw, 1), 100);
      res.writeHead(200);
      res.end(JSON.stringify({ pets: PETS.slice(0, limit), total: PETS.length }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address() as AddressInfo;
  upstreamUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Mount the example's spec exactly as the example does: one call, plus baseUrl. */
function mountExample() {
  const router = mcpFromOpenApi(SPEC_PATH, { baseUrl: `${upstreamUrl}` });
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

describe('petstore-light example (#99)', () => {
  it('lists the two operations the shipped spec declares', async () => {
    const { app, ready } = mountExample();
    await ready;

    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(200);

    const names = (res.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(['getPetById', 'listPets']);
  });

  it('answers tools/call for listPets instead of failing upstream', async () => {
    const { app, ready } = mountExample();
    await ready;

    const res = await call(app, 'listPets', { limit: 2 });

    // The exact regression #99 describes: a call that could not succeed.
    expect(res.body.error).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('UPSTREAM_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('No executor registered');

    const payload = JSON.parse(res.body.result.content[0].text);
    // `limit` was honoured by the upstream, and `total` still reports the full
    // count — the distinction the README points out.
    expect(payload.pets).toHaveLength(2);
    expect(payload.total).toBe(3);
    expect(payload.pets[0].name).toBe('Rex');
  });

  it('answers tools/call for getPetById, substituting the path parameter', async () => {
    const { app, ready } = mountExample();
    await ready;

    const res = await call(app, 'getPetById', { petId: 'pet-2' });

    expect(res.body.error).toBeUndefined();
    expect(JSON.parse(res.body.result.content[0].text)).toEqual({
      id: 'pet-2',
      name: 'Mittens',
      species: 'cat',
      age: 5,
    });
  });

  it('keeps the shipped spec pointing at an illustrative host, not at localhost', () => {
    // The spec is shared with packages/reliability, which compiles this same
    // file. Repointing its `servers` entry at 127.0.0.1 to make the example work
    // would couple a shared fixture to one example's local wiring — the local
    // override belongs in `baseUrl`. This asserts we did not take that shortcut.
    const spec = readFileSync(SPEC_PATH, 'utf8');
    expect(spec).toContain('petstore.example.com');
    expect(spec).not.toContain('127.0.0.1');
    expect(spec).not.toContain('localhost');
  });
});
