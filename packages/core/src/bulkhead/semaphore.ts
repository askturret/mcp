// SPDX-License-Identifier: Apache-2.0
/**
 * A bounded-queue semaphore — one bulkhead (§8.2, ADR-013).
 *
 * ## Why rejection is synchronous
 *
 * §43 requires overflow to return `QUEUE_FULL` "immediately", within 10ms even
 * under saturation. The capacity decision here is therefore made with a
 * comparison against two counters and NO await before it: an implementation
 * that queued first and rejected later would meet the letter of the rule while
 * having already paid the cost the rule exists to avoid — the memory, and the
 * caller's time.
 *
 * `acquire` still returns a promise, because a caller that DOES fit in the
 * queue must wait. The distinction is that the reject path never yields.
 */

import { BulkheadRejection, type BulkheadConfig, type BulkheadPermit } from './types.js';

interface Waiter {
  readonly resolve: (permit: BulkheadPermit) => void;
  readonly reject: (error: BulkheadRejection) => void;
  /** Detaches the abort listener. Called on every exit path. */
  readonly cleanup: () => void;
  settled: boolean;
}

export class Bulkhead {
  private inFlight = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly name: string,
    private readonly config: BulkheadConfig,
    private readonly onDepthChange?: (name: string, queued: number) => void,
  ) {}

  get queued(): number {
    return this.waiters.length;
  }

  get running(): number {
    return this.inFlight;
  }

  acquire(signal?: AbortSignal): Promise<BulkheadPermit> {
    // Already-cancelled callers never take a slot. Checked before capacity so
    // an abandoned request cannot displace a live one.
    if (signal?.aborted === true) {
      return Promise.reject(
        new BulkheadRejection('CANCELLED', this.name, `call cancelled before entering ${this.name}`),
      );
    }

    if (this.inFlight < this.config.concurrency) {
      this.inFlight += 1;
      return Promise.resolve(this.permit());
    }

    // Saturated. Is there room to wait?
    if (this.waiters.length >= this.config.queueSize) {
      // The fast path §43 is about: no allocation, no await, no queue growth.
      return Promise.reject(
        new BulkheadRejection(
          'QUEUE_FULL',
          this.name,
          `bulkhead '${this.name}' is full (${this.config.concurrency} in flight, ` +
            `${this.waiters.length} queued, queueSize ${this.config.queueSize})`,
        ),
      );
    }

    return new Promise<BulkheadPermit>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
        settled: false,
      };

      // A cancelled QUEUED call must release its place, not merely stop caring
      // about the answer (§43). Without this the queue stays full of callers
      // who have gone away, and live traffic is rejected on their behalf.
      const onAbort = (): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        waiter.cleanup();
        this.reportDepth();
        reject(
          new BulkheadRejection('CANCELLED', this.name, `call cancelled while queued on ${this.name}`),
        );
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      this.reportDepth();
    });
  }

  private permit(): BulkheadPermit {
    let released = false;
    return {
      bulkhead: this.name,
      release: () => {
        // Idempotent. A double release would hand out a slot that is still
        // occupied, silently raising effective concurrency above the bound —
        // and it would do so without any error to notice.
        if (released) return;
        released = true;
        this.releaseSlot();
      },
    };
  }

  private releaseSlot(): void {
    // Hand the slot straight to the next waiter rather than decrementing and
    // letting them re-race for it. Re-racing lets a newly arriving call jump
    // ahead of one that has already waited, which turns a bounded queue into
    // an unfair one under sustained load.
    let next = this.waiters.shift();
    while (next !== undefined && next.settled) {
      next = this.waiters.shift();
    }

    if (next === undefined) {
      this.inFlight -= 1;
      this.reportDepth();
      return;
    }

    next.settled = true;
    next.cleanup();
    this.reportDepth();
    // The slot is transferred, so `inFlight` is deliberately unchanged.
    next.resolve(this.permit());
  }

  private reportDepth(): void {
    this.onDepthChange?.(this.name, this.waiters.length);
  }
}
