// SPDX-License-Identifier: Apache-2.0
/**
 * "All 13 metrics emitted" (§9.2, § Acceptance) — #39 QA.
 *
 * ## Why this exists alongside cardinality.test.ts
 *
 * `cardinality.test.ts` pins the DECLARED metric set: that
 * `METRIC_DEFINITIONS` has thirteen entries with clean labels. That check is
 * worth having, and it is not this one.
 *
 * The acceptance criterion is that all thirteen are EMITTED. Two of them —
 * `mcp_registry_reload_total` and `mcp_registry_operations` — were declared,
 * were instrumented by the OTel adapter, and were never written to by any code
 * path, because the reload controller reported through a port that nothing
 * connected to the recorder. Eleven were emitted while every declaration-level
 * assertion stayed green.
 *
 * So this test drives REAL subsystems and asserts on what actually came out.
 * The union of a dispatcher round-trip (success and failure) and a reload is
 * the smallest set of behaviour that should produce all thirteen.
 */

import { describe, it, expect } from '@jest/globals';

import { AtomicRegistryReference } from '../../registry-reference.js';
import { createDispatcher } from '../../dispatcher/index.js';
import { createSnapshot } from '../../compiler/passes/freeze-and-hash.js';
import { createReloadController } from '../../reload/controller.js';
import { createRecordingMetricRecorder } from '../metrics.js';
import { createRecordingTracer } from '../tracer.js';
import { METRIC, type MetricName } from '../types.js';
import type { OperationDefinition, OperationResult } from '../../types.js';
import type { OperationExecutor } from '../../executor/index.js';
import type { MetricRecorder } from '../types.js';

function operation(id: string): OperationDefinition {
  return {
    id,
    name: id,
    description: `Operation ${id}`,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'test' },
  };
}

function command(): Parameters<ReturnType<typeof createDispatcher>['dispatch']>[0] {
  return {
    requestId: 'req-001',
    operationId: 'listPets',
    input: {},
    deadline: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    registryHash: 'unused',
  } as Parameters<ReturnType<typeof createDispatcher>['dispatch']>[0];
}

/** One dispatcher round-trip against a shared recorder. */
async function roundTrip(metrics: MetricRecorder, execute: () => Promise<OperationResult>) {
  const ref = new AtomicRegistryReference(createSnapshot([operation('listPets')], 1));
  const executor: OperationExecutor = { execute };

  const dispatcher = createDispatcher(
    ref,
    { audit: async () => undefined },
    new Map<string, OperationExecutor>([['test', executor]]),
    { observability: { tracer: createRecordingTracer(), metrics } },
  );

  await dispatcher.dispatch(command());
}

/**
 * Saturate a one-slot bulkhead so a third caller is rejected (#43).
 *
 * Drives the REAL registry rather than calling `metrics.add` directly: the
 * point of this file is that a metric is emitted by the code path that owns
 * it, and a hand-written sample would satisfy the assertion while proving
 * nothing about the bulkhead.
 */
async function overflowOneBulkhead(metrics: MetricRecorder): Promise<void> {
  const { createBulkheadRegistry } = await import('../../bulkhead/index.js');

  const registry = createBulkheadRegistry({
    config: { default: { concurrency: 1, queueSize: 1 } },
    metrics,
  });

  const held = await registry.acquire('default'); // takes the only slot
  const queued = registry.acquire('default'); // fills the only queue place

  await expect(registry.acquire('default')).rejects.toThrow(/full/); // shed

  held.release();
  (await queued).release();
}

/**
 * Exhaust a retry budget against the REAL dispatcher (#45).
 *
 * The operation is read-only, idempotent and retryable, so the effects matrix
 * permits retrying; the executor always fails transiently, so the budget runs
 * out. That produces `mcp_retry_attempts_total` (on attempts 2 and 3) and
 * `mcp_retry_exhausted_total` (when attempt 3 finds no budget left).
 *
 * Backoff is neutralised — `random: () => 0` and a no-op `sleep` — so the test
 * measures the retry DECISIONS rather than spending real seconds proving that
 * setTimeout works.
 */
async function exhaustRetries(metrics: MetricRecorder): Promise<void> {
  const ref = new AtomicRegistryReference(createSnapshot([operation('listPets')], 1));
  const executor: OperationExecutor = {
    execute: async () => ({
      ok: false,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'boom' },
    }),
  };

  const dispatcher = createDispatcher(
    ref,
    { audit: async () => undefined },
    new Map<string, OperationExecutor>([['test', executor]]),
    {
      observability: { tracer: createRecordingTracer(), metrics },
      retry: { maxAttempts: 3, random: () => 0, sleep: async () => undefined },
    },
  );

  await dispatcher.dispatch(command());
}

/**
 * Drive the audit path for real (#48).
 *
 * Two sinks: one that accepts writes (producing an append and a buffer-size
 * sample through a real dispatch), and one whose delegate never completes,
 * behind a one-slot buffer in drop mode — the only way to genuinely overflow
 * and produce `mcp_audit_dropped_total`.
 *
 * The drop is provoked by real back-pressure rather than by calling the
 * counter directly: a hand-written sample would satisfy the assertion while
 * proving nothing about the buffer.
 */
async function driveAuditSinks(metrics: MetricRecorder): Promise<void> {
  const { bufferedSink } = await import('../../audit/index.js');

  const ok = bufferedSink(
    { id: 'coverage-ok', append: async () => undefined, flush: async () => undefined },
    { metrics },
  );

  const dispatcher = createDispatcher(
    new AtomicRegistryReference(createSnapshot([operation('listPets')], 1)),
    { audit: async () => undefined },
    new Map<string, OperationExecutor>([
      ['test', { execute: async () => ({ ok: true, value: {} }) } as OperationExecutor],
    ]),
    { observability: { tracer: createRecordingTracer(), metrics }, auditSink: ok },
  );

  await dispatcher.dispatch(command());
  await ok.flush();

  const stuck = bufferedSink(
    {
      id: 'coverage-drop',
      append: () => new Promise<void>(() => undefined),
      flush: async () => undefined,
    },
    { metrics, maxBufferSize: 1, overflow: 'drop' },
  );

  const event = {
    eventId: 'e1',
    timestamp: new Date(0).toISOString(),
    requestId: 'r1',
    operationId: 'listPets',
    registryHash: 'h',
    policyDecision: 'allow',
    outcome: 'success',
    durationMs: 1,
  };

  await stuck.append(event); // handed straight to the stuck delegate
  await stuck.append(event); // fills the single slot
  await stuck.append(event); // dropped

  void metrics;
}

describe('§9.2 metric coverage', () => {
  it('emits every declared metric across a round-trip, a reload and an overflow', async () => {
    const metrics = createRecordingMetricRecorder();

    // 1. A successful call: requests, tool calls, durations, policy, upstream,
    //    output bytes, in-flight — plus the two placeholder series emitted at
    //    dispatcher construction.
    await roundTrip(metrics, async () => ({ ok: true, value: { pets: ['fluffy'] } }));

    // 2. A failing call, which is the only thing that produces
    //    mcp_tool_errors_total.
    await roundTrip(metrics, async () => ({
      ok: false,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'boom' },
    }));

    // 3. A reload, which is the only thing that produces the two registry
    //    series — and the step that was missing entirely.
    const v1 = createSnapshot([operation('listPets')], 1);
    const v2 = createSnapshot([operation('listPets'), operation('createPet')], 2);
    const controller = createReloadController({
      reference: new AtomicRegistryReference(v1),
      compile: async () => v2,
      metricRecorder: metrics,
    });
    await controller.reload();

    // 4. A bulkhead overflow, which is the only thing that produces
    //    mcp_bulkhead_rejected_total (#43). Concurrency and queue are both 1
    //    and the executor never returns, so the third caller must be shed.
    await overflowOneBulkhead(metrics);

    // 5. A call that retries and runs out of budget, which is the only thing
    //    that produces the two retry series (#45).
    await exhaustRetries(metrics);

    // 6. The audit path, which is the only thing that produces the three
    //    audit series (#48).
    await driveAuditSinks(metrics);

    // 7. A redaction, which is the only thing that produces
    //    mcp_redaction_hits_total (#49). Driven through the real pipeline
    //    against a real secret rather than by touching the counter.
    const { createRedactionPipeline } = await import('../../redaction/index.js');
    createRedactionPipeline({ metrics }).redact(
      { token: 'sk_live_should_not_appear' },
      { surface: 'log', path: [] },
    );

    const emitted = new Set<MetricName>(metrics.samples().map((sample) => sample.metric));
    const missing = (Object.values(METRIC) as MetricName[]).filter((name) => !emitted.has(name));

    // Named rather than counted: a bare `toHaveLength(13)` failure tells you a
    // number, and this tells you which series an operator's dashboard is
    // missing.
    expect(missing).toEqual([]);
  });

  it('covers every declared metric, so the check cannot drift from the contract', async () => {
    // Guards the test above against the metric set growing. If a fourteenth
    // metric is declared and nothing emits it, the assertion above starts
    // failing rather than quietly continuing to check the original thirteen.
    const { METRIC_DEFINITIONS } = await import('../types.js');

    expect(new Set(METRIC_DEFINITIONS.map((d) => d.name))).toEqual(
      new Set(Object.values(METRIC)),
    );
  });
});
