// SPDX-License-Identifier: Apache-2.0
/**
 * Plugin encapsulation (§41: "respects encapsulation, doesn't leak scope to
 * sibling routes").
 *
 * This is the Fastify-specific risk, and it is not hypothetical. The adapter
 * installs a pass-through `application/json` content-type parser so the
 * transport can read the raw request stream. If that parser escaped its plugin
 * scope, every OTHER route in the host application would stop receiving a
 * parsed `request.body` and would instead receive a stream — silently, and
 * only for JSON requests.
 *
 * That failure would not look like an MCP bug. It would look like the host's
 * own handlers had broken, in an app that merely happened to mount MCP, and it
 * would be found by whoever owns those handlers rather than by whoever added
 * this plugin. Hence a test that proves the blast radius is zero.
 */

import { describe, it, expect } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { mcpFromOpenApi } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PETSTORE = join(
  __dirname,
  '../../../sources-openapi/src/__tests__/fixtures/petstore.json',
);

/** A host app with an ordinary JSON route mounted beside the MCP plugin. */
async function hostApp(): Promise<FastifyInstance> {
  const app = Fastify();

  // A sibling route registered on the ROOT scope. It relies on Fastify's normal
  // JSON parsing, exactly as a host app's own routes do.
  app.post('/api/echo', async (request) => ({
    receivedType: typeof request.body,
    isStream:
      typeof (request.body as { pipe?: unknown } | undefined)?.pipe === 'function',
    body: request.body,
  }));

  await app.register(mcpFromOpenApi(PETSTORE), { prefix: '/mcp' });
  await app.ready();
  return app;
}

describe('Fastify plugin encapsulation', () => {
  it('leaves a sibling route with a PARSED body, not the raw stream', async () => {
    // The load-bearing assertion. If `addContentTypeParser` leaked out of the
    // plugin scope, `request.body` here would be an unread stream and
    // `body.name` would be undefined — the host's route broken by a plugin it
    // mounted elsewhere.
    const app = await hostApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/echo',
      payload: { name: 'fluffy' },
    });

    const result = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(result.receivedType).toBe('object');
    expect(result.isStream).toBe(false);
    expect(result.body).toEqual({ name: 'fluffy' });

    await app.close();
  });

  it('serves MCP and the sibling route from the same app, both correctly', async () => {
    // Neither scope wins by disabling the other: the point is that both work at
    // once, which is the actual deployment shape.
    const app = await hostApp();

    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    const sibling = await app.inject({
      method: 'POST',
      url: '/api/echo',
      payload: { name: 'rex' },
    });

    expect(JSON.parse(mcp.body).result.tools.length).toBeGreaterThan(0);
    expect(JSON.parse(sibling.body).body).toEqual({ name: 'rex' });

    await app.close();
  });

  it('does not register MCP routes outside its prefix', async () => {
    // A plugin that leaked its routes would answer /explorer at the root.
    const app = await hostApp();

    expect((await app.inject({ method: 'GET', url: '/explorer' })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/',
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        })
      ).statusCode,
    ).toBe(404);

    await app.close();
  });

  it('does not decorate the parent instance', async () => {
    // `_init` is exposed for tests on the plugin's OWN encapsulated instance.
    // Finding it on the root would mean the plugin had been wrapped in
    // fastify-plugin, which is the one thing this adapter must not do.
    const app = await hostApp();

    expect((app as unknown as { _init?: unknown })._init).toBeUndefined();

    await app.close();
  });

  it('supports two independent MCP mounts in one app', async () => {
    // Only possible with real encapsulation: two plugin scopes, each with its
    // own registry and parser, neither clobbering the other.
    const app = Fastify();
    await app.register(mcpFromOpenApi(PETSTORE), { prefix: '/mcp-a' });
    await app.register(mcpFromOpenApi(PETSTORE, { include: '*' }), { prefix: '/mcp-b' });
    await app.ready();

    const call = async (url: string) =>
      JSON.parse(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
          })
        ).body,
      ).result.tools.map((t: { name: string }) => t.name);

    // Different include filters prove the two scopes really are independent.
    expect(await call('/mcp-a')).not.toContain('createPet');
    expect(await call('/mcp-b')).toContain('createPet');

    await app.close();
  });
});
