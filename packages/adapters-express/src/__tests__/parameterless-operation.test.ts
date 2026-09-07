// SPDX-License-Identifier: Apache-2.0
/**
 * An operation that declares no parameters reaches `tools/list` (#717).
 *
 * "List all the things" is the most common read-endpoint shape there is, and a
 * parameterless GET was dropped from the registry entirely: `extractInputSchema`
 * returned `undefined` when an operation declared no parameters and no request
 * body, and `validate-invariants` (pass 8) treats a missing `input` as a missing
 * REQUIRED FIELD and skips the operation.
 *
 * The invariant is right — MCP requires `inputSchema` on every tool. What was
 * wrong is modelling "takes no arguments" as "has no schema" instead of as the
 * empty object schema `{"type":"object","properties":{}}`.
 *
 * ## The control matters more than the subject here
 *
 * `#717` names `listPets` as an example, and `listPets` in the shipped
 * `examples/petstore-light` spec is NOT parameterless — it declares a `limit`
 * query parameter, so it was never affected. The discriminator is the ABSENCE
 * of parameters, nothing else. `echoById` below is the control that pins that:
 * it differs from `ping` only by declaring one parameter, so if both vanish the
 * cause is something other than this defect and the test says so.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { mcpFromOpenApi } from '../index.js';

/**
 * Two operations differing ONLY in whether they declare parameters.
 *
 * Written to a temp file rather than committed as a fixture: the spec's whole
 * purpose is this one contrast, and keeping it beside the assertions is what
 * makes the contrast legible.
 */
const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Parameterless probe', version: '1.0.0' },
  servers: [{ url: 'http://127.0.0.1:9099/api' }],
  paths: {
    '/ping': {
      get: {
        operationId: 'ping',
        summary: 'Ping',
        description: 'Declares no parameters and no request body',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/echo/{id}': {
      get: {
        operationId: 'echoById',
        summary: 'Echo by id',
        description: 'Declares exactly one path parameter',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
};

let app: Express;
let specDir: string;

beforeAll(() => {
  specDir = mkdtempSync(join(tmpdir(), 'askturret-717-'));
  const specPath = join(specDir, 'probe.json');
  writeFileSync(specPath, JSON.stringify(SPEC), 'utf8');

  app = express();
  // No app-level `express.json()`: a global body parser consumes the request
  // stream the MCP transport reads for itself.
  app.use('/mcp', mcpFromOpenApi(specPath, { baseUrl: 'http://127.0.0.1:9099/api' }));
});

afterAll(() => {
  rmSync(specDir, { recursive: true, force: true });
});

async function toolsList(): Promise<Array<{ name: string; inputSchema?: unknown }>> {
  const response = await request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return (response.body?.result?.tools ?? []) as Array<{ name: string; inputSchema?: unknown }>;
}

describe('an operation with no parameters reaches the registry (#717)', () => {
  it('exposes the parameterless operation in tools/list', async () => {
    const names = (await toolsList()).map((t) => t.name);
    expect(names).toContain('ping');
  });

  it('still exposes the parameterised control operation', async () => {
    // If this ever fails, the cause is NOT #717 — both operations are gone and
    // something upstream of the parameter question broke.
    const names = (await toolsList()).map((t) => t.name);
    expect(names).toContain('echoById');
  });

  it('gives the parameterless operation an empty object input schema', async () => {
    const ping = (await toolsList()).find((t) => t.name === 'ping');
    // MCP requires `inputSchema` on every tool, so "takes no arguments" has to
    // be an empty object schema rather than an absent one.
    expect(ping?.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('does not mark any property required on the parameterless operation', async () => {
    const ping = (await toolsList()).find((t) => t.name === 'ping');
    // Assert presence FIRST. Without this the `required` check below passes
    // vacuously when `ping` is missing entirely — green for the very reason the
    // test exists, which is the decorative-guard shape.
    expect(ping).toBeDefined();
    const schema = ping?.inputSchema as { required?: unknown } | undefined;
    expect(schema?.required).toBeUndefined();
  });
});
