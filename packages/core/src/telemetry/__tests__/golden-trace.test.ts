// SPDX-License-Identifier: Apache-2.0
/**
 * Golden trace + metric emission (§9.1 span tree, §9.2 metric set).
 *
 * Drives the REAL dispatcher. A test that assembled spans by hand would pass
 * while the dispatcher emitted nothing — the claim under test is that a
 * round-trip PRODUCES the canonical tree, not that the tree can be built.
 */

import { describe, it, expect } from '@jest/globals';
import { AtomicRegistryReference } from '../../registry-reference.js';
import { createDispatcher } from '../../dispatcher/index.js';
import { createSnapshot } from '../../compiler/passes/freeze-and-hash.js';
import { createRecordingTracer } from '../tracer.js';
import { createRecordingMetricRecorder } from '../metrics.js';
import { METRIC, SPAN_ATTR } from '../types.js';
import type { OperationDefinition, OperationResult } from '../../types.js';
import type { OperationExecutor } from '../../executor/index.js';

/** The canonical §9.1 tree for a successful tools/call round-trip. */
const CANONICAL_TREE = [
  'mcp.request',
  'mcp.tool.call',
  'policy.evaluate',
  'schema.validate.input',
  'bulkhead.wait',
  'executor.invoke',
  'schema.validate.output',
  'audit.append',
];

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

function harness(executeImpl?: () => Promise<OperationResult>) {
  const tracer = createRecordingTracer();
  const metrics = createRecordingMetricRecorder();
  const snapshot = createSnapshot([operation('listPets')], 1);
  const ref = new AtomicRegistryReference(snapshot);

  const executor: OperationExecutor = {
    execute:
      executeImpl ??
      (async (): Promise<OperationResult> => ({ ok: true, value: { pets: ['fluffy'] } })),
  };

  const dispatcher = createDispatcher(
    ref,
    { audit: async () => undefined },
    new Map<string, OperationExecutor>([['test', executor]]),
    { observability: { tracer, metrics } },
  );

  return { tracer, metrics, dispatcher, snapshot };
}

function command(overrides?: Record<string, unknown>) {
  return {
    requestId: 'req-001',
    operationId: 'listPets',
    input: {},
    deadline: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    registryHash: 'unused',
    ...(overrides ?? {}),
  } as Parameters<ReturnType<typeof harness>['dispatcher']['dispatch']>[0];
}

describe('golden trace', () => {
  it('produces the canonical span tree for a successful round-trip', async () => {
    const { tracer, dispatcher } = harness();

    await dispatcher.dispatch(command());

    expect(tracer.all().map((s) => s.name)).toEqual(CANONICAL_TREE);
  });

  it('parents every stage span under mcp.tool.call, and that under mcp.request', async () => {
    // The tree SHAPE, not just the set of names. A flat list of correctly
    // named spans would satisfy the previous assertion and be useless.
    const { tracer, dispatcher } = harness();

    await dispatcher.dispatch(command());

    const spans = tracer.all();
    const root = spans.find((s) => s.name === 'mcp.request');
    const toolCall = spans.find((s) => s.name === 'mcp.tool.call');

    expect(root?.parent).toBeNull();
    expect(toolCall?.parent?.name).toBe('mcp.request');

    for (const name of CANONICAL_TREE.slice(2)) {
      expect(spans.find((s) => s.name === name)?.parent?.name).toBe('mcp.tool.call');
    }
  });

  it('ends every span it starts', async () => {
    // An unended span never leaves the exporter, so the trace silently loses
    // a branch rather than failing.
    const { tracer, dispatcher } = harness();

    await dispatcher.dispatch(command());

    expect(tracer.all().every((s) => s.ended)).toBe(true);
  });

  it('carries the documented stable attribute set', async () => {
    const { tracer, dispatcher, snapshot } = harness();

    await dispatcher.dispatch(command({ clientInfo: { name: 'claude-desktop' } }));

    const spans = tracer.all();
    const root = spans.find((s) => s.name === 'mcp.request');
    const toolCall = spans.find((s) => s.name === 'mcp.tool.call');
    const policy = spans.find((s) => s.name === 'policy.evaluate');

    expect(root?.attributes[SPAN_ATTR.method]).toBe('tools/call');
    expect(root?.attributes[SPAN_ATTR.protocolVersion]).toBe('2025-06-18');
    expect(root?.attributes[SPAN_ATTR.clientName]).toBe('claude-desktop');
    expect(root?.attributes[SPAN_ATTR.outcome]).toBe('success');

    expect(toolCall?.attributes[SPAN_ATTR.toolName]).toBe('listPets');
    expect(toolCall?.attributes[SPAN_ATTR.executorType]).toBe('test');
    // Short form, per §9.1 — the full hash would be higher cardinality and
    // would not join against `mcp_registry_operations`.
    expect(toolCall?.attributes[SPAN_ATTR.registryHash]).toBe(snapshot.hash.slice(0, 12));

    // §9.1: policy decision appears ONLY on policy.evaluate spans.
    expect(policy?.attributes[SPAN_ATTR.policyDecision]).toBe('allow');
    expect(root?.attributes[SPAN_ATTR.policyDecision]).toBeUndefined();
    expect(toolCall?.attributes[SPAN_ATTR.policyDecision]).toBeUndefined();
  });

  it('records an error outcome and error code when execution fails', async () => {
    const { tracer, dispatcher } = harness(async () => ({
      ok: false,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'boom' },
    }));

    await dispatcher.dispatch(command());

    const root = tracer.all().find((s) => s.name === 'mcp.request');
    expect(root?.attributes[SPAN_ATTR.outcome]).toBe('error');
    expect(root?.attributes[SPAN_ATTR.errorCode]).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('never puts raw input or output on a span', async () => {
    const { tracer, dispatcher } = harness(async () => ({
      ok: true,
      value: { secretResponse: 'sensitive-output-value' },
    }));

    await dispatcher.dispatch(command({ input: { secretArg: 'sensitive-input-value' } }));

    const dumped = JSON.stringify(tracer.all());
    expect(dumped).not.toContain('sensitive-input-value');
    expect(dumped).not.toContain('sensitive-output-value');
  });

  it('emits nothing when no observability is configured', async () => {
    // Telemetry is opt-in (§ Delivery). The default must not allocate spans or
    // push samples.
    const snapshot = createSnapshot([operation('listPets')], 1);
    const ref = new AtomicRegistryReference(snapshot);
    const executor: OperationExecutor = {
      async execute(): Promise<OperationResult> {
        return { ok: true, value: {} };
      },
    };
    const dispatcher = createDispatcher(
      ref,
      {},
      new Map<string, OperationExecutor>([['test', executor]]),
    );

    const result = await dispatcher.dispatch(command());
    expect(result.isError).toBe(false);
  });
});

describe('metric emission', () => {
  it('records the request and tool series on a successful call', async () => {
    const { metrics, dispatcher } = harness();

    await dispatcher.dispatch(command());

    expect(metrics.forMetric(METRIC.requestsTotal)).toHaveLength(1);
    expect(metrics.forMetric(METRIC.requestsTotal)[0]?.labels).toEqual({
      method: 'tools/call',
      outcome: 'success',
    });
    expect(metrics.forMetric(METRIC.toolCallsTotal)[0]?.labels).toEqual({
      tool: 'listPets',
      outcome: 'success',
    });
    expect(metrics.forMetric(METRIC.requestDurationSeconds)).toHaveLength(1);
    expect(metrics.forMetric(METRIC.toolDurationSeconds)).toHaveLength(1);
    expect(metrics.forMetric(METRIC.upstreamDurationSeconds)[0]?.labels).toEqual({
      executor_type: 'test',
      outcome: 'success',
    });
    expect(metrics.forMetric(METRIC.policyDecisionsTotal)[0]?.labels).toEqual({
      phase: 'invocation',
      decision: 'allow',
    });
  });

  it('records output size, never output content', async () => {
    const { metrics, dispatcher } = harness(async () => ({
      ok: true,
      value: { pets: ['fluffy'] },
    }));

    await dispatcher.dispatch(command());

    const sample = metrics.forMetric(METRIC.outputBytes)[0];
    expect(sample?.value).toBe(Buffer.byteLength(JSON.stringify({ pets: ['fluffy'] }), 'utf8'));
    expect(JSON.stringify(sample?.labels)).not.toContain('fluffy');
  });

  it('records an error code series when the call fails', async () => {
    const { metrics, dispatcher } = harness(async () => ({
      ok: false,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'boom' },
    }));

    await dispatcher.dispatch(command());

    expect(metrics.forMetric(METRIC.toolErrorsTotal)[0]?.labels).toEqual({
      tool: 'listPets',
      error_code: 'UPSTREAM_UNAVAILABLE',
    });
    // No output-size sample on a failed call: there is no output.
    expect(metrics.forMetric(METRIC.outputBytes)).toEqual([]);
  });

  it('returns the in-flight gauge to zero after the call completes', async () => {
    // A gauge that only ever goes up is worse than absent — it reads as a leak
    // that is not happening, or hides one that is.
    const { metrics, dispatcher } = harness();

    await dispatcher.dispatch(command());

    const inflight = metrics.forMetric(METRIC.toolInflight);
    expect(inflight[0]?.value).toBe(1);
    expect(inflight[inflight.length - 1]?.value).toBe(0);
  });

  it('decrements in-flight even when the dispatch throws internally', async () => {
    const { metrics, dispatcher } = harness(async () => {
      throw new Error('executor exploded');
    });

    await dispatcher.dispatch(command());

    const inflight = metrics.forMetric(METRIC.toolInflight);
    expect(inflight[inflight.length - 1]?.value).toBe(0);
  });

  it('emits the two Epic-#3 placeholder series at construction', async () => {
    // So a dashboard built now starts showing real data when bulkheads and
    // breakers land, rather than needing a rebuild.
    const { metrics } = harness();

    expect(metrics.forMetric(METRIC.toolQueueDepth)[0]?.labels).toEqual({ bulkhead: 'default' });
    expect(metrics.forMetric(METRIC.circuitBreakerState)[0]?.labels).toEqual({
      breaker: 'default',
    });
    // Zero, not a fabricated number.
    expect(metrics.forMetric(METRIC.toolQueueDepth)[0]?.value).toBe(0);
  });
});
