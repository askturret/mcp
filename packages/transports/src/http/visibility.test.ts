/**
 * tools/list visibility-policy wiring.
 *
 * The unit-level behaviour of the engine lives in core; these tests exercise
 * the wiring specifically — that the policy is actually consulted on the real
 * request path, that clientInfo reaches it, and that an unconfigured transport
 * behaves exactly as it did before the option existed.
 */

import { describe, it, expect } from '@jest/globals';
import { createHttpTransport } from './index.js';
import type { HttpTransport } from './types.js';
import {
  AtomicRegistryReference,
  authenticated,
  readOnly,
  type OperationDefinition,
  type Policy,
  type PolicyContext,
  type PolicyDecision,
  type PolicyMetrics,
  type PolicyPhase,
  type RegistrySnapshot,
} from '@askturret/mcp-core';

// ---------------------------------------------------------------------------
// Harness — mirrors the mocks in index.test.ts
// ---------------------------------------------------------------------------

class MockRequest {
  headers: Record<string, string> = { host: 'localhost' };
  method = 'POST';
  url = '/mcp';
  private chunks: Buffer[] = [];

  setBody(body: string) {
    this.chunks = [Buffer.from(body, 'utf-8')];
  }

  on(event: string, handler: (data?: any) => void) {
    if (event === 'data') this.chunks.forEach((chunk) => handler(chunk));
    else if (event === 'end') handler();
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = headers;
  }
  end(body: string) {
    this.body = body;
  }
  write(data: string) {
    this.body += data;
  }
}

function operation(id: string, readOnlyFlag: boolean): OperationDefinition {
  return {
    id,
    name: id,
    description: `operation ${id}`,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: readOnlyFlag,
      idempotent: readOnlyFlag,
      retryable: readOnlyFlag,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'handler' },
  };
}

/** Ten operations; the even-indexed ones are read-only. */
function snapshotOfTen(hash: string): RegistrySnapshot {
  const operations = new Map<string, OperationDefinition>();
  for (let i = 0; i < 10; i++) operations.set(`op${i}`, operation(`op${i}`, i % 2 === 0));
  return { version: 1, hash, createdAt: new Date(0), operations };
}

async function callToolsList(transport: HttpTransport, sessionId?: string): Promise<string[]> {
  const req = new MockRequest();
  if (sessionId) req.headers['x-session-id'] = sessionId;
  req.setBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  const res = new MockResponse();

  await transport.handler()(req as any, res as any);
  const parsed = JSON.parse(res.body);
  return (parsed.result?.tools ?? []).map((t: { name: string }) => t.name);
}

async function initialize(
  transport: HttpTransport,
  sessionId: string,
  clientInfo: unknown,
): Promise<void> {
  const req = new MockRequest();
  req.headers['x-session-id'] = sessionId;
  req.setBody(
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo } }),
  );
  await transport.handler()(req as any, new MockResponse() as any);
}

// ---------------------------------------------------------------------------

describe('tools/list visibility policy', () => {
  it('lists every operation when no policy is configured', async () => {
    // Adding the option must not change what an existing caller sees.
    const transport = createHttpTransport({ registry: new AtomicRegistryReference(snapshotOfTen('h1')) });
    expect(await callToolsList(transport)).toHaveLength(10);
  });

  it('a policy denying half of ten tools returns five', async () => {
    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotOfTen('h1')),
      visibilityPolicy: readOnly(),
    });

    const names = await callToolsList(transport);
    expect(names).toEqual(['op0', 'op2', 'op4', 'op6', 'op8']);
  });

  it('confirmation_required operations remain listed', async () => {
    const confirmAll: Policy = {
      id: 'confirmAll',
      evaluate: () =>
        Promise.resolve({
          effect: 'confirmation_required',
          challenge: { id: 'c', kind: 'acknowledge', prompt: 'confirm?' },
          evidence: [],
        }),
    };

    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotOfTen('h1')),
      visibilityPolicy: confirmAll,
    });

    expect(await callToolsList(transport)).toHaveLength(10);
  });

  it('evaluates at phase "discovery" with the snapshot hash', async () => {
    const seen: PolicyContext[] = [];
    const recorder: Policy = {
      id: 'recorder',
      evaluate: (ctx): Promise<PolicyDecision> => {
        seen.push(ctx);
        return Promise.resolve({ effect: 'allow', evidence: [] });
      },
    };

    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotOfTen('h-abc')),
      visibilityPolicy: recorder,
    });
    await callToolsList(transport);

    expect(seen).toHaveLength(10);
    expect(seen.every((c) => c.phase === 'discovery')).toBe(true);
    expect(seen.every((c) => c.registryHash === 'h-abc')).toBe(true);
    expect(seen.every((c) => c.input === undefined)).toBe(true);
  });

  it('hides everything when the policy throws, rather than listing everything', async () => {
    const thrower: Policy = { id: 't', evaluate: () => Promise.reject(new Error('boom')) };
    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotOfTen('h1')),
      visibilityPolicy: thrower,
    });

    expect(await callToolsList(transport)).toHaveLength(0);
  });

  it('passes clientInfo from the session through to the policy', async () => {
    // #33's PR flagged that DispatchContext drops clientInfo. At discovery the
    // session still holds it, so it IS reachable — this pins that.
    const seen: PolicyContext[] = [];
    const recorder: Policy = {
      id: 'recorder',
      evaluate: (ctx) => {
        seen.push(ctx);
        return Promise.resolve({ effect: 'allow', evidence: [] });
      },
    };

    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotOfTen('h1')),
      visibilityPolicy: recorder,
      session: 'inMemory',
    });

    await initialize(transport, 'sess-1', { name: 'claude', version: '1.2.3' });
    await callToolsList(transport, 'sess-1');

    expect(seen[0]?.clientInfo).toEqual({ name: 'claude', version: '1.2.3' });
  });

  it('leaves clientInfo undefined in stateless mode', async () => {
    const seen: PolicyContext[] = [];
    const recorder: Policy = {
      id: 'recorder',
      evaluate: (ctx) => {
        seen.push(ctx);
        return Promise.resolve({ effect: 'allow', evidence: [] });
      },
    };

    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotOfTen('h1')),
      visibilityPolicy: recorder,
    });
    await callToolsList(transport);

    expect(seen[0]?.clientInfo).toBeUndefined();
  });

  it('principal is undefined at discovery time in v0.1', async () => {
    // Asserted so the limitation is recorded rather than assumed. Nothing
    // carries a Principal onto the discovery path today, so a policy built
    // from authenticated() would hide every tool. Changing this needs a
    // discovery-time auth seam that does not exist yet.
    const seen: PolicyContext[] = [];
    const recorder: Policy = {
      id: 'recorder',
      evaluate: (ctx) => {
        seen.push(ctx);
        return Promise.resolve({ effect: 'allow', evidence: [] });
      },
    };

    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotOfTen('h1')),
      visibilityPolicy: recorder,
      session: 'inMemory',
    });
    await initialize(transport, 'sess-1', { name: 'c', version: '1' });
    await callToolsList(transport, 'sess-1');

    expect(seen[0]?.principal).toBeUndefined();
  });

  it('authenticated() consequently hides EVERY tool at discovery', async () => {
    // The consequence, asserted directly rather than inferred from principal
    // being undefined. This is the shape an adopter actually hits: a policy
    // that reads correctly returns an empty tool list, because discovery has
    // no principal to authenticate. Pinned so it is found here rather than in
    // somebody's integration.
    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotOfTen('h1')),
      visibilityPolicy: authenticated(),
      session: 'inMemory',
    });

    await initialize(transport, 'sess-1', { name: 'c', version: '1' });
    expect(await callToolsList(transport, 'sess-1')).toHaveLength(0);
  });

  // Cross-client cache poisoning, end to end through the real tools/list path.
  // Found in QA on PR #118.
  describe('two clients do not share a cached tool list', () => {
    const byClient: Policy = {
      id: 'byClient',
      evaluate: (ctx) =>
        Promise.resolve(
          ctx.clientInfo?.name === 'trusted'
            ? { effect: 'allow', evidence: [] }
            : { effect: 'deny', code: 'FORBIDDEN', safeReason: 'untrusted', evidence: [] },
        ),
    };

    async function twoClientTransport(): Promise<HttpTransport> {
      const transport = createHttpTransport({
        registry: new AtomicRegistryReference(snapshotOfTen('h1')),
        visibilityPolicy: byClient,
        session: 'inMemory',
      });
      await initialize(transport, 'trusted-sess', { name: 'trusted', version: '1' });
      await initialize(transport, 'untrusted-sess', { name: 'untrusted', version: '1' });
      return transport;
    }

    it('untrusted does not inherit the trusted list', async () => {
      const transport = await twoClientTransport();
      expect(await callToolsList(transport, 'trusted-sess')).toHaveLength(10);
      expect(await callToolsList(transport, 'untrusted-sess')).toHaveLength(0);
    });

    it('and trusted does not inherit the untrusted empty list', async () => {
      // The reverse order denies service rather than leaking it, and only one
      // of the two shows up if you test a single ordering.
      const transport = await twoClientTransport();
      expect(await callToolsList(transport, 'untrusted-sess')).toHaveLength(0);
      expect(await callToolsList(transport, 'trusted-sess')).toHaveLength(10);
    });
  });
});

describe('tools/list visibility caching', () => {
  function countingPolicy(): { policy: Policy; readonly calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      policy: {
        id: 'counting',
        evaluate: () => {
          calls++;
          return Promise.resolve({ effect: 'allow', evidence: [] });
        },
      },
    };
  }

  it('a repeated call on an unchanged snapshot evaluates once', async () => {
    const { policy, calls } = countingPolicy();
    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotOfTen('h1')),
      visibilityPolicy: policy,
    });

    await callToolsList(transport);
    expect(calls()).toBe(10);

    await callToolsList(transport);
    expect(calls()).toBe(10); // served from cache
  });

  it('swapping the snapshot re-evaluates', async () => {
    const { policy, calls } = countingPolicy();
    const registry = new AtomicRegistryReference(snapshotOfTen('h1'));
    const transport = createHttpTransport({ registry, visibilityPolicy: policy });

    await callToolsList(transport);
    expect(calls()).toBe(10);

    // The registry reference has no swap notification, so invalidation has to
    // come from the snapshot hash being part of the cache key.
    registry.swap(snapshotOfTen('h2'));

    await callToolsList(transport);
    expect(calls()).toBe(20);
  });

  it('a swap that changes the visible set is reflected immediately', async () => {
    const registry = new AtomicRegistryReference(snapshotOfTen('h1'));
    const transport = createHttpTransport({ registry, visibilityPolicy: readOnly() });

    expect(await callToolsList(transport)).toHaveLength(5);

    const allWritable = new Map<string, OperationDefinition>();
    for (let i = 0; i < 10; i++) allWritable.set(`op${i}`, operation(`op${i}`, false));
    registry.swap({ version: 2, hash: 'h2', createdAt: new Date(0), operations: allWritable });

    // A stale cache here would keep showing five tools that are no longer
    // read-only — the failure mode the hash-keyed cache exists to prevent.
    expect(await callToolsList(transport)).toHaveLength(0);
  });

  it('caching can be disabled per transport', async () => {
    const { policy, calls } = countingPolicy();
    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotOfTen('h1')),
      visibilityPolicy: policy,
      visibility: { ttlMs: 0 },
    });

    await callToolsList(transport);
    await callToolsList(transport);
    expect(calls()).toBe(20);
  });

  it('emits decision counts without any principal-identifying label', async () => {
    const seen: Array<[PolicyPhase, string]> = [];
    const metrics: PolicyMetrics = {
      recordDecision: (phase, effect) => seen.push([phase, effect]),
    };

    const transport = createHttpTransport({
      registry: new AtomicRegistryReference(snapshotOfTen('h1')),
      visibilityPolicy: readOnly(),
      visibility: { metrics },
    });
    await callToolsList(transport);

    expect(seen).toHaveLength(10);
    expect(seen.filter(([, e]) => e === 'allow')).toHaveLength(5);
    expect(seen.filter(([, e]) => e === 'deny')).toHaveLength(5);
    expect(seen.every(([phase]) => phase === 'discovery')).toBe(true);
  });
});
