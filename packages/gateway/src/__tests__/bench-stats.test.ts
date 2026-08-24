// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the sizing harness's arithmetic and its publish gate (#197).
 *
 * These matter more than their size suggests. The numbers this module produces
 * are printed into `docs/reference-architecture.md`, where #197 says operators
 * copy them into capacity plans — and a percentile that is wrong by one index
 * looks exactly like one that is right.
 *
 * The gate is tested hardest. `certify` is what stands between an inconclusive
 * run and a published table, so the cases below include the ones where it must
 * REFUSE, not only the ones where it agrees.
 */

import { describe, it, expect } from '@jest/globals';

import {
  summarise,
  deriveCost,
  fitMemoryModel,
  assessHeadroom,
  assessSaturation,
  certify,
  type SaturationLevel,
} from '../bench/stats.js';

describe('summarise', () => {
  it('reports nearest-rank percentiles rather than interpolating', () => {
    // 1..100, so the nearest-rank answer for each percentile is exactly the
    // value with that number. Interpolation would give 50.5 for p50 here, so
    // this distinguishes the two definitions rather than merely exercising one.
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);

    const result = summarise(samples);

    expect(result.p50).toBe(50);
    expect(result.p95).toBe(95);
    expect(result.p99).toBe(99);
    expect(result.min).toBe(1);
    expect(result.max).toBe(100);
    expect(result.count).toBe(100);
    expect(result.mean).toBeCloseTo(50.5, 10);
  });

  it('does not reorder the caller’s array', () => {
    const samples = [5, 1, 4, 2, 3];

    summarise(samples);

    expect(samples).toEqual([5, 1, 4, 2, 3]);
  });

  it('handles a single sample without running off the end', () => {
    const result = summarise([7]);

    expect(result.p50).toBe(7);
    expect(result.p99).toBe(7);
    expect(result.max).toBe(7);
  });

  it('refuses an empty sample set rather than reporting NaN', () => {
    expect(() => summarise([])).toThrow(/empty/);
  });
});

describe('deriveCost', () => {
  it('converts CPU microseconds and a call count into per-call milliseconds', () => {
    // 2,000,000µs = 2000ms of CPU over 10,000 calls = 0.2 CPU-ms per call,
    // burned over a 1000ms window = 2 cores' worth.
    const cost = deriveCost({ userMicros: 1_500_000, systemMicros: 500_000, wallMillis: 1000 }, 10_000);

    expect(cost.cpuMillisPerCall).toBeCloseTo(0.2, 10);
    expect(cost.coresUsed).toBeCloseTo(2, 10);
    expect(cost.throughputPerSecond).toBeCloseTo(10_000, 10);
  });

  it('refuses to divide by zero calls', () => {
    expect(() => deriveCost({ userMicros: 1, systemMicros: 1, wallMillis: 1 }, 0)).toThrow(/zero calls/);
  });

  it('refuses a zero-length window', () => {
    expect(() => deriveCost({ userMicros: 1, systemMicros: 1, wallMillis: 0 }, 10)).toThrow(/zero-length/);
  });
});

describe('fitMemoryModel', () => {
  it('recovers the slope and intercept of an exactly linear relationship', () => {
    // rss = 50MiB + 1KiB per operation, exactly.
    const base = 50 * 1024 * 1024;
    const points = [10, 100, 500].map((operationCount) => ({
      operationCount,
      rssBytes: base + operationCount * 1024,
    }));

    const model = fitMemoryModel(points);

    expect(model.bytesPerOperation).toBeCloseTo(1024, 6);
    expect(model.interceptBytes).toBeCloseTo(base, 0);
    expect(model.rSquared).toBeCloseTo(1, 10);
  });

  it('reports a poor fit as a low R² instead of hiding it', () => {
    // Deliberately non-linear: a reader must be able to see the line does not
    // describe these points, because publishing the slope anyway is exactly the
    // failure #197 is about.
    const points = [
      { operationCount: 1, rssBytes: 100 },
      { operationCount: 2, rssBytes: 5000 },
      { operationCount: 3, rssBytes: 120 },
      { operationCount: 4, rssBytes: 5200 },
    ];

    const model = fitMemoryModel(points);

    expect(model.rSquared).toBeLessThan(0.5);
  });

  it('refuses to fit a slope through a single distinct spec size', () => {
    // Two points at the SAME x would divide by zero and yield Infinity, which
    // would render in the table as a plausible-looking number.
    expect(() =>
      fitMemoryModel([
        { operationCount: 100, rssBytes: 10 },
        { operationCount: 100, rssBytes: 20 },
      ]),
    ).toThrow(/DISTINCT/);
  });

  it('refuses fewer than two points', () => {
    expect(() => fitMemoryModel([{ operationCount: 1, rssBytes: 1 }])).toThrow(/at least two/);
  });
});

describe('assessHeadroom', () => {
  it('clears the bar when the driver is far faster than the measurement', () => {
    expect(assessHeadroom(120_000, 10_000).sufficient).toBe(true);
  });

  it('fails when the driver is close to the measurement', () => {
    const headroom = assessHeadroom(15_000, 10_000);

    expect(headroom.ratio).toBeCloseTo(1.5, 10);
    expect(headroom.sufficient).toBe(false);
  });
});

/** A saturated server: throughput flat, CPU pegged, latency queueing. */
const SATURATED: SaturationLevel[] = [
  { connections: 1, throughputPerSecond: 8000, coresUsed: 0.89, p50Millis: 0.11 },
  { connections: 8, throughputPerSecond: 14_900, coresUsed: 1.31, p50Millis: 0.46 },
  { connections: 16, throughputPerSecond: 14_840, coresUsed: 1.33, p50Millis: 0.93 },
  { connections: 32, throughputPerSecond: 14_905, coresUsed: 1.33, p50Millis: 1.89 },
  { connections: 64, throughputPerSecond: 14_386, coresUsed: 1.32, p50Millis: 3.87 },
];

describe('assessSaturation', () => {
  it('recognises the queueing signature of a saturated server', () => {
    const evidence = assessSaturation(SATURATED);

    expect(evidence.saturated).toBe(true);
    // The 1-connection level is well below peak, so it must NOT be counted as
    // part of the plateau — including it would make the CPU spread look large.
    expect(evidence.plateauConnections).not.toContain(1);
    expect(evidence.cpuPlateauCores).toBeCloseTo(1.33, 2);
  });

  it('refuses when throughput is still climbing', () => {
    // A driver-limited run: more connections keep buying throughput, so there
    // is no plateau to speak of.
    const climbing: SaturationLevel[] = [
      { connections: 1, throughputPerSecond: 1000, coresUsed: 0.2, p50Millis: 1 },
      { connections: 8, throughputPerSecond: 8000, coresUsed: 0.5, p50Millis: 1 },
      { connections: 64, throughputPerSecond: 60_000, coresUsed: 0.9, p50Millis: 1.1 },
    ];

    const evidence = assessSaturation(climbing);

    expect(evidence.saturated).toBe(false);
    expect(evidence.reason).toMatch(/plateau/);
  });

  it('refuses when latency does not grow with concurrency', () => {
    // Flat throughput AND flat latency is not saturation — it is a fixed-rate
    // limiter somewhere, and the CPU numbers would not describe a ceiling.
    const limited: SaturationLevel[] = [
      { connections: 8, throughputPerSecond: 10_000, coresUsed: 0.5, p50Millis: 1 },
      { connections: 16, throughputPerSecond: 10_000, coresUsed: 0.5, p50Millis: 1 },
      { connections: 32, throughputPerSecond: 10_000, coresUsed: 0.5, p50Millis: 1 },
      { connections: 64, throughputPerSecond: 10_000, coresUsed: 0.5, p50Millis: 1 },
    ];

    const evidence = assessSaturation(limited);

    expect(evidence.saturated).toBe(false);
    expect(evidence.reason).toMatch(/queueing signature/);
  });

  it('refuses when CPU varies across the plateau', () => {
    // Throughput flat and latency queueing, but the gateway's own CPU swings —
    // so it was not pegged, and something else set the rate.
    const wobbly: SaturationLevel[] = [
      { connections: 8, throughputPerSecond: 10_000, coresUsed: 0.4, p50Millis: 1 },
      { connections: 16, throughputPerSecond: 10_000, coresUsed: 0.9, p50Millis: 2 },
      { connections: 32, throughputPerSecond: 10_000, coresUsed: 1.3, p50Millis: 4 },
    ];

    const evidence = assessSaturation(wobbly);

    expect(evidence.saturated).toBe(false);
    expect(evidence.reason).toMatch(/not pegged/);
  });
});

describe('certify', () => {
  it('publishes on server-side saturation even when the driver bound is not cleared', () => {
    // This is the real case from the M4 run: the gateway was provably pegged,
    // while the conservative driver bound sat at ~8x. Requiring both would
    // reject a run whose SUT was demonstrably the bottleneck.
    const result = certify(assessSaturation(SATURATED), assessHeadroom(121_034, 14_925));

    expect(result.publishable).toBe(true);
    expect(result.grounds).toBe('saturation');
  });

  it('publishes on driver headroom alone when the server never saturated', () => {
    const unsaturated = assessSaturation([
      { connections: 1, throughputPerSecond: 1000, coresUsed: 0.2, p50Millis: 1 },
      { connections: 8, throughputPerSecond: 8000, coresUsed: 0.5, p50Millis: 1 },
    ]);

    const result = certify(unsaturated, assessHeadroom(500_000, 8000));

    expect(result.publishable).toBe(true);
    expect(result.grounds).toBe('driver-headroom');
  });

  it('REFUSES when neither line of evidence holds', () => {
    // The case the gate exists for. Throughput still climbing and the driver
    // only 1.5x faster than the result: nothing here shows the gateway was the
    // limit, so nothing may be published.
    const unsaturated = assessSaturation([
      { connections: 1, throughputPerSecond: 1000, coresUsed: 0.2, p50Millis: 1 },
      { connections: 8, throughputPerSecond: 8000, coresUsed: 0.5, p50Millis: 1 },
    ]);

    const result = certify(unsaturated, assessHeadroom(12_000, 8000));

    expect(result.publishable).toBe(false);
    expect(result.grounds).toBe('none');
    expect(result.explanation).toMatch(/Neither/);
  });

  it('reports both grounds when both hold', () => {
    const result = certify(assessSaturation(SATURATED), assessHeadroom(1_000_000, 14_925));

    expect(result.grounds).toBe('both');
    expect(result.publishable).toBe(true);
  });
});
