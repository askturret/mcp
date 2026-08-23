// SPDX-License-Identifier: Apache-2.0
/**
 * In-flight snapshot retention - the load-bearing invariant of #37.
 *
 * "A dispatch must never re-read the registry mid-flight." This drives the
 * REAL dispatcher rather than asserting against the reference directly,
 * because the invariant lives in the dispatcher's single `registry.current()`
 * capture (#13). A test that only exercised AtomicRegistryReference would pass
 * even if the dispatcher started re-reading the reference at stage 7 - which
 * is exactly the regression worth catching.
 */

import { describe, it, expect } from '@jest/globals';
import { AtomicRegistryReference } from '../../registry-reference.js';
import { createDispatcher } from '../../dispatcher/index.js';
import { createReloadController } from '../controller.js';
import type { OperationExecutor } from '../../executor/index.js';
import type { DispatchContext } from '../../dispatcher/types.js';
import type { OperationResult } from '../../types.js';
import { snapshot } from './fixtures.js';

const IN_FLIGHT_CALLS = 100;

describe('in-flight snapshot retention', () => {
  it('completes all 100 in-flight calls against v(n) after a mid-flight swap to v(n+1)', async () => {
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);

    // Every dispatch parks here until we release it, guaranteeing all 100 are
    // genuinely in flight across the swap rather than finishing before it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const executor: OperationExecutor = {
      async execute(): Promise<OperationResult> {
        await gate;
        return { ok: true, value: { done: true } };
      },
    };

    // The hash each call saw at ENTRY, recorded at audit time (stage 11) -
    // i.e. after the swap has already happened.
    const observedAtCompletion: string[] = [];

    const dispatcher = createDispatcher(
      ref,
      {
        audit: async (context: DispatchContext) => {
          observedAtCompletion.push(context.registryHash);
        },
      },
      new Map<string, OperationExecutor>([['test', executor]]),
    );

    const inFlight = Array.from({ length: IN_FLIGHT_CALLS }, (_, i) =>
      dispatcher.dispatch({
        requestId: `req-${i}`,
        operationId: 'a',
        input: {},
        deadline: new Date(Date.now() + 60_000),
        signal: new AbortController().signal,
        registryHash: ref.current().hash,
      }),
    );

    // Let every dispatch reach stage 1 and capture its snapshot.
    await new Promise((resolve) => setImmediate(resolve));

    const controller = createReloadController({
      reference: ref,
      compile: async () => v2,
    });
    const reloadResult = await controller.reload();
    expect(reloadResult.outcome).toBe('success');

    // New callers see v2 immediately...
    expect(ref.current().hash).toBe(v2.hash);

    // ...while the 100 already in flight finish on v1.
    release();
    const results = await Promise.all(inFlight);

    expect(results).toHaveLength(IN_FLIGHT_CALLS);
    expect(results.every((r) => r.isError === false)).toBe(true);

    expect(observedAtCompletion).toHaveLength(IN_FLIGHT_CALLS);
    expect(observedAtCompletion.every((hash) => hash === v1.hash)).toBe(true);
    expect(observedAtCompletion).not.toContain(v2.hash);
  });

  it('routes calls started AFTER the swap to v(n+1)', async () => {
    // The mirror of the above: retention must not mean staleness for new work.
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);

    const executor: OperationExecutor = {
      async execute(): Promise<OperationResult> {
        return { ok: true, value: { done: true } };
      },
    };

    const seen: string[] = [];
    const dispatcher = createDispatcher(
      ref,
      {
        audit: async (context: DispatchContext) => {
          seen.push(context.registryHash);
        },
      },
      new Map<string, OperationExecutor>([['test', executor]]),
    );

    const controller = createReloadController({
      reference: ref,
      compile: async () => v2,
    });
    await controller.reload();

    await dispatcher.dispatch({
      requestId: 'after-swap',
      operationId: 'b', // only exists in v2
      input: {},
      deadline: new Date(Date.now() + 60_000),
      signal: new AbortController().signal,
      registryHash: ref.current().hash,
    });

    expect(seen).toEqual([v2.hash]);
  });

  it('audits the snapshot it actually captured, not the hash the caller claimed', async () => {
    // OperationCommand.registryHash is REQUIRED and documented as "registry
    // snapshot hash this command executes against", but the dispatcher never
    // reads it - it uses its own stage-1 capture. That is the right precedence
    // (a caller's claim must not be able to relabel which snapshot served),
    // and this pins it: if the dispatcher ever started trusting the command
    // field, the in-flight audit trail would become caller-controlled.
    const v1 = snapshot(1, ['a']);
    const ref = new AtomicRegistryReference(v1);

    const executor: OperationExecutor = {
      async execute(): Promise<OperationResult> {
        return { ok: true, value: { done: true } };
      },
    };

    const seen: string[] = [];
    const dispatcher = createDispatcher(
      ref,
      {
        audit: async (context: DispatchContext) => {
          seen.push(context.registryHash);
        },
      },
      new Map<string, OperationExecutor>([['test', executor]]),
    );

    await dispatcher.dispatch({
      requestId: 'lying-caller',
      operationId: 'a',
      input: {},
      deadline: new Date(Date.now() + 60_000),
      signal: new AbortController().signal,
      registryHash: 'not-a-real-hash',
    });

    expect(seen).toEqual([v1.hash]);
  });

  it('keeps in-flight calls on v(n) when the reload is REJECTED', async () => {
    // A rejected reload must be a no-op for traffic, not a partial swap.
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const executor: OperationExecutor = {
      async execute(): Promise<OperationResult> {
        await gate;
        return { ok: true, value: { done: true } };
      },
    };

    const seen: string[] = [];
    const dispatcher = createDispatcher(
      ref,
      {
        audit: async (context: DispatchContext) => {
          seen.push(context.registryHash);
        },
      },
      new Map<string, OperationExecutor>([['test', executor]]),
    );

    const inFlight = dispatcher.dispatch({
      requestId: 'during-failed-reload',
      operationId: 'a',
      input: {},
      deadline: new Date(Date.now() + 60_000),
      signal: new AbortController().signal,
      registryHash: ref.current().hash,
    });

    await new Promise((resolve) => setImmediate(resolve));

    const controller = createReloadController({
      reference: ref,
      compile: async () => v2,
      validate: () => [{ code: 'bad', message: 'candidate rejected' }],
    });
    const result = await controller.reload();
    expect(result.outcome).toBe('invalid');

    release();
    await inFlight;

    expect(seen).toEqual([v1.hash]);
    expect(ref.current().hash).toBe(v1.hash);
  });
});
