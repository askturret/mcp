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

describe('§9.2 metric coverage', () => {
  it('emits all thirteen metrics across a round-trip and a reload', async () => {
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
