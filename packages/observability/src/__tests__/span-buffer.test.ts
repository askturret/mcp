// SPDX-License-Identifier: Apache-2.0
/**
 * The span buffer behind the Explorer's trace panel (#56).
 *
 * This did not exist before #56 — #39's `openTelemetry()` forwards spans and
 * retains nothing. The tests that matter are the two properties that make
 * retaining request metadata acceptable at all: it is BOUNDED, and what it
 * holds is REDACTED.
 */

import { describe, it, expect } from '@jest/globals';

import { createSpanBuffer, recordingTracer, DEFAULT_SPAN_BUFFER_SIZE } from '../span-buffer.js';
import type { Tracer } from '@askturret/mcp-core';

function fakeTracer(): { tracer: Tracer; started: string[] } {
  const started: string[] = [];
  const tracer = {
    startSpan: (name: string) => {
      started.push(name);
      return { setAttribute: () => {}, setOutcome: () => {}, end: () => {} };
    },
  } as unknown as Tracer;
  return { tracer, started };
}

describe('the span buffer', () => {
  it('is BOUNDED — an unbounded debugging tail is a leak on long-lived servers', () => {
    const buffer = createSpanBuffer(3);
    for (let i = 0; i < 10; i += 1) {
      buffer.push({ name: `s${i}`, attributes: {}, startedAt: i });
    }

    expect(buffer.size).toBe(3);
    // Newest first, oldest evicted.
    expect(buffer.recent().map((s) => s.name)).toEqual(['s9', 's8', 's7']);
  });

  it('REDACTS on the way IN, so it never holds a raw secret', () => {
    // On the way in rather than on the way out to the page: a buffer holding
    // raw attributes is a heap-dump risk and a second thing to remember to
    // redact at every future read site.
    const buffer = createSpanBuffer();
    const { tracer } = fakeTracer();
    const recording = recordingTracer(tracer, buffer);

    recording.startSpan('mcp.tool.call' as never, {
      attributes: { apiKey: 'sk_live_abcdef123456' } as never,
    }).end();

    const stored = JSON.stringify(buffer.recent());
    expect(stored).not.toContain('sk_live_abcdef123456');
  });

  it('still forwards to the delegate — the panel must not cost a real span', () => {
    const buffer = createSpanBuffer();
    const { tracer, started } = fakeTracer();

    recordingTracer(tracer, buffer).startSpan('mcp.tool.call' as never).end();

    expect(started).toEqual(['mcp.tool.call']);
    expect(buffer.size).toBe(1);
  });

  it('records duration and outcome', () => {
    const buffer = createSpanBuffer();
    const { tracer } = fakeTracer();
    let clock = 100;

    const span = recordingTracer(tracer, buffer, () => clock).startSpan('mcp.tool.call' as never);
    (span as { setOutcome: (r: string, c?: string) => void }).setOutcome('error', 'FORBIDDEN');
    clock = 150;
    span.end();

    const [recorded] = buffer.recent();
    expect(recorded?.durationMs).toBe(50);
    expect(recorded?.outcome).toBe('error:FORBIDDEN');
  });

  it('keeps a small default — this is a debugging tail, not storage', () => {
    expect(DEFAULT_SPAN_BUFFER_SIZE).toBe(50);
  });
});
