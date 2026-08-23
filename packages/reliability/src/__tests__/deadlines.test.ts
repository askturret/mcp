// SPDX-License-Identifier: Apache-2.0
/**
 * Slow-upstream layer — deadlines (§51, §44).
 *
 * QA round 1 found this layer half-built: the bulkhead half was covered, the
 * "deadlines fire correctly" half was asserted nowhere. These are the missing
 * assertions.
 */

import { describe, it, expect } from '@jest/globals';

import {
  deadlineFiresOnHungUpstream,
  fastCallBeatsItsDeadline,
  queuedCallsStillHitTheirDeadline,
} from '../scenarios/deadlines.js';

describe('deadlines fire correctly (§51 slow-upstream layer)', () => {
  it('answers TIMEOUT when the upstream never returns', async () => {
    const result = await deadlineFiresOnHungUpstream(120);

    // Every call, not most: an upstream that never settles has no other exit.
    expect(result.codes['TIMEOUT']).toBe(6);
    expect(result.codes['success']).toBeUndefined();
  });

  it('fires ON TIME, not merely eventually', async () => {
    const result = await deadlineFiresOnHungUpstream(120);

    // The assertion with teeth. `TIMEOUT` alone only proves a label was
    // attached somewhere; a bound proves the timer actually ran. A deadline
    // that fires late has already lost the client it was protecting.
    //
    // Two calls deep at concurrency 3 over 6 calls, so ~2 deadline windows,
    // plus generous slack for a shared CI runner.
    expect(result.slowestMs).toBeLessThan(120 * 2 + 2000);
  });

  it('does NOT time out a call that beats its deadline', async () => {
    const result = await fastCallBeatsItsDeadline(400);

    // The control. Without it a transport that returned TIMEOUT
    // unconditionally would satisfy every assertion above — the same vacuity
    // the saturation-vs-breaker scenario needed a control to escape.
    expect(result.codes['success']).toBe(6);
    expect(result.codes['TIMEOUT']).toBeUndefined();
  });

  it('times out calls that are still QUEUED behind a saturated bulkhead', async () => {
    const result = await queuedCallsStillHitTheirDeadline(150);

    const shed = result.codes['QUEUE_FULL'] ?? 0;
    const timedOut = result.codes['TIMEOUT'] ?? 0;

    // The interaction, and the reason this belongs in the reliability suite
    // rather than a transport unit test: a queued call is not yet executing.
    // If the budget started when the executor was entered instead of when the
    // request arrived, queued callers would wait out the saturation and then
    // get a fresh deadline — a queue bounded in depth but unbounded in TIME.
    //
    // The upstream never releases, so no call can succeed. Every one must be
    // accounted for as shed or timed out; a hang would show up as a missing
    // count here.
    expect(shed + timedOut).toBe(12);
    expect(timedOut).toBeGreaterThan(0);
    expect(result.codes['success']).toBeUndefined();

    // And the bulkhead still did its job — admission stayed bounded.
    expect(result.admitted).toBeLessThanOrEqual(2);
  });
});
