// SPDX-License-Identifier: Apache-2.0
/**
 * Config parity with the Express facade (§41: "the same options object works on
 * both facades, documented as the API contract").
 *
 * ## Why this file does not import Express
 *
 * The obvious test — build one options object, hand it to both facades, compare
 * — would make this package depend on Express purely to prove a type identity.
 * It would also test the weaker property: two DIFFERENT types that happen to
 * accept the same object today, which is exactly the drift §41 is trying to
 * prevent.
 *
 * Instead each adapter asserts that its own options type is the SAME TYPE as
 * core's `McpFacadeOptions` — assignable in both directions, which for
 * TypeScript means mutually identical. Express asserts the same thing in its
 * own suite. Identity is transitive, so together the two assertions prove
 * Express and Fastify share one type, with neither package depending on the
 * other.
 *
 * The defaults are checked the same way: against core's shared constants, which
 * are the ones both adapters actually apply.
 */

import { describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  FACADE_DEFAULT_BASE_PATH,
  FACADE_DEFAULT_DEADLINE_MS,
  FACADE_DEFAULT_MAX_REQUEST_BODY_SIZE,
  FACADE_DEFAULT_MAX_RESPONSE_SIZE,
  resolveFacadeDefaults,
  type McpFacadeOptions,
  type McpFromOpenApiFacadeOptions,
} from '@askturret/mcp-core';
import { fromOpenApi } from '@askturret/mcp-sources-openapi';

import { fastifyMcp, type FastifyMcpOptions, type McpFromOpenApiOptions } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PETSTORE = join(
  __dirname,
  '../../../sources-openapi/src/__tests__/fixtures/petstore.json',
);

/**
 * Compile-time mutual assignability. `Expect<Identical<A, B>>` fails to compile
 * if the two types ever diverge, so this test's real assertion runs in `tsc`;
 * the runtime body only proves the file executed.
 */
type Identical<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

// If either of these stops compiling, the facades have drifted apart and the
// "swap the import" promise is broken.
type _OptionsAreOneType = Expect<Identical<FastifyMcpOptions, McpFacadeOptions>>;
type _OneCallOptionsAreOneType = Expect<
  Identical<McpFromOpenApiOptions, McpFromOpenApiFacadeOptions>
>;

describe('config parity with the Express facade', () => {
  it('shares one options type with core (and therefore with Express)', () => {
    // The assertion is the two type aliases above; this keeps the file honest
    // as a test rather than a types-only module that Jest would skip.
    const witness: _OptionsAreOneType & _OneCallOptionsAreOneType = true;
    expect(witness).toBe(true);
  });

  it('applies the same Light preset defaults both facades use', () => {
    // Read from core's constants rather than hardcoded numbers: a test with its
    // own copy of `1048576` passes while the adapters drift away from it.
    const resolved = resolveFacadeDefaults({ sources: [] });

    expect(resolved.basePath).toBe(FACADE_DEFAULT_BASE_PATH);
    expect(resolved.maxRequestBodySize).toBe(FACADE_DEFAULT_MAX_REQUEST_BODY_SIZE);
    expect(resolved.maxResponseSize).toBe(FACADE_DEFAULT_MAX_RESPONSE_SIZE);
    expect(resolved.deadlineMs).toBe(FACADE_DEFAULT_DEADLINE_MS);
  });

  it('honours an explicit option over every default', () => {
    // The complement: a resolver that ignored its input would satisfy the test
    // above perfectly.
    const resolved = resolveFacadeDefaults({
      sources: [],
      basePath: '/tools',
      maxRequestBodySize: 42,
      maxResponseSize: 43,
      deadlineMs: 44,
      enableExplorer: false,
    });

    expect(resolved).toEqual({
      basePath: '/tools',
      maxRequestBodySize: 42,
      maxResponseSize: 43,
      deadlineMs: 44,
      enableExplorer: false,
    });
  });

  it('accepts a fully-populated shared options object at runtime', () => {
    // Typed as core's type, passed to the Fastify facade — so this would fail to
    // compile if the facade narrowed the surface, and fail at runtime if it
    // rejected a field it claims to accept.
    const shared: McpFacadeOptions = {
      sources: [fromOpenApi(PETSTORE)],
      basePath: '/mcp',
      include: '*',
      enableExplorer: false,
      maxRequestBodySize: 2048,
      maxResponseSize: 4096,
      deadlineMs: 5000,
    };

    expect(() => fastifyMcp(shared)).not.toThrow();
  });

  it("runs the same preset: 'production'-shaped config end to end", async () => {
    // §41 acceptance: "the same preset: 'production' config runs identically on
    // Express and Fastify". Explorer off, bounded payloads, explicit includes —
    // the shape a production deployment actually uses.
    const productionish: McpFacadeOptions = {
      sources: [fromOpenApi(PETSTORE)],
      enableExplorer: false,
      include: ['listPets'],
      maxRequestBodySize: 65536,
      maxResponseSize: 65536,
      deadlineMs: 10000,
    };

    const app = Fastify();
    await app.register(fastifyMcp(productionish), { prefix: '/mcp' });
    await app.ready();

    const tools = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    const explorer = await app.inject({ method: 'GET', url: '/mcp/explorer' });

    expect(JSON.parse(tools.body).result.tools.map((t: { name: string }) => t.name)).toEqual([
      'listPets',
    ]);
    expect(explorer.statusCode).toBe(404);

    await app.close();
  });
});
