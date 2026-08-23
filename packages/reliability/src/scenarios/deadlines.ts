// SPDX-License-Identifier: Apache-2.0
/**
 * Slow-upstream layer — deadlines (§51 "deadlines fire correctly", §44).
 *
 * ## Why this is its own file
 *
 * The slow-upstream layer already covered the bulkhead half: queue to the
 * configured max, then shed `QUEUE_FULL`. It did NOT cover the deadline half,
 * which §51 lists in the same breath. That was a real gap and QA was right to
 * call it: nothing in the suite asserted a deadline at all.
 *
 * ## Where the deadline actually lives
 *
 * Not in the dispatcher. Stage 7 is explicitly a no-op that logs the deadline
 * and hands `deadline` + `signal` to the executor — so an executor that
 * ignores both would run forever and the dispatcher would wait for it.
 *
 * The enforcement is in the TRANSPORT, which races dispatch against a timer
 * and answers `TIMEOUT` when the timer wins. That distinction is the whole
 * point of testing it here rather than in a unit test: a scenario that asserted
 * `TIMEOUT` against a well-behaved executor would pass whether or not the
 * transport raced anything, because the executor would have honoured the
 * signal itself. Every executor below therefore IGNORES the deadline and the
 * abort signal completely — so the only thing that can produce `TIMEOUT` is
 * the transport, and the assertion has somewhere to fail.
 */

import type { OperationExecutor, OperationResult } from '@askturret/mcp-core';

import {
  createHarness,
  drive,
  operation,
  tally,
  type CallOutcome,
} from '../harness.js';

/** An executor that never settles and ignores cancellation entirely. */
function hangingExecutor(): { executor: OperationExecutor; entered: () => number } {
  let entered = 0;
  return {
    executor: {
      // No `signal` handling on purpose — see the file header. If this honoured
      // the abort signal, the transport's race would be untested.
      execute: () =>
        new Promise<OperationResult>(() => {
          entered += 1;
        }),
    },
    entered: () => entered,
  };
}

/** An executor that settles after `delayMs`, also ignoring cancellation. */
function slowExecutor(delayMs: number): OperationExecutor {
  return {
    execute: () =>
      new Promise<OperationResult>((resolve) => {
        setTimeout(() => resolve({ ok: true, value: {} }), delayMs);
      }),
  };
}

export interface DeadlineResult {
  readonly codes: Record<string, number>;
  /** Wall-clock ms for the slowest call observed. */
  readonly slowestMs: number;
  readonly deadlineMs: number;
}

/**
 * A hung upstream returns TIMEOUT, and returns it ON TIME.
 *
 * Two assertions, and the second is the one with teeth. That the code is
 * `TIMEOUT` only says the right label was attached somewhere; that it arrived
 * within a bound says the timer actually fired rather than the call completing
 * for some other reason. A deadline that fires late is the failure mode that
 * matters in production — the client has already given up.
 */
export async function deadlineFiresOnHungUpstream(
  deadlineMs = 120,
): Promise<DeadlineResult> {
  const hanging = hangingExecutor();
  const harness = createHarness({
    operations: [operation('hangs')],
    executors: new Map([['test', hanging.executor]]),
    deadlineMs,
  });

  const started = Date.now();
  const outcomes = await drive(6, 3, () => harness.call('hangs'));
  const elapsed = Date.now() - started;

  return { codes: tally(outcomes), slowestMs: elapsed, deadlineMs };
}

/**
 * A call that finishes INSIDE its deadline is not timed out.
 *
 * The control for the scenario above. Without it, a transport that returned
 * `TIMEOUT` unconditionally would pass — the same vacuity trap the
 * saturation-vs-breaker scenario needed a control to escape.
 */
export async function fastCallBeatsItsDeadline(
  deadlineMs = 400,
): Promise<DeadlineResult> {
  const harness = createHarness({
    operations: [operation('quick')],
    executors: new Map([['test', slowExecutor(5)]]),
    deadlineMs,
  });

  const started = Date.now();
  const outcomes = await drive(6, 3, () => harness.call('quick'));

  return { codes: tally(outcomes), slowestMs: Date.now() - started, deadlineMs };
}

export interface DeadlineUnderSaturationResult {
  readonly codes: Record<string, number>;
  /** Calls that were admitted to the executor. */
  readonly admitted: number;
}

/**
 * Deadlines and bulkheads compose: a QUEUED call still times out.
 *
 * This is the interaction, and the reason the layer belongs in this suite
 * rather than in a transport unit test. A call waiting for a bulkhead permit
 * is not yet executing, so if the deadline were started when the executor was
 * entered rather than when the request arrived, a queued call would wait out
 * the saturation and then get a fresh budget — the queue would silently become
 * unbounded in TIME even though it is bounded in DEPTH.
 *
 * The upstream here hangs forever, so nothing is ever released. Every call
 * that is not shed as `QUEUE_FULL` must therefore end as `TIMEOUT`: no call
 * may simply hang, which is what an un-raced queued call would do.
 */
export async function queuedCallsStillHitTheirDeadline(
  deadlineMs = 150,
): Promise<DeadlineUnderSaturationResult> {
  const hanging = hangingExecutor();
  const harness = createHarness({
    operations: [operation('saturated')],
    executors: new Map([['test', hanging.executor]]),
    // Narrow enough that most callers queue rather than execute.
    bulkheads: { default: { concurrency: 2, queueSize: 4 } },
    deadlineMs,
  });

  const outcomes: CallOutcome[] = await drive(12, 12, () => harness.call('saturated'));

  return { codes: tally(outcomes), admitted: hanging.entered() };
}
