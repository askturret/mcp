// SPDX-License-Identifier: Apache-2.0
/**
 * The shared conformance test bank (§12.2, §42).
 *
 * Eight categories, run identically against every registered adapter. Nothing
 * here imports a framework — every assertion is made over JSON-RPC on a real
 * socket, because that is the only surface a user depends on and the only one
 * where "Express and Fastify behave the same" is a meaningful claim.
 *
 * ## Categories whose §42 wording is not implementable as written
 *
 * Recorded here rather than quietly reinterpreted, because a conformance suite
 * that silently narrows its own contract is worse than one that reports a gap:
 * it produces a green result whose meaning nobody can check.
 *
 * 1. DISCOVERY — §42 asks for an "identical hash across both adapters". The
 *    registry hash is NOT exposed over the wire: `initialize` returns only
 *    protocolVersion, serverInfo{name,version} and capabilities
 *    (transports/src/http/index.ts:290-302), and the hash lives on the
 *    server-side `OperationCommand`. Reaching for it would mean importing
 *    adapter internals and ending this bank's framework-neutrality. The
 *    observable equivalent — both adapters exposing the SAME discovered
 *    surface — is asserted across adapters in `conformance.test.ts`.
 *
 * 3. CONTEXT PROPAGATION — §42 asks for "request headers -> HandlerContext.headers".
 *    `HandlerContext` does not exist anywhere in this repository (verified: no
 *    match in any .ts or .md outside node_modules/dist). The type the dispatcher
 *    actually builds is `OperationCommand`, and it has no `headers` field. So
 *    the header half is not merely untested, it is unexpressible. The other two
 *    halves — deadline -> executor `AbortSignal`, principal -> policy — are real
 *    and ARE asserted.
 *
 * 4. CANCELLATION — §42 asks that the "server returns CANCELLED". A client that
 *    has aborted its request cannot observe the response to it; that is what
 *    aborting means. What IS observable, and what this bank asserts, is that the
 *    executor's `AbortSignal` fires — the propagation the category is really
 *    about.
 *
 * 6. AUTHORIZATION CONTEXT — §42 asks for "a `preset: 'production'` server".
 *    The facade options have no `preset` field; `bootstrapRegistry` hardcodes
 *    the light preset. The BEHAVIOUR (refuse `tools/call` without a principal)
 *    is expressible through hooks and that is what is asserted — via
 *    `authorize` returning a `shortCircuit` HookDecision, NOT via a throwing
 *    `authenticate`. `AuthenticateHook` returns `Principal | undefined`; making
 *    it throw surfaces as INTERNAL_ERROR, which asserts a different thing
 *    entirely and would have passed a sloppier regex.
 *
 * 8. DUPLICATE HANDLING — the deterministic winner is observable over the wire
 *    and is asserted. The `DUPLICATE_OPERATION_ID` warning is emitted into the
 *    compiler's warning collector, which the facade discards, so it never
 *    reaches a client. Asserted as far as the wire allows; the warning half is
 *    flagged.
 */

import type {
  McpFacadeOptions,
  OperationExecutor,
  OperationResult,
  OperationSource,
} from '@askturret/mcp-core';
import type { AdapterFactory, ConformanceServer } from './registry.js';

// ---------------------------------------------------------------------------
// Wire helpers — the bank's entire vocabulary
// ---------------------------------------------------------------------------

let nextId = 1;

export interface RpcResponse {
  readonly status: number;
  readonly body: {
    result?: { tools?: { name: string; inputSchema?: unknown }[]; [k: string]: unknown };
    error?: { code: number; message: string; data?: unknown };
    [k: string]: unknown;
  };
}

export async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  init: RequestInit = {},
): Promise<RpcResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    ...init,
  });

  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : {} };
}

/** Call a tool and return the raw JSON-RPC envelope. */
export function callTool(url: string, name: string, args: Record<string, unknown> = {}) {
  return rpc(url, 'tools/call', { name, arguments: args });
}

// ---------------------------------------------------------------------------
// Fixtures — deliberately built in-process, not read from an OpenAPI file
// ---------------------------------------------------------------------------

/**
 * A source of explicit operations.
 *
 * Hand-built rather than compiled from the Petstore spec, because several
 * categories need an operation whose SCHEMA or EFFECTS are exactly known
 * (a nested optional readonly field; a mutation; a duplicate id). Deriving
 * those from a spec would make the assertions depend on the OpenAPI pipeline
 * as well as on the adapter — so a compiler change would fail the ADAPTER
 * conformance suite, pointing at the wrong layer.
 */
export function staticSource(
  id: string,
  operations: readonly {
    id: string;
    readOnly?: boolean;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  }[],
  sourceKind = 'explicit',
): OperationSource {
  return {
    id,
    discover: async () =>
      operations.map((op) => ({
        candidateId: op.id,
        name: op.id,
        description: `Operation ${op.id}`,
        source: { kind: sourceKind, location: `${id}:${op.id}` },
        rawInput: op.input ?? { type: 'object', properties: {} },
        rawOutput: op.output ?? { type: 'object', properties: {} },
        hints: { readOnly: op.readOnly ?? true },
      })) as never,
  } as OperationSource;
}

/** The §42 category-2 schema: nested, optional, readonly. */
export const NESTED_SCHEMA = {
  type: 'object',
  properties: {
    nested: {
      type: 'object',
      properties: {
        optional: {
          type: 'object',
          properties: {
            readonly: { type: 'string', readOnly: true },
          },
        },
      },
    },
  },
} as const;

/** An executor that records what the dispatcher handed it. */
export interface RecordingExecutor {
  readonly executor: OperationExecutor;
  readonly calls: {
    deadline?: Date;
    signalAborted: () => boolean;
    principalId?: string;
    requestId?: string;
  }[];
  /** Resolves once the executor has been entered at least once. */
  entered(): Promise<void>;
}

export function recordingExecutor(
  behaviour: (signal: AbortSignal) => Promise<OperationResult> = async () => ({
    ok: true,
    value: { ok: true },
  }),
): RecordingExecutor {
  const calls: RecordingExecutor['calls'] = [];
  let signalEntered: () => void = () => undefined;
  const enteredPromise = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });

  // The real contract is `execute(operation, input, context)` — THREE
  // arguments, with deadline/signal/principal on the CONTEXT, not on a single
  // command object. An earlier version of this recorder took one argument and
  // read `deadline` off the OperationDefinition, so it recorded `undefined`
  // and category 3 failed for a reason that had nothing to do with either
  // adapter. Worth stating because the single-object shape is the intuitive
  // guess and it fails silently rather than at the type boundary.
  const executor: OperationExecutor = {
    execute: async (
      _operation: unknown,
      _input: unknown,
      context: {
        deadline?: Date;
        signal?: AbortSignal;
        principal?: { id?: string };
        requestId?: string;
      },
    ) => {
      const signal = context.signal ?? new AbortController().signal;
      calls.push({
        ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
        signalAborted: () => signal.aborted,
        ...(context.principal?.id === undefined ? {} : { principalId: context.principal.id }),
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      });
      signalEntered();
      return behaviour(signal);
    },
  } as unknown as OperationExecutor;

  return { executor, calls, entered: () => enteredPromise };
}

/** Facade options wired to a recording executor rather than a real upstream. */
export function optionsWith(
  sources: OperationSource[],
  executor: OperationExecutor,
  extra: Partial<McpFacadeOptions> = {},
): McpFacadeOptions {
  return {
    sources,
    include: '*',
    enableExplorer: false,
    // `apply-preset-defaults` defaults executor.type to 'handler' when a
    // discovered operation declares none, which is the case for these
    // in-process fixtures. Registered under all three so the fixture cannot
    // fail for a reason that has nothing to do with the adapter.
    transport: {
      executors: new Map([
        ['handler', executor],
        ['explicit', executor],
        ['http', executor],
      ]),
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The bank
// ---------------------------------------------------------------------------

export interface CategoryContext {
  readonly adapter: string;
  readonly start: (options: McpFacadeOptions) => Promise<ConformanceServer>;
}

export interface Category {
  readonly id: number;
  readonly name: string;
  /** Throws on failure, like an assertion. Returns a note for the report. */
  run(ctx: CategoryContext): Promise<string>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Bound any wait that depends on a server noticing something.
 *
 * Every await in this bank that is not a plain request/response goes through
 * one of these two helpers. A conformance suite that can HANG reports nothing —
 * CI shows a timeout, the table never prints, and the blame lands on whichever
 * adapter happened to be running. Failing loudly with a reason is strictly
 * better than waiting forever with none.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} (after ${ms}ms)`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Poll a predicate until true or the budget runs out. Returns the result. */
async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

export const CATEGORIES: readonly Category[] = [
  {
    id: 1,
    name: 'discovery',
    async run({ start }) {
      const server = await start(
        optionsWith([staticSource('a', [{ id: 'alpha' }, { id: 'beta' }])], recordingExecutor().executor),
      );
      try {
        const list = await rpc(server.url, 'tools/list');
        const names = (list.body.result?.tools ?? []).map((t) => t.name).sort();
        assert(names.length === 2, `expected 2 operations, got ${names.length}`);
        assert(names.join(',') === 'alpha,beta', `unexpected operations: ${names.join(',')}`);

        // §42 asks for "identical hash across both adapters". The registry
        // hash is NOT exposed over the wire: `initialize` returns only
        // protocolVersion, serverInfo{name,version} and capabilities
        // (transports/src/http/index.ts:290-302), and the hash lives on the
        // server-side OperationCommand. Asserting it here would mean importing
        // adapter internals, which would end this bank's framework-neutrality.
        //
        // The observable equivalent — that both adapters expose the SAME
        // discovered surface — is asserted across adapters in
        // `conformance.test.ts`, which is where a cross-adapter comparison
        // belongs anyway. Flagged rather than silently dropped.
        const init = await rpc(server.url, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'conformance', version: '1.0.0' },
        });
        const serverInfo = (init.body.result as { serverInfo?: { name?: string } })?.serverInfo;
        assert(typeof serverInfo?.name === 'string', 'initialize returned no serverInfo.name');

        return `2 operations (alpha, beta); serverInfo=${serverInfo.name}`;
      } finally {
        await server.close();
      }
    },
  },

  {
    id: 2,
    name: 'schema-preservation',
    async run({ start }) {
      const server = await start(
        optionsWith(
          [staticSource('a', [{ id: 'nestedOp', input: NESTED_SCHEMA as unknown as Record<string, unknown> }])],
          recordingExecutor().executor,
        ),
      );
      try {
        const list = await rpc(server.url, 'tools/list');
        const tool = (list.body.result?.tools ?? []).find((t) => t.name === 'nestedOp');
        assert(tool !== undefined, 'nestedOp missing from tools/list');

        const schema = tool.inputSchema as Record<string, any>;
        const leaf = schema?.['properties']?.nested?.properties?.optional?.properties?.readonly;
        assert(leaf !== undefined, 'nested.optional.readonly was lost end to end');
        assert(leaf.type === 'string', `leaf type changed to ${String(leaf.type)}`);

        return 'nested.optional.readonly survived';
      } finally {
        await server.close();
      }
    },
  },

  {
    id: 3,
    name: 'context-propagation',
    async run({ start }) {
      // Headers are NOT asserted — see the file header. There is no
      // HandlerContext and no headers field on OperationCommand.
      const rec = recordingExecutor();
      const server = await start(
        optionsWith([staticSource('a', [{ id: 'ctxOp' }])], rec.executor, { deadlineMs: 5000 }),
      );
      try {
        const before = Date.now();
        await callTool(server.url, 'ctxOp');

        assert(rec.calls.length === 1, `executor entered ${rec.calls.length} times, expected 1`);
        const call = rec.calls[0]!;

        assert(call.deadline instanceof Date, 'no deadline propagated to the executor');
        const delta = call.deadline.getTime() - before;
        assert(delta > 0 && delta <= 6000, `deadline ${delta}ms outside the configured 5000ms`);
        assert(typeof call.requestId === 'string', 'no requestId propagated');

        return `deadline +${delta}ms, requestId propagated`;
      } finally {
        await server.close();
      }
    },
  },

  {
    id: 4,
    name: 'cancellation',
    async run({ start }) {
      // Asserts the executor's AbortSignal fires. "Server returns CANCELLED" is
      // unobservable by a client that aborted — see the file header.
      const cancelled = { ok: false, error: { code: 'CANCELLED', message: 'aborted' } } as const;
      const rec = recordingExecutor(
        (signal) =>
          new Promise((resolve) => {
            if (signal.aborted) return resolve(cancelled as never);
            signal.addEventListener('abort', () => resolve(cancelled as never));
            // Safety valve. The abort is the intended exit, but an executor with
            // NO other exit turns "the signal did not propagate" — the very bug
            // this category exists to catch — into a hang instead of a failure.
            setTimeout(() => resolve(cancelled as never), 8000).unref?.();
          }),
      );
      const server = await start(optionsWith([staticSource('a', [{ id: 'slowOp' }])], rec.executor));
      try {
        // EXACTLY ONE request, and it is the one that gets aborted.
        //
        // An earlier version of this category also started a second request it
        // never aborted. That connection stayed open, and `server.close()`
        // waits for open connections — so the whole suite hung rather than
        // failing. A conformance test that can hang is worse than one that
        // fails: CI reports nothing at all, and the timeout gets blamed on the
        // adapter rather than on the test.
        const controller = new AbortController();
        const pending = fetch(server.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 999,
            method: 'tools/call',
            params: { name: 'slowOp', arguments: {} },
          }),
          signal: controller.signal,
        }).catch(() => undefined);

        await withTimeout(rec.entered(), 5000, 'executor was never entered');
        controller.abort();
        await pending;

        // The server observes the closed socket asynchronously. Poll rather
        // than sleep a fixed amount: a fixed sleep is either flaky or slow, and
        // picking between those is a choice nobody revisits.
        const aborted = await waitFor(() => rec.calls.some((c) => c.signalAborted()), 5000);
        assert(aborted, 'client abort did not reach the executor AbortSignal');

        return 'client abort reached the executor signal';
      } finally {
        // `destroy` rather than a graceful close: this category deliberately
        // leaves a half-dead connection behind, and a graceful close would wait
        // for it.
        await server.close();
      }
    },
  },

  {
    id: 5,
    name: 'error-mapping',
    async run({ start }) {
      const codes = [
        'INVALID_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'CONFIRMATION_REQUIRED',
        'RATE_LIMITED', 'QUEUE_FULL', 'TIMEOUT', 'CANCELLED',
        'UPSTREAM_UNAVAILABLE', 'OUTCOME_UNKNOWN', 'OUTPUT_TOO_LARGE', 'INTERNAL_ERROR',
      ] as const;

      let current: string = codes[0];
      const rec = recordingExecutor(async () => ({
        ok: false,
        error: { code: current as never, message: `synthetic ${current}` },
      }));
      const server = await start(optionsWith([staticSource('a', [{ id: 'errOp' }])], rec.executor));

      try {
        const seen: string[] = [];
        for (const code of codes) {
          current = code;
          const response = await callTool(server.url, 'errOp');

          // Every code must produce a STRUCTURED error the client can branch on
          // — not a 500, and not a success envelope carrying an error inside.
          const payload = JSON.stringify(response.body);
          assert(payload.includes(code), `${code} did not survive to the wire: ${payload.slice(0, 160)}`);
          seen.push(code);
        }

        assert(seen.length === codes.length, `mapped ${seen.length}/${codes.length} codes`);
        return `all ${codes.length} OperationErrorCode values reached the wire`;
      } finally {
        await server.close();
      }
    },
  },

  {
    id: 6,
    name: 'authorization-context',
    async run({ start }) {
      // Expressed through hooks.authenticate — the facade has no `preset`
      // option. See the file header.
      const rec = recordingExecutor();
      const server = await start(
        optionsWith([staticSource('a', [{ id: 'guardedOp' }])], rec.executor, {
          // `authenticate` returns `Principal | undefined` and does NOT throw
          // to deny — throwing surfaces as INTERNAL_ERROR, which is a different
          // claim entirely. Refusal is an `authorize` shortCircuit.
          hooks: {
            authenticate: async () => undefined,
            authorize: async (context: { principal?: unknown }) =>
              context.principal === undefined
                ? {
                    shortCircuit: true as const,
                    result: {
                      ok: false as const,
                      error: { code: 'UNAUTHENTICATED' as const, message: 'principal required' },
                    },
                  }
                : { continue: true as const },
          } as unknown as NonNullable<McpFacadeOptions['hooks']>,
        }),
      );
      try {
        const response = await callTool(server.url, 'guardedOp');
        const payload = JSON.stringify(response.body);

        assert(
          /UNAUTHENTICATED|unauthenticated|no principal/i.test(payload),
          `unauthenticated call was not refused: ${payload.slice(0, 200)}`,
        );
        assert(rec.calls.length === 0, 'executor ran despite the call being refused');

        return 'tools/call refused without a principal; executor never reached';
      } finally {
        await server.close();
      }
    },
  },

  {
    id: 7,
    name: 'lifecycle-cleanup',
    async run({ start }) {
      const rec = recordingExecutor();
      const server = await start(optionsWith([staticSource('a', [{ id: 'op' }])], rec.executor));

      await rpc(server.url, 'tools/list');
      await server.close();

      // The socket must actually be released: a subsequent request has nothing
      // to connect to. A close() that resolved while the listener stayed open
      // would leave the port bound and the process unable to exit.
      let refused = false;
      try {
        await rpc(server.url, 'tools/list');
      } catch {
        refused = true;
      }
      assert(refused, 'server still accepted a request after close()');

      return 'close() released the listening socket';
    },
  },

  {
    id: 8,
    name: 'duplicate-handling',
    async run({ start }) {
      // Two sources, overlapping id. The winner is decided by source precedence
      // and must be the SAME on both adapters. The DUPLICATE_OPERATION_ID
      // warning is not observable over the wire — see the file header.
      const server = await start(
        optionsWith(
          [
            staticSource('first', [{ id: 'shared', input: { type: 'object', properties: { fromFirst: { type: 'string' } } } }], 'openapi'),
            staticSource('second', [{ id: 'shared', input: { type: 'object', properties: { fromSecond: { type: 'string' } } } }], 'explicit'),
          ],
          recordingExecutor().executor,
        ),
      );
      try {
        const list = await rpc(server.url, 'tools/list');
        const tools = (list.body.result?.tools ?? []).filter((t) => t.name === 'shared');

        assert(tools.length === 1, `duplicate id produced ${tools.length} tools, expected exactly 1`);

        const schema = tools[0]!.inputSchema as Record<string, any>;
        const props = schema?.['properties'] as Record<string, unknown> | undefined;
        const winner = props?.['fromFirst'] ? 'openapi' : props?.['fromSecond'] ? 'explicit' : 'unknown';
        assert(winner !== 'unknown', 'could not identify which source won');

        return `deterministic winner: ${winner}`;
      } finally {
        await server.close();
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface CategoryResult {
  readonly adapter: string;
  readonly category: string;
  readonly id: number;
  readonly passed: boolean;
  readonly note: string;
}

export interface RunBankOptions {
  /**
   * Category names to run. Absent means all of them.
   *
   * Added for the #54 kit's `--category` filter, and it lives HERE rather than
   * in the kit deliberately. The alternative is a second runner loop, and two
   * loops over the same categories drift — one would eventually catch an error
   * differently, or record a note differently, and a community adapter would
   * get a subtly different verdict from the same assertions. A single runner is
   * what makes "reuses the bank verbatim" true rather than aspirational.
   */
  readonly categories?: readonly string[];
}

/** Names that are not categories in the bank. For rejecting a bad filter. */
export function unknownCategories(names: readonly string[]): readonly string[] {
  const known = new Set(CATEGORIES.map((c) => c.name));
  return names.filter((name) => !known.has(name));
}

export async function runBank(
  adapter: string,
  factory: AdapterFactory,
  options?: RunBankOptions,
): Promise<readonly CategoryResult[]> {
  const results: CategoryResult[] = [];
  const wanted = options?.categories;
  const selected =
    wanted === undefined ? CATEGORIES : CATEGORIES.filter((c) => wanted.includes(c.name));

  for (const category of selected) {
    try {
      const note = await category.run({ adapter, start: factory });
      results.push({ adapter, category: category.name, id: category.id, passed: true, note });
    } catch (error) {
      results.push({
        adapter,
        category: category.name,
        id: category.id,
        passed: false,
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * Side-by-side comparison table (§42 "parity failures produce a comparison
 * table in the output", and Acceptance "CI shows both adapters' results side
 * by side").
 *
 * Rendered ALWAYS, not only on failure: a table that appears only when
 * something breaks cannot be used to confirm that something passed.
 */
export function renderTable(results: readonly CategoryResult[]): string {
  const adapters = [...new Set(results.map((r) => r.adapter))].sort();
  const categories = CATEGORIES.map((c) => c.name);
  const width = Math.max(...categories.map((c) => c.length), 'category'.length);

  const lines = [
    `${'category'.padEnd(width)} | ${adapters.map((a) => a.padEnd(9)).join(' | ')} | parity`,
    `${'-'.repeat(width)}-+-${adapters.map(() => '-'.repeat(9)).join('-+-')}-+-------`,
  ];

  for (const category of categories) {
    const cells = adapters.map((a) => {
      const r = results.find((x) => x.adapter === a && x.category === category);
      return (r === undefined ? '—' : r.passed ? 'PASS' : 'FAIL').padEnd(9);
    });
    const verdicts = adapters.map(
      (a) => results.find((x) => x.adapter === a && x.category === category)?.passed,
    );
    const parity = new Set(verdicts).size === 1 ? 'same' : 'DIVERGED';
    lines.push(`${category.padEnd(width)} | ${cells.join(' | ')} | ${parity}`);
  }

  return lines.join('\n');
}
