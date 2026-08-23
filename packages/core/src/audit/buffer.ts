// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded buffering with back-pressure (§48 delivery semantics).
 */

import { METRIC, type MetricRecorder } from '../telemetry/types.js';
import { noopMetricRecorder } from '../telemetry/metrics.js';
import type { AuditEvent, AuditSink, BufferedSinkOptions, OverflowPolicy } from './types.js';

export const DEFAULT_MAX_BUFFER_SIZE = 1000;

/**
 * Wrap a sink with an in-memory queue.
 *
 * Exists so a slow or remote delegate does not sit on the dispatch path:
 * `append` returns as soon as the event is queued, and a background loop
 * writes it out. §48 requires exactly that ("retries never gate dispatcher
 * progress on the primary path"), together with the guarantee that shutdown
 * still flushes (§8.6 phase 5).
 *
 * The queue is BOUNDED, and that is the load-bearing part. An unbounded audit
 * buffer does not prevent loss, it converts a bounded loss into an
 * out-of-memory crash that loses the whole buffer at once.
 */
export function bufferedSink(
  delegate: AuditSink,
  options: BufferedSinkOptions & { metrics?: MetricRecorder } = {},
): AuditSink & { readonly bufferSize: number; readonly droppedCount: number } {
  const maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  const overflow: OverflowPolicy = options.overflow ?? 'block';
  const metrics = options.metrics ?? noopMetricRecorder;
  const sink = delegate.id;

  const queue: AuditEvent[] = [];
  /** Appenders parked because the queue was full. One is released per slot. */
  const spaceWaiters: (() => void)[] = [];
  let drainLoop: Promise<void> | undefined;
  let dropped = 0;

  const publishBufferSize = (): void => {
    metrics.set(METRIC.auditBufferSize, queue.length, { sink });
  };

  publishBufferSize();

  /**
   * Release exactly ONE parked appender per freed slot.
   *
   * Waking them all would let every waiter push at once and blow straight
   * past `maxBufferSize` — the bound would hold only while nothing was
   * waiting on it, which is precisely when it does not matter.
   */
  const releaseOne = (): void => {
    const waiter = spaceWaiters.shift();
    if (waiter !== undefined) waiter();
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const event = queue.shift() as AuditEvent;
      publishBufferSize();
      releaseOne();

      try {
        await delegate.append(event);
        metrics.add(METRIC.auditAppendsTotal, 1, { sink, outcome: 'success' });
      } catch {
        // A failed write is COUNTED, never rethrown. This loop runs detached
        // from any caller, so throwing here would surface as an unhandled
        // rejection and take the process down — losing the rest of the buffer
        // to protect one record. Durable delivery is the delegate's job (the
        // HTTP sink retries); the counter is how a failing sink stays visible.
        metrics.add(METRIC.auditAppendsTotal, 1, { sink, outcome: 'error' });
      }
    }
  };

  const kick = (): void => {
    if (drainLoop !== undefined) return;
    drainLoop = drain().finally(() => {
      drainLoop = undefined;
    });
  };

  return {
    id: sink,

    get bufferSize(): number {
      return queue.length;
    },

    get droppedCount(): number {
      return dropped;
    },

    async append(event: AuditEvent): Promise<void> {
      if (queue.length >= maxBufferSize) {
        if (overflow === 'drop') {
          dropped += 1;
          // Loud by construction: §48 says the drop counter cannot be
          // suppressed, because a non-zero value means the deployment is
          // configured to violate the audit guarantee.
          metrics.add(METRIC.auditDroppedTotal, 1, { sink });
          return;
        }

        // BLOCK: park until the drain frees a slot. The caller is stage 11 of
        // dispatch, so this is the back-pressure reaching the request path.
        await new Promise<void>((resolve) => {
          spaceWaiters.push(resolve);
        });
      }

      queue.push(event);
      publishBufferSize();
      kick();
    },

    async flush(): Promise<void> {
      // Loop rather than a single await.
      //
      // The window is narrow: `drain` only exits with an empty queue, so most
      // late appends are picked up by the loop it is already running. What a
      // single await misses is an append landing AFTER `drain`'s while-check
      // fails but BEFORE its `.finally` clears `drainLoop` — that append's
      // `kick()` sees a loop still running and returns, and then the loop
      // ends. The event sits queued with nothing draining it, and a one-shot
      // await returns reporting success: the "flushed" lie §8.6 phase 5
      // cannot afford.
      //
      // HONEST COVERAGE NOTE: replacing this loop with a single await does
      // NOT fail any test in this suite. The race is sub-microtask and I
      // could not drive it deterministically; a probabilistic test would be
      // worse than none. The loop is retained because it is correct and
      // costs one extra check, not because a test proves it necessary.
      for (;;) {
        if (queue.length > 0) kick();
        const running = drainLoop;
        if (running === undefined) break;
        await running;
      }

      await delegate.flush();
    },

    async close(): Promise<void> {
      // Flush BEFORE closing: closing a delegate with events still queued is
      // the loss this module exists to prevent.
      await this.flush();
      await delegate.close?.();
    },
  };
}
