// SPDX-License-Identifier: Apache-2.0
/**
 * OpenTelemetry adapter tests (#39).
 *
 * These replace the v0.1 stub-contract tests (#79), which pinned
 * `openTelemetry()` throwing "Not yet implemented" and said in their own
 * header that they should go red "the moment someone implements the real
 * adapter without replacing these tests, which is exactly when real coverage
 * needs to be written". That is what happened, so this is that coverage.
 */

import { describe, it, expect } from '@jest/globals';

import { openTelemetry } from '../index.js';
import type { OtelInstrumentLike, OtelMeterLike, OtelSpanLike, OtelTracerLike } from '../index.js';

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  ended: boolean;
}

function fakeTracer(): { tracer: OtelTracerLike; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];

  const tracer: OtelTracerLike = {
    startSpan(name, options) {
      const record: RecordedSpan = {
        name,
        attributes: { ...(options?.attributes ?? {}) },
        ended: false,
      };
      spans.push(record);

      const span: OtelSpanLike = {
        setAttribute(key, value) {
          record.attributes[key] = value;
          return span;
        },
        end() {
          record.ended = true;
        },
      };
      return span;
    },
  };

  return { tracer, spans };
}

interface RecordedSample {
  instrument: string;
  method: 'add' | 'record';
  value: number;
  attributes: Record<string, string>;
}

function fakeMeter(): { meter: OtelMeterLike; samples: RecordedSample[]; created: string[] } {
  const samples: RecordedSample[] = [];
  const created: string[] = [];

  const instrument = (name: string): OtelInstrumentLike => ({
    add: (value, attributes) =>
      samples.push({ instrument: name, method: 'add', value, attributes: { ...attributes } }),
    record: (value, attributes) =>
      samples.push({ instrument: name, method: 'record', value, attributes: { ...attributes } }),
  });

  const meter: OtelMeterLike = {
    createCounter: (name) => {
      created.push(name);
      return instrument(name);
    },
    createHistogram: (name) => {
      created.push(name);
      return instrument(name);
    },
    createUpDownCounter: (name) => {
      created.push(name);
      return instrument(name);
    },
  };

  return { meter, samples, created };
}

describe('openTelemetry', () => {
  it('returns an inert Observability when no exporter is configured', () => {
    // § Delivery makes no-exporter the DEFAULT. A default that throws is not a
    // default — that was the v0.1 stub's actual flaw.
    const observability = openTelemetry();

    expect(() => {
      const span = observability.tracer.startSpan('mcp.request');
      span.setAttribute('mcp.method', 'tools/call');
      span.startChild('mcp.tool.call').end();
      span.end();
      observability.metrics.add('mcp_requests_total', 1, { method: 'tools/call', outcome: 'success' });
    }).not.toThrow();
  });

  it('degrades only the missing half when just one of tracer/meter is supplied', () => {
    // "Traces but no metrics" is a legitimate deployment; failing it would be
    // gratuitous.
    const { tracer, spans } = fakeTracer();
    const observability = openTelemetry({ tracer });

    observability.tracer.startSpan('mcp.request').end();
    observability.metrics.add('mcp_requests_total', 1, { method: 'm', outcome: 'success' });

    expect(spans).toHaveLength(1);
  });

  it('forwards spans and attributes to the underlying tracer', () => {
    const { tracer, spans } = fakeTracer();
    const observability = openTelemetry({ tracer });

    const span = observability.tracer.startSpan('mcp.request', {
      attributes: { 'mcp.method': 'tools/call' },
    });
    span.setAttribute('mcp.tool.name', 'listPets');
    span.setOutcome('error', 'TIMEOUT');
    span.end();

    expect(spans[0]?.name).toBe('mcp.request');
    expect(spans[0]?.attributes['mcp.method']).toBe('tools/call');
    expect(spans[0]?.attributes['mcp.tool.name']).toBe('listPets');
    expect(spans[0]?.attributes['mcp.outcome']).toBe('error');
    expect(spans[0]?.attributes['mcp.error.code']).toBe('TIMEOUT');
    expect(spans[0]?.ended).toBe(true);
  });

  it('starts child spans on the underlying tracer', () => {
    const { tracer, spans } = fakeTracer();
    const observability = openTelemetry({ tracer });

    const root = observability.tracer.startSpan('mcp.request');
    root.startChild('mcp.tool.call').end();
    root.end();

    expect(spans.map((s) => s.name)).toEqual(['mcp.request', 'mcp.tool.call']);
  });

  it('redacts denied attributes BEFORE they reach the SDK', () => {
    // The adapter must not be a second place where redaction is decided, but
    // it must also not be a hole around the first. Checked against what the
    // fake SDK actually received.
    const { tracer, spans } = fakeTracer();
    const observability = openTelemetry({ tracer });

    const span = observability.tracer.startSpan('mcp.request', {
      attributes: { payload: 'token=secret' },
    });
    span.setAttribute('authorization', 'Bearer abc');
    span.end();

    expect(spans[0]?.attributes['payload']).toBe('[REDACTED]');
    expect(spans[0]?.attributes['authorization']).toBe('[REDACTED]');
    expect(JSON.stringify(spans[0])).not.toContain('Bearer abc');
  });

  it('creates an instrument for every declared metric', () => {
    const { meter, created } = fakeMeter();
    openTelemetry({ meter });

    // The thirteen from §9.2, plus mcp_bulkhead_rejected_total (#43), plus the
    // two retry series (#45), plus the three audit series (#48), so a
    // three audit series (#48) and mcp_redaction_hits_total (#49), so a
    // dashboard can reference any of them.
    expect(created).toHaveLength(20);
    expect(created).toContain('mcp_requests_total');
    expect(created).toContain('mcp_registry_operations');
    expect(created).toContain('mcp_tool_queue_depth');
    expect(created).toContain('mcp_bulkhead_rejected_total');
    expect(created).toContain('mcp_retry_attempts_total');
    expect(created).toContain('mcp_retry_exhausted_total');
    expect(created).toContain('mcp_audit_appends_total');
    expect(created).toContain('mcp_audit_buffer_size');
    expect(created).toContain('mcp_audit_dropped_total');
    expect(created).toContain('mcp_redaction_hits_total');
  });

  it('forwards counter and histogram samples with their labels', () => {
    const { meter, samples } = fakeMeter();
    const observability = openTelemetry({ meter });

    observability.metrics.add('mcp_requests_total', 1, { method: 'tools/call', outcome: 'success' });
    observability.metrics.record('mcp_tool_duration_seconds', 0.25, {
      tool: 'listPets',
      outcome: 'success',
    });

    expect(samples).toEqual([
      {
        instrument: 'mcp_requests_total',
        method: 'add',
        value: 1,
        attributes: { method: 'tools/call', outcome: 'success' },
      },
      {
        instrument: 'mcp_tool_duration_seconds',
        method: 'record',
        value: 0.25,
        attributes: { tool: 'listPets', outcome: 'success' },
      },
    ]);
  });

  it('enforces the cardinality rule at the adapter boundary too', () => {
    // An adopter can construct this recorder directly and bypass core's own,
    // so the check cannot live only in core.
    const { meter, samples } = fakeMeter();
    const observability = openTelemetry({ meter });

    expect(() =>
      observability.metrics.add('mcp_requests_total', 1, { user: 'alice' }),
    ).toThrow(/cardinality rule/);
    expect(samples).toEqual([]);
  });

  it('returns a fresh Observability per call', () => {
    expect(openTelemetry()).not.toBe(openTelemetry());
  });

  // ── Gauge semantics (#39 QA) ───────────────────────────────────────────
  //
  // These drive the REAL adapter, and that is the entire point of where they
  // live. Core's `RecordingMetricRecorder` stores the absolute value handed to
  // `set` and replays it verbatim, so an assertion made against it agrees with
  // ANY implementation of `set` — including one that accumulates. That is why
  // golden-trace's "returns the in-flight gauge to zero" test passed while the
  // shipped adapter was reading 4 after four non-overlapping calls.
  //
  // A gauge assertion is only worth anything at the boundary where the SDK
  // sees the value.

  const netLevel = (samples: RecordedSample[], instrument: string): number =>
    samples.filter((s) => s.instrument === instrument).reduce((total, s) => total + s.value, 0);

  it('tracks an absolute gauge level rather than accumulating it', () => {
    const { meter, samples } = fakeMeter();
    const { metrics } = openTelemetry({ meter });

    // Four sequential, NON-OVERLAPPING calls: in-flight goes 0 -> 1 -> 0 each
    // time. Nothing is ever concurrent, so the level must end at zero.
    for (let i = 0; i < 4; i += 1) {
      metrics.set('mcp_tool_inflight', 1, { tool: 'listPets' });
      metrics.set('mcp_tool_inflight', 0, { tool: 'listPets' });
    }

    // Passing absolute levels straight to an UpDownCounter's `add` sums them
    // and reads 4 here — the reported bug, reproduced at the boundary.
    expect(netLevel(samples, 'mcp_tool_inflight')).toBe(0);
  });

  it('reports the true level while calls overlap', () => {
    // The complement of the test above: ending at zero would also be satisfied
    // by an adapter that emitted nothing at all.
    const { meter, samples } = fakeMeter();
    const { metrics } = openTelemetry({ meter });
    const level = (n: number): void => metrics.set('mcp_tool_inflight', n, { tool: 'listPets' });

    level(1);
    expect(netLevel(samples, 'mcp_tool_inflight')).toBe(1);
    level(2);
    expect(netLevel(samples, 'mcp_tool_inflight')).toBe(2);
    level(1);
    expect(netLevel(samples, 'mcp_tool_inflight')).toBe(1);
    level(0);
    expect(netLevel(samples, 'mcp_tool_inflight')).toBe(0);
  });

  it('keeps gauge levels independent per label set', () => {
    // Sharing one level across series would let a busy tool mask an idle one.
    const { meter, samples } = fakeMeter();
    const { metrics } = openTelemetry({ meter });

    metrics.set('mcp_tool_inflight', 3, { tool: 'listPets' });
    metrics.set('mcp_tool_inflight', 0, { tool: 'createPet' });
    metrics.set('mcp_tool_inflight', 1, { tool: 'listPets' });

    const byTool = (tool: string): number =>
      samples
        .filter((s) => s.instrument === 'mcp_tool_inflight' && s.attributes.tool === tool)
        .reduce((total, s) => total + s.value, 0);

    expect(byTool('listPets')).toBe(1);
    expect(byTool('createPet')).toBe(0);
  });

  it('still emits a zero delta, so a flat placeholder series exists', () => {
    // `mcp_tool_queue_depth` and `mcp_circuit_breaker_state` are set to 0 and
    // never move until Epic #3. Suppressing a zero delta as "nothing changed"
    // would keep them out of the backend entirely, which defeats the reason
    // they are emitted — a dashboard you can build before the feature lands.
    const { meter, samples } = fakeMeter();
    const { metrics } = openTelemetry({ meter });

    metrics.set('mcp_tool_queue_depth', 0, { bulkhead: 'default' });

    expect(samples.filter((s) => s.instrument === 'mcp_tool_queue_depth')).toHaveLength(1);
  });

  it('enforces the cardinality rule on set(), including on an unmoved gauge', () => {
    // The denied-label check must not sit behind the delta bookkeeping: a
    // repeated set with an unchanged value produces a zero delta, and a guard
    // that only runs when the value moves is a guard with a hole in it.
    const { meter, samples } = fakeMeter();
    const { metrics } = openTelemetry({ meter });

    expect(() => metrics.set('mcp_tool_inflight', 0, { user: 'alice' })).toThrow(
      /cardinality rule/,
    );
    expect(() => metrics.set('mcp_tool_inflight', 0, { user: 'alice' })).toThrow(
      /cardinality rule/,
    );
    expect(samples).toEqual([]);
  });
});
