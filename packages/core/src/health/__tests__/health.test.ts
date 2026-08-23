// SPDX-License-Identifier: Apache-2.0
/**
 * Health endpoint semantics (§8.7).
 *
 * The §8.7 table is a contract with a load balancer, so each row gets a test:
 * getting live/ready backwards either routes traffic to a broken instance or
 * restarts a healthy one during someone else's outage.
 */

import { describe, it, expect } from '@jest/globals';

import { evaluateLiveness, evaluateReadiness } from '../index.js';
import type { ReadinessInputs } from '../types.js';
import type { BreakerStats } from '../../breaker/types.js';
import type { ReadinessState } from '../../reload/types.js';

function inputs(overrides: Partial<ReadinessInputs> = {}): ReadinessInputs {
  return { shuttingDown: false, hasRegistrySnapshot: true, ...overrides };
}

function breaker(state: BreakerStats['state']): BreakerStats {
  return {
    name: `b-${state}`,
    state,
    failures: 0,
    failureThreshold: 5,
    halfOpenSuccesses: 0,
    halfOpenProbes: 1,
  };
}

function reloadState(ready: boolean, detail?: string): ReadinessState {
  return {
    ready,
    registryHash: 'abc123',
    registryVersion: 1,
    since: new Date(),
    ...(detail === undefined ? {} : { detail }),
  };
}

describe('/health/ready — the happy path', () => {
  it('is 200 with a valid snapshot and nothing degraded', () => {
    expect(evaluateReadiness(inputs())).toEqual({ ready: true, httpStatus: 200 });
  });
});

describe('/health/ready — 503 conditions (§8.7)', () => {
  it('is 503 while shutting down', () => {
    const report = evaluateReadiness(inputs({ shuttingDown: true }));

    expect(report.httpStatus).toBe(503);
    expect(report.reason).toBe('shutting-down');
  });

  it('reports shutting-down even when a dependency also looks unhealthy', () => {
    // Order matters for the operator, not just the status code. An instance
    // being replaced should not report "audit-sink-unreachable" and send
    // someone to investigate the wrong thing.
    const report = evaluateReadiness(
      inputs({
        shuttingDown: true,
        enforceDependencies: true,
        auditSinkReachable: false,
      }),
    );

    expect(report.reason).toBe('shutting-down');
  });

  it('is 503 with no registry snapshot', () => {
    const report = evaluateReadiness(inputs({ hasRegistrySnapshot: false }));

    expect(report.httpStatus).toBe(503);
    expect(report.reason).toBe('no-registry-snapshot');
  });

  it('is 503 during a degraded reload, with a diagnostic body', () => {
    // §8.7: "returns 503 with a diagnostic body describing the degradation".
    const report = evaluateReadiness(
      inputs({ reload: reloadState(false, 'compile failed on operation listPets') }),
    );

    expect(report.httpStatus).toBe(503);
    expect(report.reason).toBe('reload-degraded');
    expect(report.detail).toBe('compile failed on operation listPets');
  });

  it('is 200 when the reload controller reports ready', () => {
    expect(evaluateReadiness(inputs({ reload: reloadState(true) })).httpStatus).toBe(200);
  });
});

describe('/health/ready — dependency conditions are production-only (§8.7)', () => {
  it('ignores an unreachable audit sink unless dependencies are enforced', () => {
    // Pulling every instance out of rotation for a SHARED dependency blip
    // takes the service down instead of the dependency.
    expect(evaluateReadiness(inputs({ auditSinkReachable: false })).httpStatus).toBe(200);
  });

  it('is 503 for an unreachable audit sink when enforced', () => {
    const report = evaluateReadiness(
      inputs({ enforceDependencies: true, auditSinkReachable: false }),
    );

    expect(report.httpStatus).toBe(503);
    expect(report.reason).toBe('audit-sink-unreachable');
  });

  it('is 503 when every breaker is open and dependencies are enforced', () => {
    const report = evaluateReadiness(
      inputs({ enforceDependencies: true, breakers: [breaker('open'), breaker('open')] }),
    );

    expect(report.httpStatus).toBe(503);
    expect(report.reason).toBe('all-breakers-open');
  });

  it('is 200 when only SOME breakers are open', () => {
    // The point of scoping breakers per upstream (#46): one dead dependency
    // is not a dead instance.
    expect(
      evaluateReadiness(
        inputs({ enforceDependencies: true, breakers: [breaker('open'), breaker('closed')] }),
      ).httpStatus,
    ).toBe(200);
  });

  it('treats a half-open breaker as not-open', () => {
    expect(
      evaluateReadiness(inputs({ enforceDependencies: true, breakers: [breaker('half-open')] }))
        .httpStatus,
    ).toBe(200);
  });
});

describe('/health/ready — the empty-breakers trap', () => {
  // `[].every(...)` is TRUE in JavaScript, so the obvious one-liner reports
  // "all breakers are open" for an instance that has NO breakers configured.
  // Since #46 breakers are opt-in and therefore absent by DEFAULT, that would
  // take every default production instance permanently out of rotation on the
  // strength of a vacuous truth.
  it('is 200 with an empty breaker list under enforcement', () => {
    expect(
      evaluateReadiness(inputs({ enforceDependencies: true, breakers: [] })).httpStatus,
    ).toBe(200);
  });

  it('is 200 with no breaker list at all under enforcement', () => {
    expect(evaluateReadiness(inputs({ enforceDependencies: true })).httpStatus).toBe(200);
  });
});

describe('/health/ready — never fans out (§8.7)', () => {
  it('is synchronous, so no dependency can be probed from it', () => {
    // Not a style preference. §8.7 forbids readiness fanning out to
    // dependencies, and a synchronous signature makes that structural: there
    // is nothing awaitable in scope to probe WITH. If this ever returns a
    // promise, the guarantee is gone.
    const result = evaluateReadiness(inputs()) as unknown;

    expect(result).not.toHaveProperty('then');
  });
});

describe('/health/live (§8.7)', () => {
  it('is 200 on a responsive event loop', async () => {
    expect((await evaluateLiveness()).httpStatus).toBe(200);
  });

  it('responds well inside the budget under normal conditions', async () => {
    // §8.7's "consistent <10ms response" for the live endpoint.
    const startedAt = Date.now();
    await evaluateLiveness();

    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it('does not consult the registry, breakers, or any dependency', async () => {
    // Liveness answers "should this process be restarted?", readiness answers
    // "should it receive traffic?". A liveness check that failed on a
    // dependency outage would have the orchestrator kill every healthy
    // instance during someone else's incident.
    //
    // Evidenced by the signature: `evaluateLiveness` takes only a budget, so
    // it has no dependency to consult even if it wanted one.
    expect(evaluateLiveness.length).toBeLessThanOrEqual(1);
    expect((await evaluateLiveness(200)).httpStatus).toBe(200);
  });

  it('reports 503 when the event loop is genuinely blocked', async () => {
    // Drives the REAL condition rather than a proxy for it.
    //
    // A zero budget looked like the cheap stand-in and does NOT work:
    // `setImmediate` runs in the check phase and beat the 0ms timer, so the
    // probe returned 200. Measured, not assumed — that version failed.
    //
    // Blocking the loop synchronously after starting the probe is
    // deterministic for the opposite reason: when the block ends, the loop
    // resumes at the TIMERS phase with an overdue timer, and the check phase
    // (where `setImmediate` waits) does not run until after it. So the
    // timeout wins exactly when the loop was actually stuck, which is the
    // condition §8.7 says should return 503.
    const pending = evaluateLiveness(10);

    const blockUntil = Date.now() + 60;
    while (Date.now() < blockUntil) {
      // Deliberate busy-wait: this is the stuck event loop under test.
    }

    const report = await pending;

    expect(report.httpStatus).toBe(503);
    expect(report.detail).toContain('did not respond');
  });
});
