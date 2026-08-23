// SPDX-License-Identifier: Apache-2.0
/**
 * The `closed -> open -> half-open -> closed` machine (§8.5) — the pure half.
 *
 * `dispatcher-breaker.test.ts` proves the dispatcher acts on these states.
 * This proves the states themselves, at exact instants, using an injected
 * clock rather than sleeping — a cool-down test that waited 30 real seconds
 * would be skipped by whoever inherits it.
 */

import { describe, it, expect } from '@jest/globals';

import { Breaker, type BreakerTransition } from '../breaker.js';
import { BREAKER_STATE_VALUE } from '../types.js';
import type { BreakerConfig } from '../types.js';

const CONFIG: BreakerConfig = {
  failureThreshold: 3,
  failureWindowMs: 1_000,
  cooldownMs: 500,
  halfOpenProbes: 2,
};

/** A breaker over a clock the test moves by hand. */
function harness(overrides: Partial<BreakerConfig> = {}) {
  let clock = 10_000;
  const transitions: BreakerTransition[] = [];

  const breaker = new Breaker(
    'ordersApi',
    { ...CONFIG, ...overrides },
    () => clock,
    (t) => transitions.push(t),
  );

  return {
    breaker,
    transitions,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Drive n admitted failures. */
    fail: (n: number) => {
      for (let i = 0; i < n; i += 1) {
        breaker.tryAcquire();
        breaker.recordFailure();
      }
    },
  };
}

describe('closed -> open', () => {
  it('opens once the threshold is reached inside the window', () => {
    const h = harness();

    h.fail(2);
    expect(h.breaker.currentState).toBe('closed');

    h.fail(1);
    expect(h.breaker.currentState).toBe('open');
  });

  it('rejects calls while open, without admitting them', () => {
    const h = harness();
    h.fail(3);

    const admission = h.breaker.tryAcquire();

    expect(admission).toEqual({ allowed: false, state: 'open', probe: false });
  });

  it('does not open on failures that have aged out of the window', () => {
    // Two failures, then a gap longer than the window, then two more. Five
    // failures total, never three inside any 1s window — so a breaker using a
    // plain counter would open here and a windowed one must not.
    const h = harness();

    h.fail(2);
    h.advance(1_001);
    h.fail(2);

    expect(h.breaker.currentState).toBe('closed');
  });

  it('reports the live windowed failure count, not a running total', () => {
    const h = harness();

    h.fail(2);
    expect(h.breaker.stats().failures).toBe(2);

    h.advance(1_001);
    expect(h.breaker.stats().failures).toBe(0);
  });
});

describe('open -> half-open', () => {
  it('stays open until the cool-down has fully elapsed', () => {
    const h = harness();
    h.fail(3);

    h.advance(499);
    expect(h.breaker.tryAcquire().allowed).toBe(false);
    expect(h.breaker.currentState).toBe('open');
  });

  it('admits a probe once the cool-down elapses', () => {
    const h = harness();
    h.fail(3);

    h.advance(500);
    const admission = h.breaker.tryAcquire();

    expect(admission).toEqual({ allowed: true, state: 'half-open', probe: true });
  });

  it('admits no more than halfOpenProbes at once', () => {
    const h = harness();
    h.fail(3);
    h.advance(500);

    // Two probes configured: the third caller must be held back rather than
    // sent at an upstream we have no evidence has recovered.
    expect(h.breaker.tryAcquire().allowed).toBe(true);
    expect(h.breaker.tryAcquire().allowed).toBe(true);
    expect(h.breaker.tryAcquire().allowed).toBe(false);
  });
});

describe('half-open -> closed', () => {
  it('closes only after ALL probes succeed', () => {
    const h = harness();
    h.fail(3);
    h.advance(500);

    h.breaker.tryAcquire();
    h.breaker.recordSuccess();
    // One of two: not yet convinced.
    expect(h.breaker.currentState).toBe('half-open');

    h.breaker.tryAcquire();
    h.breaker.recordSuccess();
    expect(h.breaker.currentState).toBe('closed');
  });

  it('clears the failure window on close, so recovery starts from a clean slate', () => {
    // Otherwise the failures that opened the breaker are still inside the
    // window when it closes, and a single further failure re-opens it — a
    // breaker that can never actually recover.
    const h = harness();
    h.fail(3);
    h.advance(500);

    h.breaker.tryAcquire();
    h.breaker.recordSuccess();
    h.breaker.tryAcquire();
    h.breaker.recordSuccess();

    expect(h.breaker.stats().failures).toBe(0);

    h.fail(1);
    expect(h.breaker.currentState).toBe('closed');
  });
});

describe('half-open -> open', () => {
  /**
   * A window SHORTER than the cool-down, so the failures that opened the
   * breaker have aged out by the time a probe runs.
   *
   * This isolation is the whole point of the config override, and it was not
   * obvious: with the default 1s window and 500ms cool-down, the original
   * three failures are still inside the window when the probe fails, so the
   * ORDINARY threshold path re-opens the breaker and these tests pass whether
   * or not the half-open rule exists at all. Mutation testing caught exactly
   * that — deleting the half-open branch left them green.
   *
   * With the window aged out, the failure count is 0 before the probe, so
   * re-opening can only come from the half-open rule.
   */
  const ISOLATED = { failureWindowMs: 100, cooldownMs: 500 };

  it('re-opens on the FIRST failed probe, without waiting for the rest', () => {
    const h = harness(ISOLATED);
    h.fail(3);
    h.advance(500);

    // Pre-condition that makes the assertion below meaningful: no accumulated
    // failures remain, so the threshold path cannot fire.
    expect(h.breaker.stats().failures).toBe(0);

    h.breaker.tryAcquire();
    h.breaker.recordFailure();

    expect(h.breaker.currentState).toBe('open');
  });

  it('re-opens with a FRESH cool-down measured from the failed probe', () => {
    const h = harness(ISOLATED);
    h.fail(3);
    h.advance(500);

    h.breaker.tryAcquire();
    h.breaker.recordFailure();

    // 499ms after the re-open. If the cool-down had been measured from the
    // ORIGINAL opening it would have long since elapsed and this would admit.
    h.advance(499);
    expect(h.breaker.tryAcquire().allowed).toBe(false);

    h.advance(1);
    expect(h.breaker.tryAcquire().allowed).toBe(true);
  });

  it('starts each half-open episode with a fresh probe tally', () => {
    // A success in a failed episode must not count toward the next one.
    // Otherwise successes accumulate across attempts and the breaker closes
    // without ever completing one clean probe run.
    const h = harness(ISOLATED);
    h.fail(3);

    h.advance(500);
    h.breaker.tryAcquire();
    h.breaker.recordSuccess(); // 1 of 2 in episode A
    h.breaker.tryAcquire();
    h.breaker.recordFailure(); // episode A fails -> re-open

    h.advance(500);
    h.breaker.tryAcquire();
    h.breaker.recordSuccess(); // 1 of 2 in episode B

    // If the tally had carried over, this would already be closed.
    expect(h.breaker.currentState).toBe('half-open');
    expect(h.breaker.stats().halfOpenSuccesses).toBe(1);
  });
});

describe('transitions reported to the registry', () => {
  it('reports each change once, with old state, new state and failure count', () => {
    const h = harness();
    h.fail(3);
    h.advance(500);
    h.breaker.tryAcquire();
    h.breaker.recordSuccess();
    h.breaker.tryAcquire();
    h.breaker.recordSuccess();

    expect(h.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'closed->open',
      'open->half-open',
      'half-open->closed',
    ]);
    expect(h.transitions[0]?.failures).toBe(3);
    expect(h.transitions[0]?.breaker).toBe('ordersApi');
  });

  it('does not report a transition when nothing changed', () => {
    // Repeated rejections while open must not emit a stream of open->open
    // events; a state-change log that fires per rejected call is unreadable
    // during exactly the outage it exists to explain.
    const h = harness();
    h.fail(3);

    h.breaker.tryAcquire();
    h.breaker.tryAcquire();
    h.breaker.tryAcquire();

    expect(h.transitions.filter((t) => t.to === 'open')).toHaveLength(1);
  });
});

describe('numeric state encoding (§8.5 observability)', () => {
  it('orders states so that higher is worse', () => {
    // §8.5 requires numeric values rather than string labels. The ORDER
    // matters too: max() over an interval should mean "worst state reached",
    // which is the query an operator actually writes.
    expect(BREAKER_STATE_VALUE.closed).toBe(0);
    expect(BREAKER_STATE_VALUE['half-open']).toBe(1);
    expect(BREAKER_STATE_VALUE.open).toBe(2);
  });
});
