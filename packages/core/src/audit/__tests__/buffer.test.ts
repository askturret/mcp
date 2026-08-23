// SPDX-License-Identifier: Apache-2.0
/**
 * Delivery semantics: back-pressure, drop-loudness, and flush (§48, §8.6).
 */

import { describe, it, expect } from '@jest/globals';

import { bufferedSink } from '../index.js';
import { createRecordingMetricRecorder } from '../../telemetry/metrics.js';
import { METRIC } from '../../telemetry/types.js';
import type { AuditEvent, AuditSink } from '../types.js';

function event(id: string): AuditEvent {
  return {
    eventId: id,
    timestamp: new Date(0).toISOString(),
    requestId: id,
    operationId: 'op',
    registryHash: 'h',
    policyDecision: 'allow',
    outcome: 'success',
    durationMs: 1,
  };
}

/** A delegate whose writes complete only when the test says so. */
function gatedDelegate(id = 'gated') {
  const received: AuditEvent[] = [];
  let releases: (() => void)[] = [];
  let flushed = 0;

  const sink: AuditSink = {
    id,
    append: (e) =>
      new Promise<void>((resolve) => {
        received.push(e);
        releases.push(resolve);
      }),
    flush: async () => {
      flushed += 1;
    },
  };

  return {
    sink,
    received,
    flushes: () => flushed,
    /** Complete the next `n` pending writes. */
    release(n = Infinity) {
      const take = releases.splice(0, n === Infinity ? releases.length : n);
      for (const resolve of take) resolve();
    },
  };
}

const passthrough = (id = 'ok'): AuditSink & { received: AuditEvent[] } => {
  const received: AuditEvent[] = [];
  return {
    id,
    received,
    append: async (e) => {
      received.push(e);
    },
    flush: async () => undefined,
  };
};

describe('back-pressure is the default (§48)', () => {
  it('blocks the appender once the buffer is full', async () => {
    // The behaviour the whole module exists for: dispatch slows down rather
    // than the record being lost.
    const delegate = gatedDelegate();
    const sink = bufferedSink(delegate.sink, { maxBufferSize: 1 });

    await sink.append(event('a')); // handed to the delegate, which stalls
    await sink.append(event('b')); // fills the single slot

    let third = false;
    const pending = sink.append(event('c')).then(() => {
      third = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(third).toBe(false);

    delegate.release();
    await pending;
    expect(third).toBe(true);
  });

  it('never drops in block mode, however far behind the delegate falls', async () => {
    const delegate = gatedDelegate();
    const sink = bufferedSink(delegate.sink, { maxBufferSize: 2 });

    const appends = Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((id) => sink.append(event(id))),
    );

    // Release repeatedly until the queue drains; each release frees one slot
    // and admits one parked appender.
    for (let i = 0; i < 10; i += 1) {
      delegate.release();
      await new Promise((resolve) => setImmediate(resolve));
    }

    await appends;
    await sink.flush();

    expect(delegate.received.map((e) => e.eventId).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('admits exactly ONE parked appender per freed slot', async () => {
    // Waking every waiter on a single freed slot would blow past
    // maxBufferSize — the bound would hold only while nothing was waiting on
    // it, which is exactly when it does not matter.
    //
    // The sequencing here is load-bearing, and an earlier version of this
    // test missed it: parking appenders is not enough, because a waiter is
    // only released when a delegate WRITE COMPLETES. With a delegate that
    // never completes, `releaseOne` never runs and the mutation is never
    // executed. So exactly one write is released, and the queue is measured
    // immediately afterwards.
    const delegate = gatedDelegate();
    const sink = bufferedSink(delegate.sink, { maxBufferSize: 2 });

    await sink.append(event('a')); // taken by the drain, delegate stalls
    await sink.append(event('b')); // queue: [b]
    await sink.append(event('c')); // queue: [b, c] — full

    void sink.append(event('d')); // parked
    void sink.append(event('e')); // parked
    void sink.append(event('f')); // parked

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sink.bufferSize).toBe(2);

    // Complete ONE write. That frees one slot, so at most one parked
    // appender may proceed.
    delegate.release(1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sink.bufferSize).toBeLessThanOrEqual(2);
  });
});

describe('drop mode is opt-in and loud (§48)', () => {
  it('drops instead of blocking, and counts every drop', async () => {
    const metrics = createRecordingMetricRecorder();
    const delegate = gatedDelegate();
    const sink = bufferedSink(delegate.sink, {
      maxBufferSize: 1,
      overflow: 'drop',
      metrics,
    });

    await sink.append(event('a'));
    await sink.append(event('b'));
    await sink.append(event('c')); // dropped
    await sink.append(event('d')); // dropped

    const drops = metrics.forMetric(METRIC.auditDroppedTotal);
    expect(drops).toHaveLength(2);
    expect(drops[0]?.labels['sink']).toBe('gated');
    expect(sink.droppedCount).toBe(2);
  });

  it('emits the drop counter even with no other metrics activity', async () => {
    // §48: the loudness "cannot be suppressed". A non-zero value here means
    // the deployment is configured to violate the delivery guarantee, so it
    // has to be alertable rather than inferable.
    const metrics = createRecordingMetricRecorder();
    const sink = bufferedSink(
      { id: 's', append: () => new Promise<void>(() => undefined), flush: async () => undefined },
      { maxBufferSize: 1, overflow: 'drop', metrics },
    );

    await sink.append(event('a'));
    await sink.append(event('b'));
    await sink.append(event('c'));

    expect(metrics.forMetric(METRIC.auditDroppedTotal)).toHaveLength(1);
  });

  it('does not drop while there is room', async () => {
    const metrics = createRecordingMetricRecorder();
    const delegate = passthrough();
    const sink = bufferedSink(delegate, { maxBufferSize: 10, overflow: 'drop', metrics });

    for (const id of ['a', 'b', 'c']) await sink.append(event(id));
    await sink.flush();

    expect(metrics.forMetric(METRIC.auditDroppedTotal)).toHaveLength(0);
    expect(delegate.received).toHaveLength(3);
  });
});

describe('flush means durable (§8.6 phase 5)', () => {
  it('resolves only once every queued event has reached the delegate', async () => {
    // §48's shutdown test, scaled: 100 events buffered when close() is
    // called, all persisted by the time it returns.
    const delegate = passthrough();
    const sink = bufferedSink(delegate, { maxBufferSize: 500 });

    for (let i = 0; i < 100; i += 1) void sink.append(event(`e${i}`));

    await sink.flush();

    expect(delegate.received).toHaveLength(100);
    expect(sink.bufferSize).toBe(0);
  });

  it('also flushes events appended DURING the flush', async () => {
    // A one-shot await would return with the buffer non-empty — exactly the
    // "flushed" lie §8.6 phase 5 cannot afford.
    const delegate = passthrough();
    const sink = bufferedSink(delegate, { maxBufferSize: 500 });

    void sink.append(event('first'));
    const flushing = sink.flush();
    void sink.append(event('second'));

    await flushing;

    expect(delegate.received.map((e) => e.eventId)).toContain('second');
  });

  it('delegates flush to the underlying sink', async () => {
    const delegate = gatedDelegate();
    const sink = bufferedSink(delegate.sink, { maxBufferSize: 10 });

    await sink.flush();

    expect(delegate.flushes()).toBe(1);
  });

  it('flushes before closing, so no queued event is lost', async () => {
    const delegate = passthrough();
    const sink = bufferedSink(delegate, { maxBufferSize: 100 });

    void sink.append(event('a'));
    await sink.close?.();

    expect(delegate.received).toHaveLength(1);
  });
});

describe('a failing delegate does not take the process down', () => {
  it('counts the failure and keeps draining', async () => {
    // The drain loop is DETACHED from any caller, so a throw would surface as
    // an unhandled rejection — losing the rest of the buffer to protect one
    // record.
    const metrics = createRecordingMetricRecorder();
    let calls = 0;

    const sink = bufferedSink(
      {
        id: 'flaky',
        append: async () => {
          calls += 1;
          if (calls === 1) throw new Error('write failed');
        },
        flush: async () => undefined,
      },
      { metrics },
    );

    await sink.append(event('a'));
    await sink.append(event('b'));
    await sink.flush();

    const appends = metrics.forMetric(METRIC.auditAppendsTotal);
    expect(appends.map((s) => s.labels['outcome'])).toEqual(['error', 'success']);
  });
});

describe('buffer-size gauge', () => {
  it('publishes zero at construction so an idle sink is visible', async () => {
    const metrics = createRecordingMetricRecorder();
    bufferedSink(passthrough(), { metrics });

    const samples = metrics.forMetric(METRIC.auditBufferSize);
    expect(samples[0]).toMatchObject({ value: 0, labels: { sink: 'ok' } });
  });

  it('returns to zero once drained', async () => {
    const metrics = createRecordingMetricRecorder();
    const sink = bufferedSink(passthrough(), { metrics });

    void sink.append(event('a'));
    await sink.flush();

    const samples = metrics.forMetric(METRIC.auditBufferSize);
    expect(samples[samples.length - 1]?.value).toBe(0);
  });
});
