// SPDX-License-Identifier: Apache-2.0
/**
 * Circuit breaker configuration and state (§8.5).
 *
 * Breakers are scoped to an upstream/executor group, NEVER global. One failing
 * dependency must not open the breaker for the whole server — that turns a
 * partial outage into a total one, which is the opposite of what a breaker is
 * for.
 */

import type { OperationErrorCode } from '../types.js';

/**
 * `closed -> open -> half-open -> closed` (§8.5).
 *
 * - `closed` — normal operation; failures are counted but calls flow.
 * - `open` — calls return `UPSTREAM_UNAVAILABLE` immediately, without touching
 *   the executor.
 * - `half-open` — after the cool-down, a bounded number of probes are admitted;
 *   all must succeed to close, and any failure re-opens with a fresh cool-down.
 */
export type BreakerState = 'closed' | 'half-open' | 'open';

/**
 * Numeric encoding for `mcp_circuit_breaker_state` (§8.5 Observability).
 *
 * §8.5 is explicit that state must NOT be a string label — "enums as numeric
 * values keep cardinality low and let Grafana graph it cleanly". A string label
 * would also create one time series per state per breaker, two of which are
 * always stale.
 *
 * The ordering is meaningful: higher is worse, so `max()` over an interval is
 * "the worst state this breaker reached", which is the query an operator
 * actually writes.
 */
export const BREAKER_STATE_VALUE: Readonly<Record<BreakerState, number>> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

export interface BreakerConfig {
  /** Failures within the window that open the breaker. */
  readonly failureThreshold: number;

  /**
   * Rolling window over which failures are counted.
   *
   * Without a window, a breaker accumulates failures forever and eventually
   * opens on a healthy upstream that merely had a bad afternoon last week.
   */
  readonly failureWindowMs: number;

  /** How long the breaker stays open before admitting probes. */
  readonly cooldownMs: number;

  /** Probes admitted while half-open. ALL must succeed to close. */
  readonly halfOpenProbes: number;

  /**
   * Upstream this breaker covers, matched as a prefix against the operation's
   * effective base URL.
   *
   * §8.5 says operations get a breaker "by matching `executor.baseUrl`", but
   * the config example it gives carries no URL field — so there is nothing to
   * match against. This is that field. Group NAMES stay operator-chosen
   * (`ordersApi`), which keeps the metric label bounded by config rather than
   * by however many hosts happen to be reachable. Flagged for QA as the
   * minimum invention needed to make the stated rule implementable.
   */
  readonly baseUrl?: string;
}

/**
 * Named breakers plus the fallback every unassigned operation lands in.
 *
 * `default` is required for the same reason `BulkheadsConfig.default` is: an
 * operation that matched no group would otherwise have to run unprotected,
 * defeating the isolation this module provides.
 */
export interface BreakersConfig {
  readonly default: BreakerConfig;
  readonly [name: string]: BreakerConfig;
}

/** Conservative defaults, used when a dispatcher enables breakers without config. */
export const DEFAULT_BREAKERS: BreakersConfig = {
  default: {
    failureThreshold: 10,
    failureWindowMs: 60_000,
    cooldownMs: 30_000,
    halfOpenProbes: 3,
  },
};

/**
 * Error codes that count as evidence the UPSTREAM is unhealthy (§8.5).
 *
 * ## Why this is not `TRANSIENT_CODES` from #45, despite the overlap
 *
 * The two lists answer different questions, and conflating them is the easy
 * mistake here:
 *
 * - #45's retry list asks **"is it safe to try this again?"**
 * - This list asks **"is the dependency sick?"**
 *
 * `OUTCOME_UNKNOWN` is where they come apart, and it is the reason these are
 * separate constants rather than one shared export. It must NEVER be retried —
 * the upstream may already have applied the write. But it is *emphatically*
 * evidence of an unhealthy upstream: it means the connection died after the
 * request was sent, or the deadline passed with the request in flight. An
 * upstream that accepts requests and then drops the connection is precisely
 * the failure a breaker exists to stop hammering — and it would never trip one
 * built from the retry list.
 *
 * §8.5's own list does not name `OUTCOME_UNKNOWN` either way. Counting it is a
 * deliberate addition, flagged for QA rather than assumed.
 *
 * `INTERNAL_ERROR` is deliberately EXCLUDED even though §8.5 says "unexpected
 * 5xx" counts. Since #45 the genuinely transient upstream statuses —
 * 502/503/504 — map to `UPSTREAM_UNAVAILABLE`, so they are covered by the
 * first entry below. What is left under `INTERNAL_ERROR` is a 500 (an
 * application fault at a reachable upstream) or a bug in this process. Neither
 * means the dependency is unreachable, and letting our own bug open a breaker
 * on a healthy upstream would take out a working dependency.
 *
 * `CANCELLED` is excluded because the client hung up; that is not the
 * upstream's fault, and counting it would let a burst of client disconnects
 * open a breaker on a perfectly healthy service.
 *
 * `NOT_FOUND` (#201) is excluded for the same reason as `FORBIDDEN`, and it is
 * worth stating rather than leaving to the omission: asking for a resource that
 * does not exist is ORDINARY TRAFFIC. A crawler walking stale links, or a
 * client polling for a record not yet created, would otherwise trip the breaker
 * on a completely healthy upstream — and opening it would neither create the
 * missing resource nor let anything else through.
 *
 * Note this list is an ALLOWLIST, so a new code is excluded by default. That is
 * the safe direction — a code wrongly absent under-trips a breaker, whereas one
 * wrongly present takes out a working dependency — but it does mean types.ts's
 * "explicitly rather than by omission" rule is satisfied here in prose rather
 * than by an entry. Anything added to `OperationErrorCode` should get a
 * sentence here saying which way it went, and why.
 */
export const BREAKER_FAILURE_CODES: readonly OperationErrorCode[] = [
  'UPSTREAM_UNAVAILABLE',
  'TIMEOUT',
  'OUTCOME_UNKNOWN',
];

/** Point-in-time view of one breaker, for Explorer and diagnostics. */
export interface BreakerStats {
  readonly name: string;
  readonly state: BreakerState;
  /** Failures currently inside the rolling window. */
  readonly failures: number;
  readonly failureThreshold: number;
  /** Successful probes so far in the current half-open episode. */
  readonly halfOpenSuccesses: number;
  readonly halfOpenProbes: number;
}

/** Whether a call may proceed, and why not when it may not. */
export interface BreakerAdmission {
  readonly allowed: boolean;
  readonly state: BreakerState;
  /** True when this admission is a half-open probe. */
  readonly probe: boolean;
}

export interface BreakerRegistry {
  /** Which breaker this operation belongs to. */
  assign(operation: import('../types.js').OperationDefinition): string;

  /** Ask permission to call the upstream. */
  tryAcquire(name: string): BreakerAdmission;

  /** Report the outcome of a call that `tryAcquire` admitted. */
  record(name: string, errorCode: OperationErrorCode | undefined): void;

  stats(): readonly BreakerStats[];
}
