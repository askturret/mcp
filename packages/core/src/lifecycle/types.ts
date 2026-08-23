// SPDX-License-Identifier: Apache-2.0
/**
 * Graceful shutdown (§8.6).
 *
 * A bad shutdown loses audit records, cancels in-flight calls violently, or
 * leaves connections half-open. The sequence below is IMMOVABLE, and it is
 * declared as data rather than as control flow so that "the order is correct"
 * is a property a test can assert directly instead of one a reviewer has to
 * trace through branches.
 */

/** The seven phases of §8.6, in their required order. */
export type ShutdownPhase =
  | 'mark-not-ready'
  | 'stop-accepting'
  | 'cancel-queued'
  | 'drain-in-flight'
  | 'flush-audit'
  | 'flush-telemetry'
  | 'close-resources';

/**
 * §8.6's order, as data.
 *
 * Exported so a test can pin it against the phases a real shutdown actually
 * ran. Reordering the sequence then shows up as a one-line diff to a named
 * constant rather than as a subtle rearrangement of statements.
 */
export const SHUTDOWN_SEQUENCE: readonly ShutdownPhase[] = [
  'mark-not-ready',
  'stop-accepting',
  'cancel-queued',
  'drain-in-flight',
  'flush-audit',
  'flush-telemetry',
  'close-resources',
];

/**
 * What the runtime supplies for each phase.
 *
 * Every hook is optional: a transport that has no queue to cancel should not
 * have to supply an empty function, and a missing hook is recorded as a phase
 * that ran with nothing to do rather than as a phase that was skipped.
 */
export interface ShutdownHooks {
  /** Phase 1 — flip readiness to false BEFORE anything else changes. */
  readonly markNotReady?: () => void | Promise<void>;

  /** Phase 2 — transport begins rejecting new requests with 503. */
  readonly stopAccepting?: () => void | Promise<void>;

  /** Phase 3 — queued (not yet running) calls are released. */
  readonly cancelQueued?: () => void | Promise<void>;

  /** Phase 4 — resolves when every in-flight call has finished. */
  readonly drainInFlight?: () => Promise<void>;

  /**
   * Called when phase 4 exceeds the drain deadline.
   *
   * Separate from `drainInFlight` because the deadline is the coordinator's
   * to enforce: a drain hook that policed its own timeout could report
   * success at the moment it gave up, and the difference between "everything
   * finished" and "we stopped waiting" is the whole point of the deadline.
   */
  readonly cancelInFlight?: () => void | Promise<void>;

  /** Phase 5 — MUST complete. Stronger delivery than telemetry. */
  readonly flushAudit?: () => Promise<void>;

  /** Phase 6 — best-effort, bounded by `telemetryFlushMs`. */
  readonly flushTelemetry?: () => Promise<void>;

  /** Phase 7 — transports, executors, HTTP clients. */
  readonly closeResources?: () => Promise<void>;
}

export interface ShutdownOptions {
  /** Cap on phase 4. Default 30_000 (§8.6). */
  readonly drainMs?: number;

  /** Cap on phase 6. Default 5_000 (§8.6). */
  readonly telemetryFlushMs?: number;

  /**
   * Skip the drain and cancel in-flight calls immediately (`forceClose`).
   *
   * Audit still flushes — best-effort, but attempted. §8.6 is explicit that
   * even an immediate close "still tries to flush audit".
   */
  readonly force?: boolean;
}

export interface ShutdownPhaseError {
  readonly phase: ShutdownPhase;
  readonly message: string;
}

export interface ShutdownResult {
  /** Phases that ran, in the order they ran. */
  readonly phases: readonly ShutdownPhase[];

  /** True when phase 4 hit the drain deadline and calls were cancelled. */
  readonly drainTimedOut: boolean;

  /** True when this was a `forceClose`. */
  readonly forced: boolean;

  /** True when phase 5 completed without throwing. */
  readonly auditFlushed: boolean;

  /**
   * Errors from individual phases.
   *
   * Collected rather than thrown: a phase that fails must NOT abort the
   * sequence, because the phases most worth reaching — audit flush above all
   * — come after the ones most likely to fail. A shutdown that gave up at the
   * first error would lose exactly the records §8.6 exists to preserve.
   */
  readonly errors: readonly ShutdownPhaseError[];
}
