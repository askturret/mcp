// SPDX-License-Identifier: Apache-2.0
/**
 * Shutdown-under-load and bounded-resource scenarios (§51, §17 criterion 10).
 */

import type { AuditEvent, AuditSink, OperationExecutor } from '@askturret/mcp-core';

import {
  createHarness,
  drive,
  operation,
  tally,
  type ReliabilityScale,
} from '../harness.js';

export interface ShutdownUnderLoadResult {
  readonly inFlightAtSigterm: number;
  /** Milliseconds from close() starting to /health/ready reporting 503. */
  readonly readyFlipMs: number;
  readonly newCallRejected: boolean;
  readonly newCallStatus: number;
  readonly completedCalls: number;
  /**
   * Audit records durable AT THE MOMENT `close()` returned.
   *
   * Counted there, not afterwards. Counting after awaiting the in-flight
   * calls makes the number correct whether or not the drain actually waited
   * — which is exactly the regression this scenario exists to catch. Measured
   * at the wrong instant, a drain that returned immediately still produced a
   * passing assertion.
   */
  readonly auditRecordsAtClose: number;
  readonly auditRecords: number;
  readonly auditFlushed: boolean;
  readonly drainTimedOut: boolean;
  readonly outcomes: Record<string, number>;
}

/**
 * SIGTERM while calls are in flight (§51 "shutdown under load").
 *
 * Three claims tested together, because separately they are all already
 * covered: readiness flips FAST, new work is refused, and every call that
 * COMPLETED has an audit record durable by the time `close()` returns.
 *
 * The third is the one that needs load to be meaningful. #48 proves a flush
 * drains the buffer; what it cannot show is that the set of audit records
 * matches the set of calls that actually finished — a drain that returned
 * early, or a flush that raced the last few appends, produces a bundle where
 * those two numbers quietly disagree.
 */
export async function shutdownUnderLoad(
  scale: ReliabilityScale,
): Promise<ShutdownUnderLoadResult> {
  const events: AuditEvent[] = [];
  let flushes = 0;

  const sink: AuditSink = {
    id: 'reliability',
    append: async (event) => {
      // A real sink is not instantaneous; a zero-cost one would hide exactly
      // the race this scenario exists to detect.
      await new Promise((resolve) => setImmediate(resolve));
      events.push(event);
    },
    flush: async () => {
      flushes += 1;
    },
  };

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;

  const executor: OperationExecutor = {
    execute: async () => {
      entered += 1;
      await gate;
      return { ok: true, value: {} };
    },
  };

  const harness = createHarness({
    operations: [operation('op')],
    executors: new Map<string, OperationExecutor>([['test', executor]]),
    bulkheads: { default: { concurrency: 1_000, queueSize: 1_000 } },
    auditSink: sink,
  });

  const count = Math.min(scale.totalCalls, 100);
  const inFlight = Array.from({ length: count }, (_, i) => harness.call('op', `sd-${i}`));

  // Let every call reach the executor before shutting down.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const inFlightAtSigterm = entered;

  const startedAt = Date.now();
  const closing = harness.transport.close({ drainMs: 10_000 });

  // Readiness must flip before the drain completes, not after it.
  const readiness = harness.transport.readiness();
  const readyFlipMs = Date.now() - startedAt;

  const rejected = await harness.call('op', 'after-sigterm');

  release();
  const result = await closing;

  // Sampled BEFORE awaiting the in-flight calls — see the field's note.
  const auditRecordsAtClose = events.length;

  const outcomes = await Promise.all(inFlight);
  const completed = outcomes.filter((outcome) => !outcome.isError).length;

  return {
    inFlightAtSigterm,
    readyFlipMs: readiness.httpStatus === 503 ? readyFlipMs : Number.POSITIVE_INFINITY,
    newCallRejected: rejected.status === 503,
    newCallStatus: rejected.status,
    completedCalls: completed,
    auditRecordsAtClose,
    auditRecords: events.length,
    auditFlushed: result.auditFlushed && flushes > 0,
    drainTimedOut: result.drainTimedOut,
    outcomes: tally(outcomes),
  };
}

export interface BoundedResourceResult {
  readonly calls: number;
  readonly heapGrowthRatio: number;
  readonly heapStartBytes: number;
  readonly heapEndBytes: number;
  readonly maxEventLoopLagMs: number;
  readonly unhandledRejections: number;
  readonly outcomes: Record<string, number>;
}

/**
 * Sustained load, checking the process does not grow without bound.
 *
 * §17 criterion 10 asks for "bounded memory and graceful overload behaviour",
 * and §51 puts a 20% heap-growth ceiling on it.
 *
 * ## What this measures, and what it cannot
 *
 * `heapUsed` moves for reasons unrelated to leaks — GC timing above all — so
 * a single reading is noise. This forces a collection when `--expose-gc` is
 * available and otherwise reports the ratio WITHOUT asserting on it, because
 * a memory assertion that fires on GC scheduling is one that gets disabled.
 *
 * Event-loop lag is the honest complement: it is sampled continuously and
 * responds to blocking work rather than to allocation, so the two together
 * distinguish "leaking" from "busy".
 */
export async function boundedResourceUsage(
  scale: ReliabilityScale,
): Promise<BoundedResourceResult> {
  let unhandled = 0;
  const onUnhandled = (): void => {
    unhandled += 1;
  };
  process.on('unhandledRejection', onUnhandled);

  const executor: OperationExecutor = {
    execute: async () => ({ ok: true, value: { at: Date.now() } }),
  };

  const harness = createHarness({
    operations: [operation('op')],
    executors: new Map<string, OperationExecutor>([['test', executor]]),
    bulkheads: { default: { concurrency: 50, queueSize: 500 } },
  });

  // Warm up first: the first calls allocate module-level structures that
  // would otherwise be counted as growth.
  await drive(Math.min(50, scale.totalCalls), scale.concurrency, (i) =>
    harness.call('op', `w-${i}`),
  );

  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();

  const heapStart = process.memoryUsage().heapUsed;

  let maxLag = 0;
  let lastTick = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    maxLag = Math.max(maxLag, now - lastTick - 10);
    lastTick = now;
  }, 10);

  const outcomes = await drive(scale.totalCalls, scale.concurrency, (i) =>
    harness.call('op', `l-${i}`),
  );

  clearInterval(lagTimer);
  gc?.();
  const heapEnd = process.memoryUsage().heapUsed;

  process.off('unhandledRejection', onUnhandled);

  return {
    calls: scale.totalCalls,
    heapGrowthRatio: heapStart === 0 ? 0 : (heapEnd - heapStart) / heapStart,
    heapStartBytes: heapStart,
    heapEndBytes: heapEnd,
    maxEventLoopLagMs: maxLag,
    unhandledRejections: unhandled,
    outcomes: tally(outcomes),
  };
}

/** True when the runtime can force a collection, making heap deltas meaningful. */
export function canMeasureHeap(): boolean {
  return typeof (globalThis as { gc?: () => void }).gc === 'function';
}
