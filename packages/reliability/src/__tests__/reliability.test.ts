// SPDX-License-Identifier: Apache-2.0
/**
 * The reliability bank, run at PR scale (§12.1, §51).
 *
 * Each scenario returns EVIDENCE and this file makes the claims, so the same
 * function serves both the pull-request run and the nightly load run. The
 * shape asserted is identical at both sizes; only the counts differ.
 */

import { describe, it, expect } from '@jest/globals';

import {
  PERMITTED_CODES,
  boundedResourceUsage,
  buildGoldenDashboard,
  canMeasureHeap,
  renderGoldenDashboard,
  chaosPreservesTypedErrors,
  overlappingSwapsUnderLoad,
  partialFailureIsolatesGroups,
  partialFailureWithoutGrouping,
  reloadDuringDrain,
  retryHoldsBulkheadPermit,
  saturationDoesNotTripBreaker,
  scaleFromEnv,
  shutdownUnderLoad,
} from '../index.js';
import { METRIC_DEFINITIONS } from '@askturret/mcp-core';

const scale = scaleFromEnv();

describe('bulkhead x breaker — saturation is not upstream unhealth', () => {
  it('sheds with QUEUE_FULL and leaves every breaker closed', async () => {
    // The upstream is HEALTHY here — it just cannot be reached, because the
    // bulkhead is full. A breaker that counted those rejections would open on
    // a service behaving perfectly, turning a local capacity problem into an
    // outage of a healthy dependency at exactly the worst moment.
    const result = await saturationDoesNotTripBreaker(scale);

    expect(result.queueFullCount).toBeGreaterThan(0);
    expect(Object.values(result.breakerStates)).not.toContain('open');

    // CONTROL — the same configuration with a genuinely failing upstream DOES
    // open. Without this, "closed" is equally consistent with breakers not
    // being wired at all, and the assertion above measures nothing.
    expect(Object.values(result.controlBreakerStates)).toContain('open');
    // And the calls that DID get through succeeded, so shedding is the only
    // failure mode observed.
    expect(result.outcomes['success'] ?? 0).toBeGreaterThan(0);
    expect(result.outcomes['UPSTREAM_UNAVAILABLE'] ?? 0).toBe(0);
  });
});

describe('retry x bulkhead — a retry holds its permit', () => {
  it('spends multiple executor entries per admitted call', async () => {
    // Documents a real capacity consequence: the permit is taken at stage 6
    // and the retry loop is inside stage 8, so a retrying call occupies its
    // slot for every attempt. Effective concurrency falls as the retry rate
    // rises, and an operator sizing a bulkhead needs to know that.
    const result = await retryHoldsBulkheadPermit(scale);

    expect(result.callsAdmitted).toBeGreaterThan(0);
    expect(result.executorEntries).toBe(result.callsAdmitted * 3);
  });
});

describe('partial failure — one group fails, the other serves', () => {
  it('opens ONLY the failing group and leaves healthy calls untouched', async () => {
    const result = await partialFailureIsolatesGroups(scale);

    expect(result.failingOutcomes['success'] ?? 0).toBe(0);
    expect(result.breakerStates['failingGroup']).toBe('open');

    // EVERY healthy call succeeds — not merely "some". The first version of
    // this test asserted `> 0` and passed while the healthy group was in fact
    // being taken down: 25 succeeded before the shared breaker opened, then
    // 35 failed. A threshold assertion hid a total isolation failure.
    expect(result.healthyOutcomes['success'] ?? 0).toBe(
      Object.values(result.healthyOutcomes).reduce((sum, n) => sum + n, 0),
    );
    expect(result.breakerStates['healthyGroup']).toBe('closed');
  });

  it('WITHOUT group annotations, one failing dependency takes the rest down', async () => {
    // The default an operator gets, recorded deliberately. With no
    // `annotations.breakerGroup` and no `executor.config.baseUrl`, assignment
    // falls through to `default` — so every operation shares one breaker and
    // the blast radius §8.5 exists to contain is the whole server.
    //
    // Not a defect in #46, whose rules are documented and deliberate. It is a
    // configuration hazard, and this test is what makes it a decision rather
    // than a surprise.
    const result = await partialFailureWithoutGrouping(scale);

    expect(result.breakerStates['default']).toBe('open');
    // The healthy group is collateral damage: it fails despite its own
    // executor never returning an error.
    expect(result.healthyOutcomes['UPSTREAM_UNAVAILABLE'] ?? 0).toBeGreaterThan(0);
  });
});

/**
 * ## Coverage note for this block, stated rather than implied
 *
 * These two are REGRESSION WITNESSES, not mutation-verified guards. I tried
 * four separate edits to make one of them fail — re-reading the registry when
 * the dispatch context is built, when the executor is invoked, and when the
 * audit record is composed — and none flipped them.
 *
 * The reason is that the guarantee is STRUCTURAL. The snapshot is captured
 * once at stage 1 and threaded as immutable data; there is no live reference
 * an in-flight call could re-read, so no single-line edit reintroduces the
 * bug. That is the strongest possible answer to "is this safe?", and the
 * weakest possible answer to "does this test guard it?".
 *
 * They earn their place by witnessing a future REFACTOR that reintroduced a
 * live read — which is a realistic way for this property to be lost, and is
 * not something a unit test of either primitive alone would notice. But they
 * should not be counted among the mutation-verified assertions, and this note
 * exists so nobody counts them.
 */
describe('reload x drain — a swap lands mid-shutdown', () => {
  it('runs every in-flight call against the snapshot it entered with', async () => {
    // The seam most likely to be wrong. If a swap were observable mid-flight,
    // a call would validate against one registry and execute against another
    // — producing a correct-LOOKING response computed from two contracts.
    const result = await reloadDuringDrain();

    expect(result.hashAfterSwap).not.toBe(result.hashAtEntry);
    expect(result.observedHashes.length).toBeGreaterThan(0);
    expect(new Set(result.observedHashes)).toEqual(new Set([result.hashAtEntry]));

    // The observation that makes this falsifiable: read AFTER the swap landed,
    // while the call is still in flight. Checking only at entry proves the
    // context was built once, which a mid-flight re-read would not disturb —
    // entry happens before the swap.
    expect(new Set(result.observedHashesAfterSwap)).toEqual(new Set([result.hashAtEntry]));
  });

  it('still drains cleanly and flushes audit despite the swap', async () => {
    const result = await reloadDuringDrain();

    expect(result.drainTimedOut).toBe(false);
    expect(result.auditFlushed).toBe(true);
    expect(result.outcomes['success'] ?? 0).toBeGreaterThan(0);

    // Every audit record names the snapshot the call ENTERED with, not the
    // one published while it was draining. The audit path composes its record
    // after the executor returns, so this is where a mid-flight re-read would
    // actually show up.
    expect(result.auditHashes.length).toBeGreaterThan(0);
    expect(new Set(result.auditHashes)).toEqual(new Set([result.hashAtEntry]));
  });
});

describe('reload under load — overlapping swaps', () => {
  it('never lets a call observe a snapshot that was never published', async () => {
    // Stronger and more falsifiable than counting successes: every hash an
    // executor saw must be one that genuinely existed.
    const result = await overlappingSwapsUnderLoad(scale);

    expect(result.unknownHashObserved).toBe(false);
    expect(result.knownHashes).toHaveLength(3);
    expect(result.outcomes['success'] ?? 0).toBeGreaterThan(0);
  });
});

describe('shutdown under load', () => {
  it('flips readiness, refuses new work, and persists audit for what completed', async () => {
    const result = await shutdownUnderLoad(scale);

    expect(result.inFlightAtSigterm).toBeGreaterThan(0);
    // §51 asks for 100ms; asserted with headroom because CI machines are
    // shared, and a flake here would get the whole suite disabled.
    expect(result.readyFlipMs).toBeLessThan(1_000);
    expect(result.newCallRejected).toBe(true);
    expect(result.newCallStatus).toBe(503);
    expect(result.drainTimedOut).toBe(false);

    // The claim that needs load to mean anything: the set of audit records
    // matches the set of calls that actually finished. A drain returning
    // early, or a flush racing the last appends, makes these disagree.
    expect(result.auditFlushed).toBe(true);
    expect(result.auditRecords).toBe(result.completedCalls);

    // Sampled at the instant close() returned. This is the assertion a drain
    // that returned early actually fails — counting afterwards is correct
    // either way, which is how an early-return regression stays invisible.
    expect(result.auditRecordsAtClose).toBe(result.inFlightAtSigterm);
  });
});

describe('chaos — typed-error invariants hold under random failure', () => {
  it('returns only codes from the closed set, and leaks no internal detail', async () => {
    // The invariant is not "nothing fails" — the point is that things fail.
    // It is that every failure arrives as a typed code, and INTERNAL_ERROR
    // never carries the detail of what went wrong.
    const result = await chaosPreservesTypedErrors(scale);

    expect(result.unknownCodes).toEqual([]);
    expect(result.leakedDetail).toEqual([]);
    expect(result.unhandledRejections).toBe(0);
    // …and it genuinely exercised failure, rather than passing vacuously.
    expect(result.codesSeen.length).toBeGreaterThan(0);
  });

  it('is reproducible from its seed', async () => {
    // A failing nightly run has to be re-runnable. Math.random cannot offer
    // that, which is why the generator is a seeded LCG.
    const a = await chaosPreservesTypedErrors({ ...scale, chaosRounds: 60 }, 42);
    const b = await chaosPreservesTypedErrors({ ...scale, chaosRounds: 60 }, 42);

    expect(a.codesSeen).toEqual(b.codesSeen);
  });
});

describe('bounded resources under sustained load (§17 criterion 10)', () => {
  it('completes every call with no unhandled rejections and bounded lag', async () => {
    const result = await boundedResourceUsage(scale);

    expect(result.outcomes['success'] ?? 0).toBe(scale.totalCalls);
    expect(result.unhandledRejections).toBe(0);
    // §51 asks for <100ms event-loop lag; widened for shared CI machines, and
    // the nightly run is where the tight figure is enforced.
    expect(result.maxEventLoopLagMs).toBeLessThan(500);
  });

  it('reports heap growth, and only asserts on it when GC can be forced', async () => {
    // HONEST MEASUREMENT NOTE. `heapUsed` moves with GC scheduling, so a
    // 20%-growth assertion without a forced collection fails on timing rather
    // than on leaks — and a memory check that flakes is one that gets
    // disabled, which costs more than it catches.
    //
    // Under `--expose-gc` (how the nightly job runs it) the ratio is real and
    // asserted. Without it the number is still reported, and this test states
    // plainly that it is not being checked rather than pretending otherwise.
    const result = await boundedResourceUsage(scale);

    expect(Number.isFinite(result.heapGrowthRatio)).toBe(true);

    if (canMeasureHeap()) {
      expect(result.heapGrowthRatio).toBeLessThan(0.2);
    } else {
      expect(canMeasureHeap()).toBe(false);
    }
  });
});

describe('golden dashboard', () => {
  it('has exactly one panel per declared metric', async () => {
    // Generated from METRIC_DEFINITIONS rather than checked in as a blob, so
    // it cannot drift: a metric added without a panel is a failing test, not
    // a dashboard that silently shows less than the runtime emits.
    const dashboard = buildGoldenDashboard();

    expect(dashboard.panels).toHaveLength(METRIC_DEFINITIONS.length);
    expect(dashboard.panels.map((panel) => panel.title).sort()).toEqual(
      METRIC_DEFINITIONS.map((definition) => definition.name).sort(),
    );
  });

  it('uses an expression appropriate to each metric kind', async () => {
    // A counter graphed raw is a rising line that says nothing; a gauge
    // wrapped in rate() is meaningless. Getting this wrong produces a
    // technically complete dashboard that is useless in an incident.
    const dashboard = buildGoldenDashboard();
    const byTitle = new Map(dashboard.panels.map((panel) => [panel.title, panel]));

    for (const definition of METRIC_DEFINITIONS) {
      const expr = byTitle.get(definition.name)?.targets[0]?.expr ?? '';

      if (definition.kind === 'counter') expect(expr).toContain('rate(');
      if (definition.kind === 'histogram') expect(expr).toContain('histogram_quantile');
      if (definition.kind === 'gauge') expect(expr).not.toContain('rate(');
    }
  });

  it('matches the committed dashboards/reliability.json', async () => {
    // The committed file is what an operator imports. Asserting it equals the
    // generated form is what stops the two diverging: without this, a new
    // metric adds a panel to the generator and leaves the artifact behind,
    // and the dashboard silently shows less than the runtime emits — the
    // exact failure that made generating it worthwhile in the first place.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const here = dirname(fileURLToPath(import.meta.url));
    const committed = await readFile(
      join(here, '..', '..', 'dashboards', 'reliability.json'),
      'utf8',
    );

    expect(committed).toBe(renderGoldenDashboard());
  });

  it('covers every permitted error code in the chaos contract', () => {
    // Guards the closed set against drift: a new OperationErrorCode that the
    // chaos scenario does not know about would be reported as "unknown" and
    // fail the invariant test for the wrong reason.
    expect(PERMITTED_CODES).toContain('QUEUE_FULL');
    expect(PERMITTED_CODES).toContain('OUTCOME_UNKNOWN');
    expect(new Set(PERMITTED_CODES).size).toBe(PERMITTED_CODES.length);
  });
});
