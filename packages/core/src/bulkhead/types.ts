// SPDX-License-Identifier: Apache-2.0
/**
 * Bulkhead configuration and permits (§8.2, ADR-013).
 *
 * One slow dependency must not be able to exhaust all worker capacity. A
 * bulkhead bounds BOTH the in-flight calls and the calls willing to wait, so
 * overload is rejected in constant time instead of accumulating in memory —
 * an unbounded queue does not prevent an outage, it postpones it and makes the
 * eventual failure a heap exhaustion rather than a fast error.
 */

import type { EffectClassification, OperationDefinition } from '../types.js';

export interface BulkheadConfig {
  /** Maximum calls executing at once. */
  readonly concurrency: number;

  /**
   * Maximum calls WAITING for a slot.
   *
   * Reached means the next caller is rejected with `QUEUE_FULL` immediately.
   * A queue is a shock absorber, not storage: sized so a brief burst rides
   * through, and anything beyond it is shed while the caller still cares
   * about the answer.
   */
  readonly queueSize: number;
}

/**
 * Named bulkheads plus the fallback every unassigned operation lands in.
 *
 * `default` is required rather than optional. An operation that matched no
 * group and found no default would have to either run unbounded — defeating
 * the isolation this module exists to provide — or fail, which is a strange
 * outcome for a missing config entry. Requiring it removes the question.
 */
export interface BulkheadsConfig {
  readonly default: BulkheadConfig;
  readonly [name: string]: BulkheadConfig;
}

/** Light preset defaults (§43 config surface). */
export const DEFAULT_BULKHEADS: BulkheadsConfig = {
  default: { concurrency: 20, queueSize: 40 },
  reads: { concurrency: 50, queueSize: 100 },
  writes: { concurrency: 10, queueSize: 20 },
  reports: { concurrency: 2, queueSize: 5 },
};

/**
 * A held slot. `release()` MUST be called, and exactly once.
 *
 * Idempotent by contract: a double release would hand out a slot that is still
 * occupied, which silently raises the effective concurrency above the
 * configured bound — the one number the whole module exists to enforce.
 */
export interface BulkheadPermit {
  readonly bulkhead: string;
  release(): void;
}

export interface BulkheadStats {
  readonly name: string;
  readonly inFlight: number;
  readonly queued: number;
  readonly concurrency: number;
  readonly queueSize: number;
}

export interface BulkheadRegistry {
  /**
   * Acquire a slot, waiting if the bulkhead is busy but its queue has room.
   *
   * Rejects with a `BulkheadRejection` when the queue is full, or when
   * `signal` aborts while queued.
   */
  acquire(name: string, signal?: AbortSignal): Promise<BulkheadPermit>;

  /** Which bulkhead this operation belongs to. */
  assign(operation: OperationDefinition): string;

  stats(): readonly BulkheadStats[];
}

/** Thrown by `acquire` — carries the code the dispatcher maps to the wire. */
export class BulkheadRejection extends Error {
  constructor(
    readonly code: 'QUEUE_FULL' | 'CANCELLED',
    readonly bulkhead: string,
    message: string,
  ) {
    super(message);
    this.name = 'BulkheadRejection';
  }
}

/**
 * Effect classifications routed to the `reports` bulkhead by default.
 *
 * §43 says "long-running -> reports", but NOTHING in `EffectMetadata` marks an
 * operation as long-running — there is no duration hint, no timeout field, no
 * such classification. `data-export` is the closest real signal the model
 * carries: a bulk extract is the canonical expensive read, and it is the case
 * the `reports` group is described for.
 *
 * Flagged for QA rather than silently equated: this is an INFERENCE from the
 * available data, not the rule as written. An explicit
 * `annotations.bulkhead: 'reports'` always wins over it.
 */
export const REPORT_CLASSIFICATIONS: readonly EffectClassification[] = ['data-export'];
