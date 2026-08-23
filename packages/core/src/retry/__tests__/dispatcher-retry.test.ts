// SPDX-License-Identifier: Apache-2.0
/**
 * Stage 8 retry wiring — through the REAL dispatcher (§8.4, §5.8, #45).
 *
 * `policy.test.ts` proves the decision matrix. This proves the dispatcher acts
 * on it: that an eligible transient failure is genuinely re-executed, that an
 * ineligible one is genuinely not, and that the counted attempts are the
 * executor's own invocations rather than a number the loop reported about
 * itself.
 *
 * Every case below drives `dispatcher.dispatch()` and asserts on
 * `executor.calls` — a policy that decided perfectly while stage 8 ignored it
 * would pass the whole of `policy.test.ts` and fail here.
 */

import { describe, it, expect } from '@jest/globals';

import { AtomicRegistryReference } from '../../registry-reference.js';
import { createDispatcher, type DispatcherOptions } from '../../dispatcher/index.js';
import { createSnapshot } from '../../compiler/passes/freeze-and-hash.js';
import { createRecordingMetricRecorder } from '../../telemetry/metrics.js';
import { noopTracer } from '../../telemetry/tracer.js';
import { METRIC } from '../../telemetry/types.js';
import type {
  EffectMetadata,
  OperationDefinition,
  OperationError,
  OperationResult,
} from '../../types.js';
import type { OperationExecutor } from '../../executor/index.js';
import type { DispatchContext } from '../../dispatcher/types.js';
import type { RetryConfig } from '../types.js';

const OP_ID = 'op';

function operation(effects: Partial<EffectMetadata>): OperationDefinition {
  return {
    id: OP_ID,
    name: OP_ID,
    description: OP_ID,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: false,
      idempotent: false,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications: [],
      ...effects,
    },
    executor: { type: 'test' },
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    operationId: OP_ID,
    input: {},
    deadline: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    registryHash: 'unused',
    ...overrides,
  } as Parameters<ReturnType<typeof createDispatcher>['dispatch']>[0];
}

interface Harness {
  readonly dispatch: (overrides?: Record<string, unknown>) => Promise<{
    isError: boolean;
    error?: { code: string; message: string };
  }>;
  /** Every invocation the executor actually received. */
  readonly calls: DispatchContext[];
  readonly metrics: ReturnType<typeof createRecordingMetricRecorder>;
}

/**
 * Build a dispatcher around a scripted executor.
 *
 * `respond` receives the 1-based attempt number, so a test can say "fail
 * twice, then succeed" without any shared mutable counter of its own.
 */
function harness(params: {
  readonly effects: Partial<EffectMetadata>;
  readonly retry?: RetryConfig;
  readonly respond: (attempt: number, context: DispatchContext) => Promise<OperationResult>;
}): Harness {
  const calls: DispatchContext[] = [];
  const metrics = createRecordingMetricRecorder();

  const executor: OperationExecutor = {
    execute: async (_op, _input, context) => {
      calls.push(context);
      return params.respond(calls.length, context);
    },
  };

  const options: DispatcherOptions = {
    observability: { metrics, tracer: noopTracer },
    ...(params.retry === undefined ? {} : { retry: params.retry }),
  };

  const dispatcher = createDispatcher(
    new AtomicRegistryReference(createSnapshot([operation(params.effects)], 1)),
    { audit: async () => undefined },
    new Map<string, OperationExecutor>([['test', executor]]),
    options,
  );

  return {
    dispatch: async (overrides) => {
      const result = await dispatcher.dispatch(command(overrides));
      return {
        isError: result.isError,
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
    calls,
    metrics,
  };
}

/** Backoff neutralised: the decisions are under test, not setTimeout. */
const INSTANT: RetryConfig = { random: () => 0, sleep: async () => undefined };

const transient = (): OperationResult => ({
  ok: false,
  error: { code: 'UPSTREAM_UNAVAILABLE', message: 'boom' },
});

const READ_ONLY: Partial<EffectMetadata> = {
  readOnly: true,
  idempotent: true,
  retryable: true,
};

describe('§8.4 retry cases', () => {
  it('retries a read-only operation through a transient failure to success', async () => {
    const h = harness({
      effects: READ_ONLY,
      retry: { ...INSTANT, maxAttempts: 3 },
      respond: async (attempt) =>
        attempt < 3 ? transient() : { ok: true, value: { pets: [] } },
    });

    const result = await h.dispatch();

    expect(result.isError).toBe(false);
    // Three real executor invocations, not a loop counter.
    expect(h.calls).toHaveLength(3);
  });

  it('does not retry OUTCOME_UNKNOWN, however permissive the effects', async () => {
    // §5.8's safety invariant. The effects here are the MOST permissive the
    // matrix allows, so the refusal can only be coming from the error code.
    const h = harness({
      effects: { readOnly: true, idempotent: true, retryable: true, idempotencyKeyRequired: true },
      retry: { ...INSTANT, maxAttempts: 5 },
      respond: async () => ({
        ok: false,
        error: { code: 'OUTCOME_UNKNOWN', message: 'lost response' },
      }),
    });

    const result = await h.dispatch({ idempotencyKey: 'key-1' });

    expect(result.error?.code).toBe('OUTCOME_UNKNOWN');
    expect(h.calls).toHaveLength(1);
  });

  it('does not retry a non-idempotent write that came back OUTCOME_UNKNOWN', async () => {
    // The §45 case, and the one #44 produces: a POST whose response was lost
    // after send. Retrying would double-apply it.
    const h = harness({
      effects: { readOnly: false, idempotent: false, retryable: true },
      retry: { ...INSTANT, maxAttempts: 5 },
      respond: async () => ({
        ok: false,
        error: { code: 'OUTCOME_UNKNOWN', message: 'lost response' },
      }),
    });

    const result = await h.dispatch();

    expect(result.error?.code).toBe('OUTCOME_UNKNOWN');
    expect(h.calls).toHaveLength(1);
  });

  it('does not retry when retryable is false — one attempt, original error', async () => {
    const h = harness({
      effects: { readOnly: true, idempotent: true, retryable: false },
      retry: { ...INSTANT, maxAttempts: 5 },
      respond: async () => transient(),
    });

    const result = await h.dispatch();

    expect(result.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(h.calls).toHaveLength(1);
  });

  it('does not retry a non-idempotent write on an ordinary transient failure', async () => {
    const h = harness({
      effects: { readOnly: false, idempotent: false, retryable: true },
      retry: { ...INSTANT, maxAttempts: 5 },
      respond: async () => transient(),
    });

    await h.dispatch();

    expect(h.calls).toHaveLength(1);
  });

  it('stops at the attempt budget', async () => {
    const h = harness({
      effects: READ_ONLY,
      retry: { ...INSTANT, maxAttempts: 3 },
      respond: async () => transient(),
    });

    const result = await h.dispatch();

    expect(h.calls).toHaveLength(3);
    expect(result.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('does not retry at all when no retry policy is configured', async () => {
    // The pre-#45 behaviour, pinned: attaching no policy must not silently
    // start replaying calls against someone's upstream.
    const h = harness({ effects: READ_ONLY, respond: async () => transient() });

    await h.dispatch();

    expect(h.calls).toHaveLength(1);
  });
});

describe('deadline caps the total retry budget (§8.4)', () => {
  /**
   * A realistic executor: it takes time, and it reports TIMEOUT once the
   * deadline has actually passed — which is what viaHttp and viaHandler do.
   *
   * The terminal error therefore EMERGES from the clock rather than being
   * scripted, which is the only way this test can claim the deadline is what
   * ended the retrying.
   */
  const slowFailing = (durationMs: number) =>
    async (_attempt: number, context: DispatchContext): Promise<OperationResult> => {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      const error: OperationError =
        Date.now() >= context.deadline.getTime()
          ? { code: 'TIMEOUT', message: 'Deadline exceeded' }
          : { code: 'UPSTREAM_UNAVAILABLE', message: 'boom' };
      return { ok: false, error };
    };

  // Scaled-down version of §45's "30s deadline + 20s failing op". The
  // arithmetic, with random() === 1 pinning backoff to the top of its window:
  //   attempt 1  t=0   → 300ms, fails UPSTREAM (deadline 750 not yet passed)
  //              remaining 450ms > 250ms backoff, so it retries; sleeps to 550
  //   attempt 2  t=550 → 850ms, past the 750ms deadline, so TIMEOUT
  //              remaining is negative, so no third attempt
  const DEADLINE_MS = 750;
  const OP_MS = 300;
  const BUDGET_RETRY: RetryConfig = {
    maxAttempts: 10,
    baseDelayMs: 250,
    random: () => 1,
  };

  it('stops mid-budget when the next backoff would outlast the deadline', async () => {
    const h = harness({
      effects: READ_ONLY,
      retry: BUDGET_RETRY,
      respond: slowFailing(OP_MS),
    });

    const result = await h.dispatch({ deadline: new Date(Date.now() + DEADLINE_MS) });

    // One retry, then stop — with maxAttempts at 10, so the ATTEMPT cap
    // cannot be what stopped it.
    expect(h.calls).toHaveLength(2);
    expect(result.error?.code).toBe('TIMEOUT');
  });

  it('would have used the whole attempt budget given time — so the deadline is the cause', async () => {
    // The control for the case above. Same policy, same executor, only the
    // deadline changes. Without this, "2 attempts" is consistent with the
    // retry loop simply being broken.
    const h = harness({
      effects: READ_ONLY,
      retry: { ...BUDGET_RETRY, baseDelayMs: 1, maxAttempts: 4 },
      respond: slowFailing(5),
    });

    await h.dispatch({ deadline: new Date(Date.now() + 60_000) });

    expect(h.calls).toHaveLength(4);
  });
});

describe('idempotency key (§8.4)', () => {
  it('rejects a required-but-missing key with INVALID_INPUT and NO attempt', async () => {
    const h = harness({
      effects: { readOnly: false, idempotent: true, retryable: true, idempotencyKeyRequired: true },
      retry: { ...INSTANT, maxAttempts: 3 },
      respond: async () => ({ ok: true, value: {} }),
    });

    const result = await h.dispatch();

    expect(result.error?.code).toBe('INVALID_INPUT');
    // "No attempt made" is the substantive half: for a key-required operation
    // the call must not reach the upstream at all.
    expect(h.calls).toHaveLength(0);
  });

  it('rejects a whitespace-only key, which would satisfy a bare presence check', async () => {
    const h = harness({
      effects: { readOnly: false, idempotent: true, retryable: true, idempotencyKeyRequired: true },
      respond: async () => ({ ok: true, value: {} }),
    });

    const result = await h.dispatch({ idempotencyKey: '   ' });

    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(h.calls).toHaveLength(0);
  });

  it('does not echo the requirement message back with any supplied value', async () => {
    const h = harness({
      effects: { idempotencyKeyRequired: true },
      respond: async () => ({ ok: true, value: {} }),
    });

    const result = await h.dispatch({ idempotencyKey: '  ' });

    expect(result.error?.message).toBe(`Operation '${OP_ID}' requires an idempotency key`);
  });

  it('propagates the key to the executor on the dispatch context', async () => {
    // Enforcing a key that then went nowhere would be theatre: the upstream is
    // what deduplicates, so the key has to reach it.
    const h = harness({
      effects: { readOnly: false, idempotent: true, retryable: true, idempotencyKeyRequired: true },
      respond: async () => ({ ok: true, value: {} }),
    });

    await h.dispatch({ idempotencyKey: 'key-42' });

    expect(h.calls[0]?.idempotencyKey).toBe('key-42');
  });

  it('keeps the same key across retries, so the upstream can recognise the replay', async () => {
    // A retry that changed the key would defeat upstream deduplication
    // entirely — every attempt would look like a fresh request.
    const h = harness({
      effects: { readOnly: false, idempotent: true, retryable: true, idempotencyKeyRequired: true },
      retry: { ...INSTANT, maxAttempts: 3 },
      respond: async (attempt) => (attempt < 3 ? transient() : { ok: true, value: {} }),
    });

    await h.dispatch({ idempotencyKey: 'key-42' });

    expect(h.calls.map((c) => c.idempotencyKey)).toEqual(['key-42', 'key-42', 'key-42']);
  });

  it('does not demand a key when the operation does not require one', async () => {
    const h = harness({ effects: READ_ONLY, respond: async () => ({ ok: true, value: {} }) });

    expect((await h.dispatch()).isError).toBe(false);
  });
});

describe('retry metrics (§9.2)', () => {
  it('counts retries but not the initial attempt', async () => {
    const h = harness({
      effects: READ_ONLY,
      retry: { ...INSTANT, maxAttempts: 3 },
      respond: async (attempt) => (attempt < 3 ? transient() : { ok: true, value: {} }),
    });

    await h.dispatch();

    const samples = h.metrics.forMetric(METRIC.retryAttemptsTotal);
    // Three executor calls, two of which were retries.
    expect(h.calls).toHaveLength(3);
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.labels['outcome'])).toEqual(['error', 'success']);
    expect(samples[0]?.labels['tool']).toBe(OP_ID);
  });

  it('counts exhaustion once, labelled with the error actually returned', async () => {
    const h = harness({
      effects: READ_ONLY,
      retry: { ...INSTANT, maxAttempts: 3 },
      respond: async () => transient(),
    });

    await h.dispatch();

    const samples = h.metrics.forMetric(METRIC.retryExhaustedTotal);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.labels['terminal_error']).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('does not count exhaustion for a call that was never eligible to retry', async () => {
    // The distinction the metric exists to make: "retried and still failed" is
    // a different operational story from "failed once, not retryable". If this
    // fired here it would just be a slower copy of mcp_tool_errors_total.
    const h = harness({
      effects: { readOnly: true, idempotent: true, retryable: false },
      retry: { ...INSTANT, maxAttempts: 3 },
      respond: async () => transient(),
    });

    await h.dispatch();

    expect(h.metrics.forMetric(METRIC.retryExhaustedTotal)).toHaveLength(0);
    expect(h.metrics.forMetric(METRIC.retryAttemptsTotal)).toHaveLength(0);
  });
});

describe('cancellation during backoff', () => {
  it('abandons the retry when the client hangs up mid-backoff', async () => {
    const controller = new AbortController();

    const h = harness({
      effects: READ_ONLY,
      retry: {
        maxAttempts: 5,
        random: () => 1,
        baseDelayMs: 50,
        // Abort DURING the backoff window, which is the gap the loop has to
        // notice. A client that disconnected must not be charged for another
        // upstream call on its behalf.
        sleep: async () => {
          controller.abort();
        },
      },
      respond: async () => transient(),
    });

    const result = await h.dispatch({ signal: controller.signal });

    expect(result.error?.code).toBe('CANCELLED');
    expect(h.calls).toHaveLength(1);
  });
});
