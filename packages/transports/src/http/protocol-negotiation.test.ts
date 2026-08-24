// SPDX-License-Identifier: Apache-2.0
/**
 * Protocol-version negotiation at the transport (#61, §12.3).
 *
 * Before this, `initialize` read the client's requested `protocolVersion` and
 * threw it away: a client asking for a protocol we do not speak was answered
 * `2024-11-05` and allowed to proceed. The incompatibility then surfaced later
 * as a confusing shape mismatch instead of here as a clear refusal.
 *
 * The refusal is the interesting half, and §61 is specific about its FORM: not
 * `process.exit()`. The transport runs inside an adopter's own server process,
 * so exiting would let a remote client halt every unrelated route in their
 * application by sending one wrong field — a compatibility check that doubles
 * as a denial-of-service primitive.
 */

import { describe, it, expect } from '@jest/globals';
import { AtomicRegistryReference, MCP_PROTOCOL_VERSION } from '@askturret/mcp-core';
import type { RegistrySnapshot } from '@askturret/mcp-core';

import { createHttpTransport } from './index.js';

function emptySnapshot(): RegistrySnapshot {
  return { hash: 'sha256:test', version: 1, createdAt: new Date(), operations: new Map() };
}

/** Drive one JSON-RPC request through the transport's handler. */
async function rpc(body: unknown): Promise<{ status: number; json: any }> {
  const transport = createHttpTransport({
    registry: new AtomicRegistryReference(emptySnapshot()),
    basePath: '/mcp',
    session: 'inMemory',
  });

  const handler = transport.handler();
  const payload = JSON.stringify(body);

  const chunks: string[] = [];
  let status = 0;

  const req: any = {
    method: 'POST',
    url: '/mcp',
    headers: { host: 'localhost', 'content-type': 'application/json', accept: 'application/json' },
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data') cb(Buffer.from(payload));
      if (event === 'end') cb();
      return req;
    },
  };

  const res: any = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    setHeader() {
      return res;
    },
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) chunks.push(String(chunk));
      return res;
    },
  };

  await handler(req, res);
  await transport.close();

  const text = chunks.join('');
  const line = text.startsWith('data:')
    ? (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5).trim()
    : text;

  return { status, json: line ? JSON.parse(line) : undefined };
}

function initialize(protocolVersion?: unknown) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  };
}

describe('initialize protocol negotiation', () => {
  it('accepts the version it announces, and echoes it back', async () => {
    const { json } = await rpc(initialize(MCP_PROTOCOL_VERSION));

    expect(json.error).toBeUndefined();
    expect(json.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('accepts a client that omits protocolVersion entirely', async () => {
    // Common in practice, and not a statement of incompatibility.
    const { json } = await rpc(initialize());

    expect(json.error).toBeUndefined();
    expect(json.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('REFUSES an unsupported version instead of proceeding', async () => {
    const { json } = await rpc(initialize('1999-01-01'));

    expect(json.error).toBeDefined();
    expect(json.result).toBeUndefined();
    // -32602 Invalid params: well-formed JSON-RPC, unacceptable parameter.
    expect(json.error.code).toBe(-32602);
  });

  it('tells the client what it asked for and what is supported', async () => {
    // A refusal that does not say what would work sends an integrator reading
    // source. Both halves are machine-readable in `data`, not just prose.
    const { json } = await rpc(initialize('1999-01-01'));

    expect(json.error.message).toContain('1999-01-01');
    expect(json.error.data.requested).toBe('1999-01-01');
    expect(json.error.data.supported).toContain(MCP_PROTOCOL_VERSION);
  });

  it('refuses a non-string protocolVersion', async () => {
    const { json } = await rpc(initialize(20241105));

    expect(json.error).toBeDefined();
    expect(json.error.message).toContain('must be a string');
  });

  it('answers over HTTP rather than killing the process', async () => {
    // §61: the refusal must not be process.exit(). If it were, this test would
    // not reach its assertions at all — the runner would die with it. Reaching
    // them, with a response in hand, IS the assertion.
    const { status, json } = await rpc(initialize('1999-01-01'));

    expect(status).toBeGreaterThanOrEqual(200);
    expect(json).toBeDefined();
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(1);
  });

  it('does not announce a version it would refuse', async () => {
    // The most embarrassing shape of the original bug: announcing one version
    // while accepting another. Asserted end-to-end through the transport, not
    // just against the constants.
    const announced = (await rpc(initialize())).json.result.protocolVersion;
    const { json } = await rpc(initialize(announced));

    expect(json.error).toBeUndefined();
    expect(json.result.protocolVersion).toBe(announced);
  });
});
