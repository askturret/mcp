/**
 * extractInputSchema() and the `content`-form parameter (#718)
 *
 * OpenAPI 3 lets a parameter carry its schema under either `schema` or
 * `content`, the latter being the documented form for complex serialization —
 * a JSON-valued query parameter is the common case, not an exotic one.
 *
 * The defect: the extractor read `param.schema` only, so a `content`-form
 * parameter yielded no property, the operation was built with no `rawInput`
 * key, and `validate-invariants` (pass 8) dropped it. `turret doctor` scored
 * the same spec 90 with zero findings and exit 0 — a clean bill of health on a
 * server that served nothing.
 *
 * ## Why this file drives `discover()` rather than the extractor directly
 *
 * `extractInputSchema` is private, and reaching past the entry point would let
 * the test pass while the real path stayed broken — the same reasoning as
 * `parameterless-input-schema.test.ts` next door, which this file mirrors
 * deliberately.
 *
 * ## The boundary cases are the point, not padding
 *
 * #735 left the "parameters declared but unreadable" branch returning
 * `undefined` on purpose, and that decision is correct: something was declared
 * and could not be read, so serving the tool as argumentless would invite a
 * caller to invoke it with nothing. This change NARROWS that branch; it must
 * not empty it. The last three cases are what hold that line, and they would
 * fail if a future edit made `content` support swallow the unreadable case too.
 */

import { describe, it, expect } from '@jest/globals';
import type { DiscoveryContext, DiscoveredOperation } from '@askturret/mcp-core';
import { fromOpenApi } from '../from-openapi.js';

function createTestContext(): DiscoveryContext {
  return {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    abortSignal: new AbortController().signal,
  };
}

/** Build a one-operation spec around the supplied parameter list. */
function specWithParameters(parameters: unknown[]): Record<string, unknown> {
  return {
    openapi: '3.0.0',
    info: { title: 'Content parameter probe', version: '1.0.0' },
    servers: [{ url: 'http://127.0.0.1:9099/api' }],
    paths: {
      '/things': {
        get: {
          operationId: 'listThings',
          description: 'Lists things',
          parameters,
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
}

async function discoverOne(spec: Record<string, unknown>): Promise<DiscoveredOperation> {
  const ops = await fromOpenApi(spec as never).discover(createTestContext());
  const first = ops[0];
  if (first === undefined) {
    throw new Error('spec produced no operations');
  }
  return first;
}

/** The exact shape QA reproduced against merged main. */
const CONTENT_PARAM = {
  name: 'filter',
  in: 'query',
  content: { 'application/json': { schema: { type: 'object' } } },
};

/** The same parameter differing in ONE input: schema-form instead. */
const SCHEMA_PARAM = {
  name: 'filter',
  in: 'query',
  schema: { type: 'object' },
};

describe('extractInputSchema() — the content-form parameter (#718)', () => {
  it('builds an input schema from a parameter whose schema lives under content', async () => {
    const op = await discoverOne(specWithParameters([CONTENT_PARAM]));
    // Without this the operation carries NO rawInput key at all, and pass 8
    // drops it for a missing required `input` — QA's measured SERVED 0.
    expect(op.rawInput).toEqual({
      type: 'object',
      properties: { filter: { type: 'object' } },
    });
  });

  it('produces the same schema as the schema-form parameter, which is the one varied input', async () => {
    // ADR-024 applied to the test itself: content and schema forms differ in
    // exactly one input, so an identical result attributes the fix to the
    // parameter form rather than to anything else in the spec.
    const viaContent = await discoverOne(specWithParameters([CONTENT_PARAM]));
    const viaSchema = await discoverOne(specWithParameters([SCHEMA_PARAM]));
    expect(viaContent.rawInput).toEqual(viaSchema.rawInput);
  });

  it('honours `required` on a content-form parameter', async () => {
    const op = await discoverOne(
      specWithParameters([{ ...CONTENT_PARAM, required: true }]),
    );
    expect(op.rawInput).toEqual({
      type: 'object',
      properties: { filter: { type: 'object' } },
      required: ['filter'],
    });
  });

  it('serves a content-form parameter alongside an ordinary schema-form one', async () => {
    const op = await discoverOne(
      specWithParameters([CONTENT_PARAM, { name: 'limit', in: 'query', schema: { type: 'integer' } }]),
    );
    expect(op.rawInput).toEqual({
      type: 'object',
      properties: { filter: { type: 'object' }, limit: { type: 'integer' } },
    });
  });

  it('drops a parameter whose content media type we cannot encode, keeping the readable one', async () => {
    // `buildQuery` serialises an object-valued query parameter with
    // JSON.stringify and has no other encoder, so serving an XML-declared
    // parameter would advertise a tool whose upstream request is malformed.
    // Omitting it is the correct outcome — the assertion is that the readable
    // sibling still survives, so this is a per-parameter decision rather than
    // the whole operation falling into the unreadable branch.
    const op = await discoverOne(
      specWithParameters([
        { name: 'blob', in: 'query', content: { 'application/xml': { schema: { type: 'object' } } } },
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
      ]),
    );
    expect(op.rawInput).toEqual({
      type: 'object',
      properties: { limit: { type: 'integer' } },
    });
  });

  it('still drops an operation whose only parameter is an unencodable content type (#735 boundary)', async () => {
    const op = await discoverOne(
      specWithParameters([
        { name: 'blob', in: 'query', content: { 'application/xml': { schema: { type: 'object' } } } },
      ]),
    );
    // Something WAS declared and cannot be served, so argumentless would be a
    // lie. #735's branch must still fire here.
    expect(op.rawInput).toBeUndefined();
  });

  it('still drops a parameter carrying neither schema nor content (#735 boundary)', async () => {
    const op = await discoverOne(specWithParameters([{ name: 'mystery', in: 'query' }]));
    expect(op.rawInput).toBeUndefined();
  });

  it('still drops a content-form parameter whose media type carries no schema (#735 boundary)', async () => {
    const op = await discoverOne(
      specWithParameters([{ name: 'filter', in: 'query', content: { 'application/json': {} } }]),
    );
    expect(op.rawInput).toBeUndefined();
  });
});
