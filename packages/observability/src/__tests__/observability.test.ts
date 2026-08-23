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

    // All thirteen from §9.2, so a dashboard can reference any of them.
    expect(created).toHaveLength(13);
    expect(created).toContain('mcp_requests_total');
    expect(created).toContain('mcp_registry_operations');
    expect(created).toContain('mcp_tool_queue_depth');
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
});
