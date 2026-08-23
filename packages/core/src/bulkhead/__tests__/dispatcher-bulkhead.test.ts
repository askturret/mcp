// SPDX-License-Identifier: Apache-2.0
/**
 * Stage 6 wiring — bulkheads through the REAL dispatcher (§43).
 *
 * `bulkhead.test.ts` proves the semaphore. This proves the dispatcher actually
 * uses it: that overflow reaches a caller as `QUEUE_FULL` rather than as
 * `INTERNAL_ERROR`, and that a permit is released on every exit path.
 *
 * Both are things the unit tests cannot see. A registry that works perfectly
 * while stage 6 still returns its old no-op would pass every test in the other
 * file.
 */

import { describe, it, expect } from '@jest/globals';

import { AtomicRegistryReference } from '../../registry-reference.js';
import { createDispatcher } from '../../dispatcher/index.js';
import { createSnapshot } from '../../compiler/passes/freeze-and-hash.js';
import type { OperationDefinition, OperationResult } from '../../types.js';
import type { OperationExecutor } from '../../executor/index.js';

function operation(id: string, readOnly = true): OperationDefinition {
  return {
    id,
    name: id,
    description: id,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'test' },
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    operationId: 'op',
    input: {},
    deadline: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    registryHash: 'unused',
    ...overrides,
  } as Parameters<ReturnType<typeof createDispatcher>['dispatch']>[0];
}

/** A dispatcher whose executor blocks until released. */
function harness(bulkheads: Parameters<typeof createDispatcher>[3] extends undefined ? never : any) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;

  const executor: OperationExecutor = {
    execute: async (): Promise<OperationResult> => {
      entered += 1;
      await gate;
      return { ok: true, value: {} };
    },
  } as OperationExecutor;

  const ref = new AtomicRegistryReference(createSnapshot([operation('op')], 1));
  const dispatcher = createDispatcher(
    ref,
    { audit: async () => undefined },
    new Map<string, OperationExecutor>([['test', executor]]),
    bulkheads,
  );

  return { dispatcher, release, entered: () => entered };
}

describe('dispatcher stage 6', () => {
  it('returns QUEUE_FULL — not INTERNAL_ERROR — when the bulkhead overflows', async () => {
    // The distinction that matters. Shedding load is the bulkhead WORKING; if
    // it surfaced as INTERNAL_ERROR the operator would go hunting for a server
    // bug during a perfectly healthy overload.
    const { dispatcher, release } = harness({
      bulkheads: { default: { concurrency: 1, queueSize: 0 }, reads: { concurrency: 1, queueSize: 0 } },
    });

    const inFlight = dispatcher.dispatch(command());
    // Let the first call reach the executor and occupy the only slot.
    await new Promise((r) => setTimeout(r, 20));

    const shed = await dispatcher.dispatch(command());

    expect(shed.isError).toBe(true);
    expect(shed.error?.code).toBe('QUEUE_FULL');
    expect(shed.error?.code).not.toBe('INTERNAL_ERROR');

    release();
    await inFlight;
  });

  it('releases the permit after a call completes, so the next one gets in', async () => {
    const { dispatcher, release } = harness({
      bulkheads: { default: { concurrency: 1, queueSize: 0 }, reads: { concurrency: 1, queueSize: 0 } },
    });

    const first = dispatcher.dispatch(command());
    await new Promise((r) => setTimeout(r, 20));
    release();
    await first;

    // If the permit leaked, this would be shed even though nothing is running.
    const second = await dispatcher.dispatch(command());
    expect(second.isError).toBe(false);
  });

  it('releases the permit even when the executor throws', async () => {
    // The `finally` path. A slot leaked on an exception permanently lowers the
    // bulkhead's effective concurrency, and the symptom — unrelated calls
    // queueing on a group that looks idle — points nowhere near the cause.
    const throwing: OperationExecutor = {
      execute: async () => {
        throw new Error('executor exploded');
      },
    } as OperationExecutor;

    const ref = new AtomicRegistryReference(createSnapshot([operation('op')], 1));
    const dispatcher = createDispatcher(
      ref,
      { audit: async () => undefined },
      new Map<string, OperationExecutor>([['test', throwing]]),
      { bulkheads: { default: { concurrency: 1, queueSize: 0 }, reads: { concurrency: 1, queueSize: 0 } } },
    );

    await dispatcher.dispatch(command());
    await dispatcher.dispatch(command());

    // Third call still gets a slot: nothing leaked across two failures.
    const third = await dispatcher.dispatch(command());
    expect(third.error?.code).not.toBe('QUEUE_FULL');
  });

  it('isolates groups: a jammed reads bulkhead does not block a write', async () => {
    // The §8.2 invariant, end to end through the dispatcher rather than
    // against the registry directly.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const executor: OperationExecutor = {
      execute: async (op: unknown): Promise<OperationResult> => {
        if ((op as OperationDefinition).id === 'slowRead') await gate;
        return { ok: true, value: {} };
      },
    } as OperationExecutor;

    const ref = new AtomicRegistryReference(
      createSnapshot([operation('slowRead', true), operation('doWrite', false)], 1),
    );
    const dispatcher = createDispatcher(
      ref,
      { audit: async () => undefined },
      new Map<string, OperationExecutor>([['test', executor]]),
      {
        bulkheads: {
          default: { concurrency: 1, queueSize: 0 },
          reads: { concurrency: 1, queueSize: 0 },
          writes: { concurrency: 2, queueSize: 2 },
        },
      },
    );

    const jammed = dispatcher.dispatch(command({ operationId: 'slowRead' }));
    await new Promise((r) => setTimeout(r, 20));

    // reads is saturated...
    const shedRead = await dispatcher.dispatch(command({ operationId: 'slowRead' }));
    expect(shedRead.error?.code).toBe('QUEUE_FULL');

    // ...but writes is untouched.
    const write = await dispatcher.dispatch(command({ operationId: 'doWrite' }));
    expect(write.isError).toBe(false);

    release();
    await jammed;
  });
});
