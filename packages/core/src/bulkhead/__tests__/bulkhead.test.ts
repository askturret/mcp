// SPDX-License-Identifier: Apache-2.0
/**
 * Bulkheads with bounded queues (§8.2, ADR-013, §43).
 *
 * The three scenarios §43 names — saturation, cancellation, slow-neighbour
 * isolation — plus the latency budget, because "returns QUEUE_FULL" and
 * "returns QUEUE_FULL *immediately*" are different claims and only the second
 * one is useful under load.
 */

import { describe, it, expect } from '@jest/globals';

import { createRecordingMetricRecorder } from '../../telemetry/metrics.js';
import { METRIC } from '../../telemetry/types.js';
import type { OperationDefinition } from '../../types.js';
import { assignBulkhead, createBulkheadRegistry } from '../registry.js';
import { BulkheadRejection, DEFAULT_BULKHEADS, type BulkheadsConfig } from '../types.js';

/** A never-settling gate, so a held slot stays held for as long as the test wants. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function operation(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return {
    id: 'op',
    name: 'op',
    description: 'op',
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'handler' },
    ...overrides,
  } as OperationDefinition;
}

describe('assignBulkhead', () => {
  it('honours an explicit annotation above everything else', () => {
    const op = operation({
      annotations: { bulkhead: 'reports' },
      effects: {
        readOnly: false,
        idempotent: false,
        retryable: false,
        idempotencyKeyRequired: false,
        classifications: [],
      },
    } as Partial<OperationDefinition>);

    // A mutation would otherwise route to `writes`. The annotation wins.
    expect(assignBulkhead(op, DEFAULT_BULKHEADS)).toBe('reports');
  });

  it('routes reads to reads and mutations to writes', () => {
    expect(assignBulkhead(operation(), DEFAULT_BULKHEADS)).toBe('reads');

    const mutation = operation({
      effects: {
        readOnly: false,
        idempotent: false,
        retryable: false,
        idempotencyKeyRequired: false,
        classifications: [],
      },
    } as Partial<OperationDefinition>);
    expect(assignBulkhead(mutation, DEFAULT_BULKHEADS)).toBe('writes');
  });

  it('routes a data-export read to reports', () => {
    // §43 says "long-running -> reports". Nothing in EffectMetadata marks an
    // operation long-running, so `data-export` is the inference — flagged in
    // types.ts, pinned here so the choice is visible rather than incidental.
    const report = operation({
      effects: {
        readOnly: true,
        idempotent: true,
        retryable: true,
        idempotencyKeyRequired: false,
        classifications: ['data-export'],
      },
    } as Partial<OperationDefinition>);

    expect(assignBulkhead(report, DEFAULT_BULKHEADS)).toBe('reports');
  });

  it('NEVER throws on a partially-populated operation', () => {
    // `RegistrySnapshot` has no runtime validation, and hand-built snapshots
    // omitting `classifications` are real — the transport's own fixtures do it.
    // An earlier version threw here, which surfaced as INTERNAL_ERROR on every
    // call. Routing is not worth failing a request over.
    const noClassifications = { ...operation(), effects: { readOnly: true } };
    const noEffects = { ...operation(), effects: undefined };

    expect(() => assignBulkhead(noClassifications as OperationDefinition, DEFAULT_BULKHEADS)).not.toThrow();
    expect(assignBulkhead(noClassifications as OperationDefinition, DEFAULT_BULKHEADS)).toBe('reads');
    // Unknown read-only status routes to the more conservative group.
    expect(assignBulkhead(noEffects as unknown as OperationDefinition, DEFAULT_BULKHEADS)).toBe('writes');
  });

  it('falls back to default for an unconfigured group name', () => {
    const onlyDefault: BulkheadsConfig = { default: { concurrency: 1, queueSize: 1 } };
    const op = operation({ annotations: { bulkhead: 'nonexistent' } } as Partial<OperationDefinition>);

    expect(assignBulkhead(op, onlyDefault)).toBe('default');
  });
});

describe('bounded queue', () => {
  it('SATURATION: 10 run, 20 queue, the remaining 70 are shed', async () => {
    // §43's headline scenario, at its stated numbers.
    const metrics = createRecordingMetricRecorder();
    const registry = createBulkheadRegistry({
      config: { default: { concurrency: 10, queueSize: 20 } },
      metrics,
    });

    const held = await Promise.all(
      Array.from({ length: 10 }, () => registry.acquire('default')),
    );

    const queued = Array.from({ length: 20 }, () => registry.acquire('default'));
    // Nothing has settled: these are waiting, which is the point of a queue.
    const shed: unknown[] = [];
    for (let i = 0; i < 70; i += 1) {
      shed.push(await registry.acquire('default').catch((e: unknown) => e));
    }

    expect(shed).toHaveLength(70);
    for (const rejection of shed) {
      expect(rejection).toBeInstanceOf(BulkheadRejection);
      expect((rejection as BulkheadRejection).code).toBe('QUEUE_FULL');
    }

    const stats = registry.stats().find((s) => s.name === 'default');
    expect(stats?.inFlight).toBe(10);
    expect(stats?.queued).toBe(20);

    // Every shed call is counted, and only the shed ones.
    const rejected = metrics.forMetric(METRIC.bulkheadRejectedTotal);
    expect(rejected).toHaveLength(70);
    expect(rejected[0]?.labels).toEqual({ bulkhead: 'default' });

    // Drain PROGRESSIVELY. Awaiting all 20 queued promises and then releasing
    // deadlocks: 10 held slots free only 10 waiters, and the other 10 wait for
    // releases that cannot happen until the await returns. Each waiter must
    // release as soon as it is admitted, so the slot passes down the line.
    const drained = queued.map((q) => q.then((p) => p.release()));
    held.forEach((p) => p.release());
    await Promise.all(drained);
  });

  it('sheds within the latency budget even while saturated', async () => {
    // §43 Acceptance: "<10ms even under saturation". The claim is about the
    // REJECT path never yielding, so it is measured rather than asserted —
    // an implementation that queued first and rejected later would pass a
    // functional test and fail this one.
    const registry = createBulkheadRegistry({
      config: { default: { concurrency: 5, queueSize: 5 } },
    });

    const held = await Promise.all(Array.from({ length: 5 }, () => registry.acquire('default')));
    const queued = Array.from({ length: 5 }, () => registry.acquire('default'));

    const started = Date.now();
    for (let i = 0; i < 200; i += 1) {
      await registry.acquire('default').catch(() => undefined);
    }
    const elapsed = Date.now() - started;

    // 200 rejections, generously bounded. A per-call budget of 10ms would be
    // 2000ms; anything near that means the reject path is awaiting something.
    expect(elapsed).toBeLessThan(500);

    const drained = queued.map((q) => q.then((p) => p.release()));
    held.forEach((p) => p.release());
    await Promise.all(drained);
  });

  it('CANCELLATION: a cancelled queued call frees its place', async () => {
    const registry = createBulkheadRegistry({
      config: { default: { concurrency: 1, queueSize: 1 } },
    });

    const held = await registry.acquire('default');

    const controller = new AbortController();
    const cancelled = registry.acquire('default', controller.signal).catch((e: unknown) => e);

    // The queue is full, so a second waiter is shed.
    await expect(registry.acquire('default')).rejects.toThrow(/full/);

    controller.abort();
    const outcome = await cancelled;
    expect(outcome).toBeInstanceOf(BulkheadRejection);
    expect((outcome as BulkheadRejection).code).toBe('CANCELLED');

    // The place is free again, so a new caller can queue where the cancelled
    // one was. Without the release, live traffic would be rejected on behalf
    // of a caller that had already gone away.
    const nextInLine = registry.acquire('default');
    held.release();
    const permit = await nextInLine;
    expect(permit.bulkhead).toBe('default');
    permit.release();
  });

  it('does not count a cancellation as a rejection', async () => {
    // The metric must say "we are shedding load", not "clients disconnected".
    const metrics = createRecordingMetricRecorder();
    const registry = createBulkheadRegistry({
      config: { default: { concurrency: 1, queueSize: 5 } },
      metrics,
    });

    const held = await registry.acquire('default');
    const controller = new AbortController();
    const cancelled = registry.acquire('default', controller.signal).catch((e: unknown) => e);
    controller.abort();
    await cancelled;

    expect(metrics.forMetric(METRIC.bulkheadRejectedTotal)).toHaveLength(0);
    held.release();
  });

  it('refuses an already-cancelled caller without taking a slot', async () => {
    const registry = createBulkheadRegistry({
      config: { default: { concurrency: 1, queueSize: 1 } },
    });

    const controller = new AbortController();
    controller.abort();

    await expect(registry.acquire('default', controller.signal)).rejects.toThrow(/cancelled/);

    // The slot was never taken, so a live caller still gets it.
    const permit = await registry.acquire('default');
    expect(permit.bulkhead).toBe('default');
    permit.release();
  });

  it('ISOLATION: a saturated bulkhead does not block a different one', async () => {
    // The invariant the whole module exists for (§8.2). `reads` is jammed with
    // a hung caller holding its only slot and its only queue place; `writes`
    // must be entirely unaffected.
    const registry = createBulkheadRegistry({
      config: {
        default: { concurrency: 1, queueSize: 1 },
        reads: { concurrency: 1, queueSize: 1 },
        writes: { concurrency: 2, queueSize: 2 },
      },
    });

    const hung = gate();
    const readSlot = await registry.acquire('reads');
    const readQueued = registry.acquire('reads');
    await expect(registry.acquire('reads')).rejects.toThrow(/full/);

    // `writes` is untouched while `reads` is jammed.
    const w1 = await registry.acquire('writes');
    const w2 = await registry.acquire('writes');
    expect(w1.bulkhead).toBe('writes');
    expect(w2.bulkhead).toBe('writes');

    const readStats = registry.stats().find((s) => s.name === 'reads');
    const writeStats = registry.stats().find((s) => s.name === 'writes');
    expect(readStats?.queued).toBe(1);
    expect(writeStats?.queued).toBe(0);
    expect(writeStats?.inFlight).toBe(2);

    hung.open();
    w1.release();
    w2.release();
    readSlot.release();
    (await readQueued).release();
  });

  it('releases are idempotent', async () => {
    // A double release would hand out a slot that is still occupied, silently
    // raising effective concurrency above the configured bound — with no error
    // to notice.
    const registry = createBulkheadRegistry({
      config: { default: { concurrency: 1, queueSize: 0 } },
    });

    const permit = await registry.acquire('default');
    permit.release();
    permit.release();
    permit.release();

    const next = await registry.acquire('default');
    expect(registry.stats().find((s) => s.name === 'default')?.inFlight).toBe(1);
    next.release();
  });

  it('publishes queue depth per bulkhead, including idle ones at zero', async () => {
    const metrics = createRecordingMetricRecorder();
    const registry = createBulkheadRegistry({
      config: {
        default: { concurrency: 1, queueSize: 2 },
        writes: { concurrency: 1, queueSize: 1 },
      },
      metrics,
    });

    // Every configured group publishes at construction, so an untouched group
    // shows an idle panel rather than a blank one.
    const initial = metrics.forMetric(METRIC.toolQueueDepth);
    expect(new Set(initial.map((s) => s.labels['bulkhead']))).toEqual(
      new Set(['default', 'writes']),
    );

    const held = await registry.acquire('default');
    const queued = registry.acquire('default');

    const depths = metrics
      .forMetric(METRIC.toolQueueDepth)
      .filter((s) => s.labels['bulkhead'] === 'default');
    expect(depths[depths.length - 1]?.value).toBe(1);

    held.release();
    (await queued).release();

    const after = metrics
      .forMetric(METRIC.toolQueueDepth)
      .filter((s) => s.labels['bulkhead'] === 'default');
    expect(after[after.length - 1]?.value).toBe(0);
  });

  it('hands a released slot to the longest waiter, not to a new arrival', async () => {
    // Fairness. Re-racing for a freed slot lets a call that just arrived jump
    // one that has already waited, which turns a bounded queue into an
    // unbounded wait for the unlucky.
    const registry = createBulkheadRegistry({
      config: { default: { concurrency: 1, queueSize: 5 } },
    });

    const held = await registry.acquire('default');
    const order: string[] = [];

    const first = registry.acquire('default').then((p) => {
      order.push('first');
      return p;
    });
    const second = registry.acquire('default').then((p) => {
      order.push('second');
      return p;
    });

    held.release();
    (await first).release();
    (await second).release();

    expect(order).toEqual(['first', 'second']);
  });
});
