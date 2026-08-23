// SPDX-License-Identifier: Apache-2.0
/**
 * The `closed -> open -> half-open -> closed` state machine (§8.5).
 *
 * Deliberately clock-injected and side-effect-free apart from its own state:
 * transitions are reported through a callback rather than written to a metric
 * or a log from in here. That keeps the machine testable at exact instants
 * without sleeping, and keeps "what the state is" separate from "who is told
 * about it".
 */

import type { BreakerConfig, BreakerState, BreakerAdmission, BreakerStats } from './types.js';

/** Told to the registry on every transition, for the metric and the log. */
export interface BreakerTransition {
  readonly breaker: string;
  readonly from: BreakerState;
  readonly to: BreakerState;
  /** Failures in the window at the moment of the transition. */
  readonly failures: number;
}

export class Breaker {
  private state: BreakerState = 'closed';

  /**
   * Timestamps of failures inside the rolling window.
   *
   * An array of instants rather than a running counter: a counter cannot be
   * decremented as entries age out, so it would only ever be reset wholesale —
   * and a breaker that forgets every failure at a fixed interval can be held
   * open or closed indefinitely by traffic that happens to straddle the reset.
   */
  private failureTimes: number[] = [];

  private openedAt = 0;
  private probesAdmitted = 0;
  private probeSuccesses = 0;

  constructor(
    readonly name: string,
    private readonly config: BreakerConfig,
    private readonly now: () => number,
    private readonly onTransition: (transition: BreakerTransition) => void,
  ) {}

  get currentState(): BreakerState {
    return this.state;
  }

  /**
   * May a call proceed?
   *
   * Note this is also where `open -> half-open` happens. The transition is
   * driven by a call ARRIVING after the cool-down, not by a timer: a breaker
   * with no traffic has nothing to probe with, and a timer would move it to
   * half-open in the dark and then report a state no call ever tested.
   */
  tryAcquire(): BreakerAdmission {
    if (this.state === 'open' && this.now() - this.openedAt >= this.config.cooldownMs) {
      this.transition('half-open');
    }

    if (this.state === 'closed') {
      return { allowed: true, state: 'closed', probe: false };
    }

    if (this.state === 'open') {
      return { allowed: false, state: 'open', probe: false };
    }

    // Half-open: admit a bounded number of probes, then hold the rest back
    // until those outcomes land. Admitting everything would send the full load
    // at an upstream we have no evidence has recovered — which is how a
    // recovering service is knocked straight back over.
    if (this.probesAdmitted >= this.config.halfOpenProbes) {
      return { allowed: false, state: "half-open", probe: false };
    }

    this.probesAdmitted += 1;
    return { allowed: true, state: 'half-open', probe: true };
  }

  /** Report a call that this breaker admitted as successful. */
  recordSuccess(): void {
    if (this.state !== 'half-open') return;

    this.probeSuccesses += 1;
    if (this.probeSuccesses >= this.config.halfOpenProbes) {
      this.failureTimes = [];
      this.transition('closed');
    }
  }

  /** Report a call that this breaker admitted as an upstream failure. */
  recordFailure(): void {
    if (this.state === 'half-open') {
      // "if any fail, re-open" (§8.5) — one failed probe is enough. The
      // upstream was given its chance and did not take it; waiting for the
      // remaining probes would send more traffic at a dependency that has
      // just re-confirmed it is unhealthy.
      this.openBreaker();
      return;
    }

    if (this.state === 'open') return;

    const now = this.now();
    this.failureTimes.push(now);
    this.pruneWindow(now);

    if (this.failureTimes.length >= this.config.failureThreshold) {
      this.openBreaker();
    }
  }

  stats(): BreakerStats {
    // Prune on read so a breaker whose failures have all aged out reports 0
    // rather than a stale count. Reads are diagnostic, so this cannot change a
    // decision — it only stops the Explorer showing failures that no longer
    // count toward anything.
    this.pruneWindow(this.now());

    return {
      name: this.name,
      state: this.state,
      failures: this.failureTimes.length,
      failureThreshold: this.config.failureThreshold,
      halfOpenSuccesses: this.state === 'half-open' ? this.probeSuccesses : 0,
      halfOpenProbes: this.config.halfOpenProbes,
    };
  }

  private openBreaker(): void {
    this.openedAt = this.now();
    this.transition('open');
  }

  private pruneWindow(now: number): void {
    const cutoff = now - this.config.failureWindowMs;
    this.failureTimes = this.failureTimes.filter((at) => at > cutoff);
  }

  private transition(to: BreakerState): void {
    const from = this.state;
    if (from === to) return;

    this.state = to;

    // Probe bookkeeping belongs to a single half-open EPISODE, so it resets on
    // ENTRY into half-open — after the no-op guard above, so a redundant call
    // can never wipe the tally of an episode already in progress. Carrying it
    // across episodes would let three successes spread over three separate
    // recovery attempts, each followed by a failure, close a breaker that never
    // once passed a clean probe run.
    if (to === 'half-open') {
      this.probesAdmitted = 0;
      this.probeSuccesses = 0;
    }

    this.onTransition({ breaker: this.name, from, to, failures: this.failureTimes.length });
  }
}
