// SPDX-License-Identifier: Apache-2.0
/**
 * Breakers through the REAL dispatcher (§8.5, #46).
 *
 * `breaker.test.ts` proves the state machine. This proves stage 8 consults it:
 * that an open breaker stops calls reaching the executor at all, that two
 * upstreams fail independently, and that the retry loop from #45 short-circuits
 * instead of hammering an open breaker.
 *
 * Every assertion below is on the EXECUTOR'S OWN CALL COUNT, not on a state
 * the breaker reports about itself. A breaker whose state machine was perfect
 * while the dispatcher ignored it would pass all of `breaker.test.ts`.
 */

import { describe, it, expect } from '@jest/globals';

import { AtomicRegistryReference } from '../../registry-reference.js';
import { createDispatcher, type DispatcherOptions } from '../../dispatcher/index.js';
import { createSnapshot } from '../../compiler/passes/freeze-and-hash.js';
import { createRecordingMetricRecorder } from '../../telemetry/metrics.js';
import { noopTracer } from '../../telemetry/tracer.js';
import { METRIC } from '../../telemetry/types.js';
import { BREAKER_STATE_VALUE } from '../types.js';
import type { BreakersConfig } from '../types.js';
import type { RetryConfig } from '../../retry/types.js';
import type {
  OperationDefinition,
  OperationErrorCode,
  OperationResult,
} from '../../types.js';
import type { OperationExecutor } from '../../executor/index.js';

function operation(id: string, executorConfig?: Record<string, unknown>): OperationDefinition {
  return {
    id,
    name: id,
    description: id,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: {
      type: 'test',
      ...(executorConfig === undefined ? {} : { config: executorConfig }),
    },
  };
}

function command(operationId: string) {
  return {
    requestId: `req-${operationId}`,
    operationId,
    input: {},
    deadline: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    registryHash: 'unused',
  } as Parameters<ReturnType<typeof createDispatcher>['dispatch']>[0];
}

const BREAKERS: BreakersConfig = {
  default: {
    failureThreshold: 3,
    failureWindowMs: 60_000,
    cooldownMs: 30_000,
    halfOpenProbes: 1,
  },
};

/**
 * A dispatcher over a scripted executor.
 *
 * `respond` is keyed by operation id so a single harness can host two
 * independent upstreams — which is what the isolation test needs.
 */
function harness(params: {
  readonly operations: readonly OperationDefinition[];
  readonly breakers?: BreakersConfig;
  readonly retry?: RetryConfig;
  readonly respond: (operationId: string) => OperationResult;
}) {
  const calls: string[] = [];
  const metrics = createRecordingMetricRecorder();

  const executor: OperationExecutor = {
    execute: async (op) => {
      calls.push(op.id);
      return params.respond(op.id);
    },
  };

  const options: DispatcherOptions = {
    observability: { metrics, tracer: noopTracer },
    ...(params.breakers === undefined ? {} : { breakers: params.breakers }),
    ...(params.retry === undefined ? {} : { retry: params.retry }),
  };

  const dispatcher = createDispatcher(
    new AtomicRegistryReference(createSnapshot([...params.operations], 1)),
    { audit: async () => undefined },
    new Map<string, OperationExecutor>([['test', executor]]),
    options,
  );

  return {
    dispatcher,
    calls,
    metrics,
    /** Calls the executor actually received for one operation. */
    callsFor: (id: string) => calls.filter((c) => c === id).length,
    dispatch: (id: string) => dispatcher.dispatch(command(id)),
  };
}

const fail = (code: OperationErrorCode): OperationResult => ({
  ok: false,
  error: { code, message: 'boom' },
});

/** Same operation, but eligible for #45's retry matrix. */
function retryable(op: OperationDefinition): OperationDefinition {
  return { ...op, effects: { ...op.effects, retryable: true } };
}

describe('opening under load (§8.5)', () => {
  it('opens after the threshold and then stops calls reaching the executor', async () => {
    const h = harness({
      operations: [operation('op')],
      breakers: BREAKERS,
      respond: () => fail('UPSTREAM_UNAVAILABLE'),
    });

    for (let i = 0; i < 3; i += 1) await h.dispatch('op');
    expect(h.callsFor('op')).toBe(3);

    // Fourth call: the breaker is open, so the executor must not be entered.
    const result = await h.dispatch('op');

    expect(result.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(h.callsFor('op')).toBe(3);
  });

  it('does not open on non-transient errors — 100 FORBIDDEN keeps it closed', async () => {
    // §8.5's own test case. Opening here would neither fix the authorization
    // problem nor let anything through while open.
    const h = harness({
      operations: [operation('op')],
      breakers: BREAKERS,
      respond: () => fail('FORBIDDEN'),
    });

    for (let i = 0; i < 100; i += 1) await h.dispatch('op');

    expect(h.callsFor('op')).toBe(100);
    expect(h.dispatcher.breakerStats()[0]?.state).toBe('closed');
  });

  it.each(['INVALID_INPUT', 'UNAUTHENTICATED', 'RATE_LIMITED'] as const)(
    'does not count %s toward opening',
    async (code) => {
      const h = harness({
        operations: [operation('op')],
        breakers: BREAKERS,
        respond: () => fail(code),
      });

      for (let i = 0; i < 10; i += 1) await h.dispatch('op');

      expect(h.dispatcher.breakerStats()[0]?.state).toBe('closed');
    },
  );

  it('counts OUTCOME_UNKNOWN, which #45 never retries', async () => {
    // The case where "safe to retry?" and "is the upstream sick?" come apart.
    // OUTCOME_UNKNOWN must never be retried, but an upstream that accepts
    // requests then drops the connection is exactly what a breaker is for —
    // and it would never trip one built from the retry classification.
    const h = harness({
      operations: [operation('op')],
      breakers: BREAKERS,
      respond: () => fail('OUTCOME_UNKNOWN'),
    });

    for (let i = 0; i < 3; i += 1) await h.dispatch('op');
    await h.dispatch('op');

    expect(h.callsFor('op')).toBe(3);
    expect(h.dispatcher.breakerStats()[0]?.state).toBe('open');
  });

  it('does not count INTERNAL_ERROR, so our own bug cannot open a breaker', async () => {
    // INTERNAL_ERROR covers both a 500 from a reachable upstream and a fault
    // in this process. Neither means the dependency is unreachable, and
    // letting the latter open a breaker would take out a healthy dependency.
    const h = harness({
      operations: [operation('op')],
      breakers: BREAKERS,
      respond: () => fail('INTERNAL_ERROR'),
    });

    for (let i = 0; i < 10; i += 1) await h.dispatch('op');

    expect(h.dispatcher.breakerStats()[0]?.state).toBe('closed');
  });
});

describe('isolation — the point of scoping per upstream (§8.5 acceptance)', () => {
  it('opens ordersApi without affecting reportsApi', async () => {
    // The two-breaker fault-injection test §8.5 asks for. `orders` fails
    // every call; `reports` succeeds every call; they are assigned to
    // different breakers by baseUrl.
    const breakers: BreakersConfig = {
      default: { failureThreshold: 3, failureWindowMs: 60_000, cooldownMs: 30_000, halfOpenProbes: 1 },
      ordersApi: {
        failureThreshold: 3,
        failureWindowMs: 60_000,
        cooldownMs: 30_000,
        halfOpenProbes: 1,
        baseUrl: 'https://orders.example.com',
      },
      reportsApi: {
        failureThreshold: 3,
        failureWindowMs: 60_000,
        cooldownMs: 30_000,
        halfOpenProbes: 1,
        baseUrl: 'https://reports.example.com',
      },
    };

    const h = harness({
      operations: [
        operation('orders', { baseUrl: 'https://orders.example.com' }),
        operation('reports', { baseUrl: 'https://reports.example.com' }),
      ],
      breakers,
      respond: (id) => (id === 'orders' ? fail('UPSTREAM_UNAVAILABLE') : { ok: true, value: {} }),
    });

    for (let i = 0; i < 3; i += 1) await h.dispatch('orders');

    // orders is now open and shedding.
    const shed = await h.dispatch('orders');
    expect(shed.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(h.callsFor('orders')).toBe(3);

    // reports is untouched — the whole reason breakers are not global.
    const ok = await h.dispatch('reports');
    expect(ok.isError).toBe(false);
    expect(h.callsFor('reports')).toBe(1);

    const byName = Object.fromEntries(h.dispatcher.breakerStats().map((s) => [s.name, s.state]));
    expect(byName['ordersApi']).toBe('open');
    expect(byName['reportsApi']).toBe('closed');
  });
});

describe('interaction with #45 retries (§8.5)', () => {
  it('short-circuits the retry loop instead of burning attempts on an open breaker', async () => {
    const h = harness({
      operations: [retryable(operation('op'))],
      breakers: {
        default: {
          failureThreshold: 2,
          failureWindowMs: 60_000,
          cooldownMs: 30_000,
          halfOpenProbes: 1,
        },
      },
      retry: { maxAttempts: 5, random: () => 0, sleep: async () => undefined },
      respond: () => fail('UPSTREAM_UNAVAILABLE'),
    });

    // ONE dispatch with a budget of 5 attempts. The breaker opens after 2 real
    // failures, so attempt 3 is short-circuited — and the loop must stop
    // there rather than spending attempts 4 and 5 on a breaker already open.
    const result = await h.dispatch('op');

    expect(h.callsFor('op')).toBe(2);
    expect(result.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('uses its full retry budget when the breaker stays closed — the control', async () => {
    // Without this, "2 attempts" above is equally consistent with the retry
    // loop simply being broken. Same policy, same executor; only the breaker
    // threshold changes, so the difference isolates the breaker as the cause.
    const h = harness({
      operations: [retryable(operation('op'))],
      breakers: {
        default: {
          failureThreshold: 99,
          failureWindowMs: 60_000,
          cooldownMs: 30_000,
          halfOpenProbes: 1,
        },
      },
      retry: { maxAttempts: 5, random: () => 0, sleep: async () => undefined },
      respond: () => fail('UPSTREAM_UNAVAILABLE'),
    });

    await h.dispatch('op');

    expect(h.callsFor('op')).toBe(5);
  });

  it('does not let a probe-capped rejection re-open a recovering breaker', async () => {
    // The case that MATTERS for not recording short-circuited calls, and the
    // one a sequential test cannot reach.
    //
    // While OPEN, the state machine's own early-return already ignores a
    // recorded failure, so feeding rejections back in is merely redundant.
    // While HALF-OPEN it is not: a recorded failure re-opens immediately. So a
    // caller turned away purely because the probe cap was full would re-open a
    // breaker whose probe was still in flight and about to succeed — the
    // upstream recovers and the breaker never notices.
    //
    // Found by mutation testing: adding the record() call left every other
    // test in this file green.
    let releaseProbe!: () => void;
    const probeRunning = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });

    // Synchronise on the executor actually being ENTERED, not on a microtask
    // tick. Stage 8 sits behind several awaits (authenticate, authorize,
    // bulkhead acquire), so `await Promise.resolve()` returns long before the
    // probe is in flight and the breaker is still `open` at that point.
    let probeEntered!: () => void;
    const probeInFlight = new Promise<void>((resolve) => {
      probeEntered = resolve;
    });

    let call = 0;
    const calls: string[] = [];
    const metrics = createRecordingMetricRecorder();

    const executor: OperationExecutor = {
      execute: async (op) => {
        calls.push(op.id);
        call += 1;
        if (call === 1) return fail('UPSTREAM_UNAVAILABLE'); // opens the breaker
        probeEntered();
        await probeRunning; // the probe hangs until released
        return { ok: true, value: {} };
      },
    };

    const dispatcher = createDispatcher(
      new AtomicRegistryReference(createSnapshot([operation('op')], 1)),
      { audit: async () => undefined },
      new Map<string, OperationExecutor>([['test', executor]]),
      {
        observability: { metrics, tracer: noopTracer },
        // cooldown 0 so the breaker goes half-open on the very next call;
        // one probe, so a concurrent caller is turned away by the cap.
        breakers: {
          default: {
            failureThreshold: 1,
            failureWindowMs: 60_000,
            cooldownMs: 0,
            halfOpenProbes: 1,
          },
        },
      },
    );

    await dispatcher.dispatch(command('op'));
    expect(dispatcher.breakerStats()[0]?.state).toBe('open');

    // Probe starts and blocks inside the executor.
    const probe = dispatcher.dispatch(command('op'));
    await probeInFlight;
    expect(dispatcher.breakerStats()[0]?.state).toBe('half-open');

    // A second caller arrives while the probe is still in flight and is
    // turned away by the probe cap. This must NOT be read as upstream failure.
    const rejected = await dispatcher.dispatch(command('op'));
    expect(rejected.error?.code).toBe('UPSTREAM_UNAVAILABLE');

    releaseProbe();
    await probe;

    // The probe succeeded, so the breaker must have closed. If the rejection
    // had been recorded as a failure it would have re-opened here, and the
    // probe's success would have been discarded.
    expect(dispatcher.breakerStats()[0]?.state).toBe('closed');
    expect(calls).toHaveLength(2);
  });

  it('does not feed short-circuited calls back in as breaker failures', async () => {
    // A rejected call never touched the upstream, so it is no evidence about
    // the upstream's health. Counting it would let an open breaker refresh
    // its own failure window forever and never close.
    const h = harness({
      operations: [operation('op')],
      breakers: BREAKERS,
      respond: () => fail('UPSTREAM_UNAVAILABLE'),
    });

    for (let i = 0; i < 3; i += 1) await h.dispatch('op');
    const atOpen = h.dispatcher.breakerStats()[0]?.failures;

    for (let i = 0; i < 20; i += 1) await h.dispatch('op');

    expect(h.dispatcher.breakerStats()[0]?.failures).toBe(atOpen);
  });
});

describe('observability (§8.5)', () => {
  it('emits numeric state, and publishes every configured breaker at closed', async () => {
    const h = harness({
      operations: [operation('op')],
      breakers: BREAKERS,
      respond: () => fail('UPSTREAM_UNAVAILABLE'),
    });

    // Published at construction, so a breaker nobody has hit yet shows as
    // healthy rather than as a blank panel.
    const initial = h.metrics.forMetric(METRIC.circuitBreakerState);
    expect(initial.some((s) => s.labels['breaker'] === 'default' && s.value === 0)).toBe(true);

    for (let i = 0; i < 3; i += 1) await h.dispatch('op');

    const samples = h.metrics.forMetric(METRIC.circuitBreakerState);
    expect(samples[samples.length - 1]?.value).toBe(BREAKER_STATE_VALUE.open);
    expect(samples[samples.length - 1]?.labels['breaker']).toBe('default');
  });

  it('reports empty stats when breakers are disabled, not a row of green', async () => {
    // "Disabled" and "all closed" must be distinguishable. A UI that conflates
    // them shows reassuring green for a server with no breakers at all.
    const h = harness({
      operations: [operation('op')],
      respond: () => fail('UPSTREAM_UNAVAILABLE'),
    });

    for (let i = 0; i < 10; i += 1) await h.dispatch('op');

    expect(h.dispatcher.breakerStats()).toEqual([]);
    expect(h.callsFor('op')).toBe(10);
  });
});
