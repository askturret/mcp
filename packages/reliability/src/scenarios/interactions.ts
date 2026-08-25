// SPDX-License-Identifier: Apache-2.0
/**
 * Scenarios that exercise resilience primitives AGAINST EACH OTHER (§12.1).
 *
 * The unit suites already prove each primitive alone: #43 proves a bulkhead
 * sheds at capacity, #46 proves a breaker opens and recovers, #47 proves a
 * drain waits. Re-asserting those here would grow the runtime without growing
 * the coverage.
 *
 * What no suite covers is the SEAMS — a reload landing mid-drain, a bulkhead
 * rejection reaching a breaker's failure classifier, a retry holding its
 * permit across attempts. Each scenario below is one of those, and each
 * returns structured evidence rather than asserting, so the same function can
 * be run by the test suite at PR scale and by the nightly runner at load.
 */

import {
  type BreakerStats,
  type OperationExecutor,
  type OperationErrorCode,
} from '@askturret/mcp-core';

import {
  createHarness,
  drive,
  gatedExecutor,
  operation,
  tally,
  type CallOutcome,
  type ReliabilityScale,
} from '../harness.js';

const fail = (code: OperationErrorCode): OperationExecutor => ({
  execute: async () => ({ ok: false, error: { code, message: 'injected' } }),
});

// ============================================================================
// 1. Bulkhead rejection must NOT be read as upstream unhealth
// ============================================================================

export interface SaturationResult {
  readonly outcomes: Record<string, number>;
  readonly breakerStates: Record<string, string>;
  readonly queueFullCount: number;
  /**
   * Control: breaker states after the SAME configuration is driven with a
   * genuinely failing upstream.
   *
   * Without this, "every breaker closed" is consistent with breakers simply
   * not being wired in this harness — the test would pass for the wrong
   * reason. This proves the breaker in this exact configuration can open, so
   * its staying closed under saturation is a result rather than an absence.
   */
  readonly controlBreakerStates: Record<string, string>;
}

/**
 * Saturate a bulkhead while the upstream is HEALTHY, and check the breaker.
 *
 * The interaction: an overloaded bulkhead sheds with `QUEUE_FULL`, and those
 * rejections never touched the upstream. If a breaker counted them it would
 * open on a dependency that is behaving perfectly — converting a local
 * capacity problem into an outage of a healthy service, and doing it exactly
 * when load is highest.
 *
 * #46 excludes `QUEUE_FULL` from its failure codes, but nothing exercised the
 * two together: the bulkhead is stage 6 and the breaker is stage 8, so the
 * rejection short-circuits before the breaker is ever consulted. This scenario
 * is what makes that ordering observable.
 */
export async function saturationDoesNotTripBreaker(
  scale: ReliabilityScale,
): Promise<SaturationResult> {
  const gate = gatedExecutor();

  const harness = createHarness({
    operations: [operation('slow')],
    executors: new Map<string, OperationExecutor>([['test', gate.executor]]),
    bulkheads: { default: { concurrency: 2, queueSize: 2 } },
    breakers: {
      default: {
        failureThreshold: 3,
        failureWindowMs: 60_000,
        cooldownMs: 60_000,
        halfOpenProbes: 1,
      },
    },
  });

  // More callers than concurrency + queue, so the excess is shed.
  const pending = Array.from({ length: scale.concurrency }, (_, i) =>
    harness.call('slow', `sat-${i}`),
  );

  // Let the shedding happen before anything is allowed to finish.
  await new Promise((resolve) => setTimeout(resolve, 50));
  gate.release();

  const outcomes = await Promise.all(pending);
  const counts = tally(outcomes);

  // The control: same bulkhead and breaker configuration, but an upstream
  // that genuinely fails. If this does NOT open, the assertion above is
  // vacuous and the suite is measuring nothing.
  const control = createHarness({
    operations: [operation('slow')],
    executors: new Map<string, OperationExecutor>([['test', fail('UPSTREAM_UNAVAILABLE')]]),
    bulkheads: { default: { concurrency: 2, queueSize: 2 } },
    breakers: {
      default: {
        failureThreshold: 3,
        failureWindowMs: 60_000,
        cooldownMs: 60_000,
        halfOpenProbes: 1,
      },
    },
  });
  for (let i = 0; i < 5; i += 1) await control.call('slow', `ctrl-${i}`);

  return {
    outcomes: counts,
    breakerStates: Object.fromEntries(
      harness.transport.breakerStats().map((stat: BreakerStats) => [stat.name, stat.state]),
    ),
    controlBreakerStates: Object.fromEntries(
      control.transport.breakerStats().map((stat: BreakerStats) => [stat.name, stat.state]),
    ),
    queueFullCount: counts['QUEUE_FULL'] ?? 0,
  };
}

// ============================================================================
// 2. A retry holds its bulkhead permit across attempts
// ============================================================================

export interface RetryOccupancyResult {
  /** Executor entries observed — retries included. */
  readonly executorEntries: number;
  /** Distinct calls that reached the executor at least once. */
  readonly callsAdmitted: number;
  readonly outcomes: Record<string, number>;
}

/**
 * Measure what retrying costs a bulkhead.
 *
 * The interaction, and it is not obvious from either issue alone: the permit
 * is acquired at stage 6 and the retry loop lives INSIDE stage 8, so a call
 * that retries three times occupies its slot for all three attempts plus the
 * backoff between them. Effective concurrency therefore falls as the retry
 * rate rises — under a failing upstream a bulkhead sized for N callers serves
 * fewer than N.
 *
 * That is the correct design (releasing between attempts would let a retry
 * lose its place to a new caller and starve), but it is a real capacity
 * consequence an operator should size for, and nothing measured it.
 */
export async function retryHoldsBulkheadPermit(
  scale: ReliabilityScale,
): Promise<RetryOccupancyResult> {
  let entries = 0;
  const admitted = new Set<string>();

  const executor: OperationExecutor = {
    execute: async (_op, _input, context) => {
      entries += 1;
      admitted.add(context.requestId);
      return { ok: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'injected' } };
    },
  };

  const harness = createHarness({
    operations: [operation('flaky', { retryable: true })],
    executors: new Map<string, OperationExecutor>([['test', executor]]),
    bulkheads: { default: { concurrency: 2, queueSize: 50 } },
    retry: { maxAttempts: 3, random: () => 0, sleep: async () => undefined },
  });

  const outcomes = await drive(
    Math.min(scale.totalCalls, 40),
    scale.concurrency,
    (i) => harness.call('flaky', `retry-${i}`),
  );

  return {
    executorEntries: entries,
    callsAdmitted: admitted.size,
    outcomes: tally(outcomes),
  };
}

// ============================================================================
// 3. Breaker opens on genuine upstream failure while a sibling group serves
// ============================================================================

export interface PartialFailureResult {
  readonly failingOutcomes: Record<string, number>;
  readonly healthyOutcomes: Record<string, number>;
  readonly breakerStates: Record<string, string>;
}

/**
 * One executor group failing, one healthy, both under concurrent load.
 *
 * §51's "partial failure" layer. The isolation claim is #46's reason for
 * existing, and this is the version of it that runs the two groups AT THE
 * SAME TIME through one dispatcher — the sequential unit test cannot show
 * that a breaker opening for one group leaves calls already queued for the
 * other untouched.
 */
const BREAKER = {
  failureThreshold: 5,
  failureWindowMs: 60_000,
  cooldownMs: 60_000,
  halfOpenProbes: 1,
} as const;

export async function partialFailureIsolatesGroups(
  scale: ReliabilityScale,
  /**
   * When false, the operations carry NO group annotation — which is what an
   * operator gets by default. See `partialFailureWithoutGrouping`.
   */
  groupsConfigured = true,
): Promise<PartialFailureResult> {
  const executors = new Map<string, OperationExecutor>([
    ['failing', fail('UPSTREAM_UNAVAILABLE')],
    ['healthy', { execute: async () => ({ ok: true, value: { ok: true } }) }],
  ]);

  const harness = createHarness({
    operations: [
      operation(
        'failingOp',
        {},
        'failing',
        groupsConfigured ? { breakerGroup: 'failingGroup' } : undefined,
      ),
      operation(
        'healthyOp',
        {},
        'healthy',
        groupsConfigured ? { breakerGroup: 'healthyGroup' } : undefined,
      ),
    ],
    executors,
    breakers: { default: BREAKER, failingGroup: BREAKER, healthyGroup: BREAKER },
  });

  const per = Math.max(10, Math.floor(Math.min(scale.totalCalls, 120) / 2));

  const [failing, healthy] = await Promise.all([
    drive(per, scale.concurrency, (i) => harness.call('failingOp', `f-${i}`)),
    drive(per, scale.concurrency, (i) => harness.call('healthyOp', `h-${i}`)),
  ]);

  return {
    failingOutcomes: tally(failing),
    healthyOutcomes: tally(healthy),
    breakerStates: Object.fromEntries(
      harness.transport.breakerStats().map((stat: BreakerStats) => [stat.name, stat.state]),
    ),
  };
}

/**
 * The SAME scenario with no group annotations — the default an operator gets.
 *
 * ## The finding this exists to record
 *
 * #46 scopes breakers per upstream group, and the first version of the
 * scenario above assumed that scoping was automatic. It is not. With no
 * `annotations.breakerGroup` and no `executor.config.baseUrl`, `assignBreaker`
 * falls through to `default` — so EVERY operation shares one breaker, and a
 * single failing dependency opens it for the whole server.
 *
 * That is exactly the blast radius §8.5 exists to contain, and it is the
 * default. It was invisible until this suite ran the two groups concurrently
 * and printed the breaker states: `{ default: 'open', failingGroup: 'closed' }`
 * — the configured group idle while the shared one absorbed everything.
 *
 * Not a defect in #46, whose assignment rules are documented and deliberate.
 * It is a configuration hazard worth a test that states it out loud, so the
 * behaviour is a decision rather than a surprise. Documented in
 * `docs/reliability-suite.md`.
 */
export async function partialFailureWithoutGrouping(
  scale: ReliabilityScale,
): Promise<PartialFailureResult> {
  return partialFailureIsolatesGroups(scale, false);
}

// ============================================================================
// 4. Reload landing mid-drain
// ============================================================================

export interface ReloadDuringDrainResult {
  /** Hash each call saw when it ENTERED the executor. */
  readonly observedHashes: readonly string[];
  /**
   * Hash each call saw AFTER the swap landed, while still in flight.
   *
   * The load-bearing observation. Recording only at entry proves the context
   * was built once — which a mid-flight re-read would not disturb, because
   * entry happens before the swap. Reading again on the far side of the gate
   * is what makes "the snapshot does not change under a call" falsifiable:
   * mutating the dispatcher to re-read the registry at execute time now
   * shows the POST-swap hash here.
   */
  readonly observedHashesAfterSwap: readonly string[];
  readonly hashAtEntry: string;
  readonly hashAfterSwap: string;
  readonly drainTimedOut: boolean;
  readonly auditFlushed: boolean;
  /**
   * Registry hash on every audit record written during the drain.
   *
   * The observation that CAN witness a regression here. The dispatch context
   * is an immutable object handed to the executor once, so no mid-flight swap
   * can reach an in-flight call — that guarantee is structural and cannot be
   * broken by a plausible edit. The AUDIT path is different: it composes its
   * record after the executor returns, so a version that re-read the registry
   * there would attribute the call to the post-swap snapshot. That is a real
   * bug class (an audit record naming the wrong contract), and this field is
   * what makes it falsifiable.
   */
  readonly auditHashes: readonly string[];
  readonly outcomes: Record<string, number>;
}

/**
 * Swap the registry WHILE a shutdown drain is waiting on in-flight calls.
 *
 * The seam between #37 and #47, and the one most likely to be wrong: the
 * dispatcher captures its snapshot once at entry, and the drain waits for
 * calls that captured it BEFORE the swap. If the swap were observable
 * mid-flight, a call would validate its input against one registry and
 * execute against another — a class of bug that produces a correct-looking
 * response computed from two different contracts.
 *
 * The executor records the hash it was actually handed, so this asserts on
 * what each call SAW rather than on what the reference reports afterwards.
 */
export async function reloadDuringDrain(): Promise<ReloadDuringDrainResult> {
  const observed: string[] = [];
  const observedAfter: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const executor: OperationExecutor = {
    execute: async (_op, _input, context) => {
      observed.push(context.registryHash);
      await gate; // the swap lands while every call is parked here
      observedAfter.push(context.registryHash);
      return { ok: true, value: {} };
    },
  };

  const auditHashes: string[] = [];

  const harness = createHarness({
    operations: [operation('op')],
    executors: new Map<string, OperationExecutor>([['test', executor]]),
    auditSink: {
      id: 'reload-drain',
      append: async (event) => {
        auditHashes.push(event.registryHash);
      },
      flush: async () => undefined,
    },
  });

  const hashAtEntry = harness.registry.current().hash;

  const inFlight = Array.from({ length: 12 }, (_, i) => harness.call('op', `d-${i}`));
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Shutdown begins; the drain is now waiting on the gated calls.
  const closing = harness.transport.close({ drainMs: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // …and a reload lands in the middle of it.
  const swapped = harness.swap([operation('op'), operation('added')], 2);

  release();
  const result = await closing;
  const outcomes = await Promise.all(inFlight);

  return {
    observedHashes: observed,
    observedHashesAfterSwap: observedAfter,
    hashAtEntry,
    hashAfterSwap: swapped.hash,
    drainTimedOut: result.drainTimedOut,
    auditFlushed: result.auditFlushed,
    auditHashes,
    outcomes: tally(outcomes),
  };
}

// ============================================================================
// 5. Overlapping swaps under load
// ============================================================================

export interface SnapshotIsolationResult {
  readonly distinctHashesObserved: number;
  readonly knownHashes: readonly string[];
  readonly unknownHashObserved: boolean;
  readonly outcomes: Record<string, number>;
}

/**
 * Two overlapping swaps while calls are in flight (§51 "reload under load").
 *
 * Every call must execute against a snapshot that genuinely existed — never a
 * blend, never a torn read. Asserting "no snapshot leaked across" means
 * checking that every hash an executor saw is one of the hashes actually
 * published, which is a stronger and more falsifiable claim than counting
 * successes.
 */
export async function overlappingSwapsUnderLoad(
  scale: ReliabilityScale,
): Promise<SnapshotIsolationResult> {
  const observed: string[] = [];

  const executor: OperationExecutor = {
    execute: async (_op, _input, context) => {
      observed.push(context.registryHash);
      // Yield, so a swap can land between entry and completion.
      await new Promise((resolve) => setImmediate(resolve));
      return { ok: true, value: {} };
    },
  };

  const harness = createHarness({
    operations: [operation('op')],
    executors: new Map<string, OperationExecutor>([['test', executor]]),
  });

  const known = [harness.registry.current().hash];
  const total = Math.min(scale.totalCalls, 300);

  const load = drive(total, scale.concurrency, (i) => harness.call('op', `s-${i}`));

  // Two swaps, overlapping the load rather than bracketing it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  known.push(harness.swap([operation('op'), operation('v2')], 2).hash);
  await new Promise((resolve) => setTimeout(resolve, 5));
  known.push(harness.swap([operation('op'), operation('v3')], 3).hash);

  const outcomes = await load;
  const seen = new Set(observed);

  return {
    distinctHashesObserved: seen.size,
    knownHashes: known,
    unknownHashObserved: [...seen].some((hash) => !known.includes(hash)),
    outcomes: tally(outcomes),
  };
}

// ============================================================================
// 6. Chaos — typed-error invariants under random fault injection
// ============================================================================

/** Every code the dispatcher is allowed to return. */
export const PERMITTED_CODES: readonly string[] = [
  'INVALID_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  // #201 — executor-returnable, so it belongs in the injection set.
  'NOT_FOUND',
  'CONFIRMATION_REQUIRED',
  'RATE_LIMITED',
  'QUEUE_FULL',
  'TIMEOUT',
  'CANCELLED',
  'UPSTREAM_UNAVAILABLE',
  'OUTCOME_UNKNOWN',
  'OUTPUT_TOO_LARGE',
  'INTERNAL_ERROR',
];

export interface ChaosResult {
  readonly rounds: number;
  readonly codesSeen: readonly string[];
  readonly unknownCodes: readonly string[];
  /** Messages that leaked a stack, a type name, or injected detail. */
  readonly leakedDetail: readonly string[];
  readonly unhandledRejections: number;
}

/**
 * Randomly break the executor and check the wire contract still holds.
 *
 * §51's chaos layer, scoped to what this runtime controls. The invariant is
 * not "nothing fails" — the whole point is that things fail. It is that every
 * failure arrives as a TYPED code from the closed set, and that
 * `INTERNAL_ERROR` never carries the detail of whatever went wrong: a thrown
 * secret, a stack, or a class name.
 *
 * The generator is seeded, so a failing nightly run reproduces exactly.
 */
export async function chaosPreservesTypedErrors(
  scale: ReliabilityScale,
  seed = 1,
): Promise<ChaosResult> {
  let unhandled = 0;
  const onUnhandled = (): void => {
    unhandled += 1;
  };
  process.on('unhandledRejection', onUnhandled);

  // Deterministic LCG — a failing round must be reproducible from the seed
  // alone, which Math.random cannot offer.
  let state = seed;
  const random = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };

  const SECRET = 'chaos_secret_do_not_leak';

  const executor: OperationExecutor = {
    execute: async () => {
      const roll = random();
      if (roll < 0.25) throw new Error(`boom ${SECRET}`);
      if (roll < 0.4) throw SECRET; // non-Error throw
      if (roll < 0.55) return { ok: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'x' } };
      if (roll < 0.65) return { ok: false, error: { code: 'OUTCOME_UNKNOWN', message: 'x' } };
      if (roll < 0.75) return { ok: true, value: null as never };
      return { ok: true, value: { ok: true } };
    },
  };

  const harness = createHarness({
    operations: [operation('chaos', { retryable: true })],
    executors: new Map<string, OperationExecutor>([['test', executor]]),
    bulkheads: { default: { concurrency: 4, queueSize: 8 } },
    breakers: {
      default: {
        failureThreshold: 10,
        failureWindowMs: 500,
        cooldownMs: 50,
        halfOpenProbes: 2,
      },
    },
    retry: { maxAttempts: 2, random: () => 0, sleep: async () => undefined },
  });

  const outcomes = await drive(scale.chaosRounds, scale.concurrency, (i) =>
    harness.call('chaos', `c-${i}`),
  );

  const codes = new Set<string>();
  const leaked: string[] = [];

  for (const outcome of outcomes) {
    if (!outcome.isError) continue;
    codes.add(outcome.code ?? 'UNKNOWN');

    const message = outcome.message ?? '';
    if (message.includes(SECRET) || message.includes('Error:') || message.includes('at ')) {
      leaked.push(message);
    }
  }

  process.off('unhandledRejection', onUnhandled);

  return {
    rounds: scale.chaosRounds,
    codesSeen: [...codes].sort(),
    unknownCodes: [...codes].filter((code) => !PERMITTED_CODES.includes(code)),
    leakedDetail: leaked,
    unhandledRejections: unhandled,
  };
}

export type { CallOutcome };
