/**
 * extractInputSchema() and the argumentless operation (#717)
 *
 * `packages/adapters-express/src/__tests__/parameterless-operation.test.ts`
 * asserts the user-visible outcome — a parameterless operation reaches
 * `tools/list`. This file pins the CONTRACT that produces it, one layer down,
 * so a future refactor of the extractor cannot quietly reintroduce the defect
 * and leave only an end-to-end failure to diagnose.
 *
 * The defect: returning `undefined` for an operation that declares no
 * parameters modelled "takes no arguments" as "has no schema", and
 * `validate-invariants` (pass 8) drops any operation missing a required
 * `input` field.
 *
 * The third case below is deliberately NOT the fix. It records the boundary —
 * see the comment on it.
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

/** Build a one-operation spec around the supplied operation object. */
function specWith(operation: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: '3.0.0',
    info: { title: 'Input schema probe', version: '1.0.0' },
    servers: [{ url: 'http://127.0.0.1:9099/api' }],
    paths: { '/thing': { get: operation, post: undefined } },
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

const OK_RESPONSES = {
  '200': {
    description: 'ok',
    content: { 'application/json': { schema: { type: 'object' } } },
  },
};

describe('extractInputSchema() — the argumentless operation (#717)', () => {
  it('yields an empty object schema when no parameters and no request body are declared', async () => {
    const op = await discoverOne(
      specWith({
        operationId: 'ping',
        description: 'Declares no parameters and no request body',
        responses: OK_RESPONSES,
      }),
    );
    // MCP requires `inputSchema` on every tool, so the honest encoding of
    // "takes no arguments" is an empty object schema — never `undefined`.
    expect(op.rawInput).toEqual({ type: 'object', properties: {} });
  });

  it('returns a distinct object per operation rather than one shared instance', async () => {
    const first = await discoverOne(
      specWith({ operationId: 'a', description: 'no parameters', responses: OK_RESPONSES }),
    );
    const second = await discoverOne(
      specWith({ operationId: 'b', description: 'no parameters', responses: OK_RESPONSES }),
    );
    // The schema is embedded in a compiled operation and frozen downstream; a
    // shared constant would alias every argumentless operation to one object.
    expect(first.rawInput).not.toBe(second.rawInput);
  });

  it('still builds a real schema when parameters ARE declared', async () => {
    const op = await discoverOne(
      specWith({
        operationId: 'echoById',
        description: 'Declares one path parameter',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: OK_RESPONSES,
      }),
    );
    expect(op.rawInput).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
  });

  it('leaves an unreadable request body as undefined rather than claiming it takes nothing', async () => {
    const op = await discoverOne(
      specWith({
        operationId: 'upload',
        description: 'Declares a request body with no usable schema',
        requestBody: { content: { 'application/octet-stream': {} } },
        responses: OK_RESPONSES,
      }),
    );
    // NOT the #717 fix, and deliberately so. Something WAS declared here and
    // could not be read, which is a different condition from "takes no
    // arguments" — presenting this tool as argumentless would invite a caller
    // to invoke it with nothing when it in fact needs input. Kept as existing
    // behaviour; see the PR for #717.
    expect(op.rawInput).toBeUndefined();
  });
});
