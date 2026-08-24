// SPDX-License-Identifier: Apache-2.0
/**
 * Statistics for the sizing harness (#197).
 *
 * This is the arithmetic half of `packages/gateway/bench/`, kept here in `src/`
 * — and therefore compiled, type-checked and unit-tested — while the harness
 * that spawns processes and drives sockets stays in `bench/` as plain scripts.
 *
 * The split is deliberate. The numbers this module produces are going to be
 * printed into `docs/reference-architecture.md`, where #197 says operators will
 * copy them into capacity plans. Percentile arithmetic that has never been
 * tested is exactly the kind of thing that is wrong by one index and never
 * noticed, because a plausible number looks identical to a correct one.
 *
 * WHY EXACT PERCENTILES AND NOT A HISTOGRAM
 * -----------------------------------------
 * The usual load-testing tool reaches for an HDR histogram. HDR exists to bound
 * MEMORY when the sample count is unbounded — it buys that bound by quantising
 * values into buckets, which costs a little accuracy. Our runs are bounded (a
 * few hundred thousand samples at most, each a `number`), so we can simply keep
 * every sample and sort. That is not a compromise against HDR; for this sample
 * size it is strictly more accurate.
 */

/** Nearest-rank percentile over an ALREADY SORTED ascending array. */
function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of an empty sample set');
  if (p <= 0) return sorted[0] as number;
  if (p >= 100) return sorted[sorted.length - 1] as number;

  // Nearest-rank: the smallest value at or below which at least p% of samples
  // fall. `ceil` then clamp — the clamp matters only for p extremely close to
  // 100, where ceil can land one past the end.
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] as number;
}

/** Latency distribution, in whatever unit the samples were given in. */
export interface LatencySummary {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

/**
 * Summarise raw latency samples.
 *
 * Copies before sorting: the caller's array is its own record of the run, and a
 * harness that silently reorders its inputs is a debugging trap.
 */
export function summarise(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) throw new Error('cannot summarise an empty sample set');
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((acc, v) => acc + v, 0);

  return {
    count: sorted.length,
    min: sorted[0] as number,
    p50: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
    max: sorted[sorted.length - 1] as number,
    mean: total / sorted.length,
  };
}

/** CPU consumed by the server process over one measurement window. */
export interface CpuDelta {
  /** `process.cpuUsage()` user time, in MICROseconds. */
  readonly userMicros: number;
  /** `process.cpuUsage()` system time, in MICROseconds. */
  readonly systemMicros: number;
  /** Wall-clock the window spanned, in MILLIseconds. */
  readonly wallMillis: number;
}

/**
 * The transferable part of the measurement.
 *
 * Raw QPS from one machine tells a reader on different hardware very little.
 * CPU-milliseconds PER CALL travels much better: it is a property of the work
 * the runtime does per request, so a reader can divide their own core budget by
 * it to get a first-order capacity estimate. That is the number #63 actually
 * needed, and the one this harness is built to produce.
 */
export interface DerivedCost {
  /** CPU (user+system) milliseconds attributable to one call. */
  readonly cpuMillisPerCall: number;
  /**
   * Cores' worth of CPU the process burned during the window.
   *
   * 1.0 means it saturated one core for the whole window. Node serves one event
   * loop per instance, so values approaching 1.0 mean the instance is at its
   * ceiling however much CPU the host still has idle — the single most
   * load-bearing fact in the whole sizing question.
   */
  readonly coresUsed: number;
  /** Calls actually completed per wall-clock second. */
  readonly throughputPerSecond: number;
}

export function deriveCost(cpu: CpuDelta, completedCalls: number): DerivedCost {
  if (completedCalls <= 0) throw new Error('cannot derive per-call cost from zero calls');
  if (cpu.wallMillis <= 0) throw new Error('cannot derive cost from a zero-length window');

  const cpuMillis = (cpu.userMicros + cpu.systemMicros) / 1000;

  return {
    cpuMillisPerCall: cpuMillis / completedCalls,
    coresUsed: cpuMillis / cpu.wallMillis,
    throughputPerSecond: (completedCalls / cpu.wallMillis) * 1000,
  };
}

/**
 * Least-squares fit of `rss = intercept + slope * operationCount`.
 *
 * `docs/reference-architecture.md` §2 asserts that memory is "dominated by the
 * compiled registry, which is a function of spec size, not of traffic". That is
 * a claim about a SLOPE, so measuring one spec cannot support it — you need
 * several sizes and a line through them. The slope is bytes-per-operation (the
 * part that grows with the spec) and the intercept is the fixed cost of a Node
 * process with the runtime loaded (the part that does not).
 *
 * `rSquared` is reported so a reader can see whether the relationship really is
 * linear rather than taking it on faith. A poor fit is itself a finding, and
 * printing it is what stops this from being a number that merely looks careful.
 */
export interface MemoryModel {
  readonly interceptBytes: number;
  readonly bytesPerOperation: number;
  readonly rSquared: number;
  readonly points: number;
}

export function fitMemoryModel(
  points: ReadonlyArray<{ readonly operationCount: number; readonly rssBytes: number }>,
): MemoryModel {
  if (points.length < 2) throw new Error('need at least two spec sizes to fit a memory model');

  const distinctX = new Set(points.map((p) => p.operationCount));
  if (distinctX.size < 2) throw new Error('need at least two DISTINCT spec sizes to fit a slope');

  const n = points.length;
  const meanX = points.reduce((a, p) => a + p.operationCount, 0) / n;
  const meanY = points.reduce((a, p) => a + p.rssBytes, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.operationCount - meanX) * (p.rssBytes - meanY);
    sxx += (p.operationCount - meanX) ** 2;
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    const predicted = intercept + slope * p.operationCount;
    ssRes += (p.rssBytes - predicted) ** 2;
    ssTot += (p.rssBytes - meanY) ** 2;
  }

  return {
    interceptBytes: intercept,
    bytesPerOperation: slope,
    // ssTot === 0 means every sample had identical RSS. The line is then
    // perfectly flat and explains everything there is to explain, so 1 is the
    // honest answer; 0/0 would surface as NaN in the published table.
    rSquared: ssTot === 0 ? 1 : 1 - ssRes / ssTot,
    points: n,
  };
}

/**
 * Server-side evidence that the GATEWAY, not the harness, was the limit.
 *
 * This is the primary certification, and the headroom check below is secondary.
 * The reasoning is worth stating because it inverts the usual order.
 *
 * A driver-side ratio can only ever argue that the harness had capacity spare.
 * These three facts, read together, are direct evidence about the server, and
 * they come from inside the gateway process where the driver cannot reach:
 *
 *   1. Throughput stops rising as connections increase.
 *   2. CPU stops rising with it, at a plateau near one core — the ceiling a
 *      single event loop has.
 *   3. Latency keeps rising roughly in proportion to connections.
 *
 * Together those are queueing against a fixed service rate, which is what
 * saturation IS. A run limited by the driver would not look like this: adding
 * connections would buy throughput, and the gateway's own CPU would sag rather
 * than plateau.
 *
 * Note this is something an off-the-shelf load generator cannot tell you. It
 * measures the client side by construction; fact 2 is only observable from the
 * server process. That is why the harness measures it.
 */
export interface SaturationEvidence {
  readonly peakThroughputPerSecond: number;
  /** Levels considered to be on the plateau (throughput within tolerance of peak). */
  readonly plateauConnections: readonly number[];
  /** Relative spread of throughput across the plateau. Small means flat. */
  readonly throughputSpread: number;
  /** Relative spread of CPU across the plateau. Small means pegged. */
  readonly cpuSpread: number;
  /** Median cores used across the plateau. */
  readonly cpuPlateauCores: number;
  /** How much p50 latency grew from the first plateau level to the last. */
  readonly latencyGrowthFactor: number;
  /** How much concurrency grew over the same span. */
  readonly connectionGrowthFactor: number;
  readonly saturated: boolean;
  readonly reason: string;
}

export interface SaturationLevel {
  readonly connections: number;
  readonly throughputPerSecond: number;
  readonly coresUsed: number;
  readonly p50Millis: number;
}

export function assessSaturation(
  levels: readonly SaturationLevel[],
  { throughputTolerance = 0.05, cpuTolerance = 0.1, minimumPlateauLevels = 3 } = {},
): SaturationEvidence {
  if (levels.length === 0) throw new Error('cannot assess saturation with no levels');

  const peak = Math.max(...levels.map((l) => l.throughputPerSecond));
  const plateau = levels.filter((l) => l.throughputPerSecond >= peak * (1 - throughputTolerance));

  const spread = (values: readonly number[]) => {
    const max = Math.max(...values);
    const min = Math.min(...values);
    return max === 0 ? 0 : (max - min) / max;
  };

  const throughputSpread = spread(plateau.map((l) => l.throughputPerSecond));
  const cpuValues = plateau.map((l) => l.coresUsed);
  const cpuSpread = spread(cpuValues);
  const sortedCpu = [...cpuValues].sort((a, b) => a - b);
  const cpuPlateauCores = sortedCpu[Math.floor(sortedCpu.length / 2)] ?? 0;

  const first = plateau[0];
  const last = plateau[plateau.length - 1];
  const latencyGrowthFactor = first && last && first.p50Millis > 0 ? last.p50Millis / first.p50Millis : 0;
  const connectionGrowthFactor = first && last && first.connections > 0 ? last.connections / first.connections : 0;

  const enoughLevels = plateau.length >= minimumPlateauLevels;
  const cpuPegged = cpuSpread <= cpuTolerance;
  // Latency must grow with concurrency, and at a rate that indicates queueing
  // rather than noise. Half the connection growth is a deliberately loose bar:
  // perfect proportionality is not required, a clear trend is.
  const queueing = latencyGrowthFactor >= Math.max(2, connectionGrowthFactor * 0.5);

  const saturated = enoughLevels && cpuPegged && queueing;

  const reason = saturated
    ? `throughput flat within ${(throughputSpread * 100).toFixed(1)}% across ${plateau.length} levels ` +
      `while CPU held at ${cpuPlateauCores.toFixed(2)} cores (spread ${(cpuSpread * 100).toFixed(1)}%) ` +
      `and p50 grew ${latencyGrowthFactor.toFixed(1)}× over a ${connectionGrowthFactor.toFixed(0)}× ` +
      `rise in concurrency`
    : !enoughLevels
      ? `only ${plateau.length} level(s) on the throughput plateau; need ${minimumPlateauLevels}`
      : !cpuPegged
        ? `CPU varied ${(cpuSpread * 100).toFixed(1)}% across the plateau, so the gateway was not pegged`
        : `p50 grew only ${latencyGrowthFactor.toFixed(1)}× over a ${connectionGrowthFactor.toFixed(0)}× ` +
          `rise in concurrency, which is not the queueing signature of a saturated server`;

  return {
    peakThroughputPerSecond: peak,
    plateauConnections: plateau.map((l) => l.connections),
    throughputSpread,
    cpuSpread,
    cpuPlateauCores,
    latencyGrowthFactor,
    connectionGrowthFactor,
    saturated,
    reason,
  };
}

/**
 * Corroborating check: how much faster the harness goes against nothing.
 *
 * The harness drives a trivial no-op server and compares. If it can push far
 * more requests per second at nothing-in-particular than it managed against the
 * gateway, it had capacity spare and was not the limiting factor.
 *
 * WHAT THIS RATIO IS NOT
 * ----------------------
 * It is a LOWER BOUND on the driver's ceiling, not the ceiling itself. The
 * calibration target is also a single-threaded Node server, so the number
 * measured is the pair's throughput — `min(driver, null server)` — and the
 * driver alone could be faster. Isolating it properly would need several null
 * servers sharing a port, and `reusePort` is unsupported on this platform
 * (verified: `listen ENOTSUP` on darwin/Node 25).
 *
 * A conservative bound is still useful, but it means a FAILING ratio says "not
 * proven from this side" rather than "contaminated". That asymmetry is why
 * `assessSaturation` above is the primary evidence and this is the second
 * opinion — and why `certify` treats either as sufficient.
 */
export interface DriverHeadroom {
  readonly driverCeilingPerSecond: number;
  readonly measuredPerSecond: number;
  readonly ratio: number;
  readonly sufficient: boolean;
}

/**
 * @param minimumRatio How much faster the driver must be than the result it is
 * certifying. 10x is the default: at that point the driver contributes under
 * 10% of observed time, so it cannot move a percentile by more than noise.
 */
export function assessHeadroom(
  driverCeilingPerSecond: number,
  measuredPerSecond: number,
  minimumRatio = 10,
): DriverHeadroom {
  if (measuredPerSecond <= 0) throw new Error('cannot assess headroom against zero throughput');
  const ratio = driverCeilingPerSecond / measuredPerSecond;
  return {
    driverCeilingPerSecond,
    measuredPerSecond,
    ratio,
    sufficient: ratio >= minimumRatio,
  };
}

/**
 * May these numbers be published?
 *
 * EITHER line of evidence is sufficient, because they are independent and each
 * rules out the failure mode that matters — that the harness, not the gateway,
 * set the ceiling:
 *
 *   - Saturation is measured INSIDE the gateway process. If its CPU is pegged
 *     at a plateau while throughput is flat and latency queues, the gateway was
 *     the limit. No fact about the driver can undo that.
 *   - Headroom is measured from outside. If the harness demonstrably runs many
 *     times faster against a null server, it had capacity to spare.
 *
 * Requiring BOTH would be stricter without being more correct: it would reject
 * a run whose SUT was provably pegged merely because the conservative,
 * platform-limited driver bound could not also be cleared.
 *
 * Requiring NEITHER is the thing this function exists to prevent. A run that
 * can show no evidence either way is inconclusive, and inconclusive numbers
 * must not reach a document operators size capacity from — that is the whole
 * premise of #197.
 */
export interface Certification {
  readonly publishable: boolean;
  readonly grounds: 'saturation' | 'driver-headroom' | 'both' | 'none';
  readonly explanation: string;
}

export function certify(
  saturation: SaturationEvidence,
  headroom: DriverHeadroom,
): Certification {
  const grounds =
    saturation.saturated && headroom.sufficient
      ? 'both'
      : saturation.saturated
        ? 'saturation'
        : headroom.sufficient
          ? 'driver-headroom'
          : 'none';

  const explanation =
    grounds === 'none'
      ? `Neither line of evidence holds. Saturation: ${saturation.reason}. ` +
        `Driver headroom: ${headroom.ratio.toFixed(2)}× (needs 10×).`
      : `Server-side saturation: ${saturation.saturated ? `YES — ${saturation.reason}` : `no (${saturation.reason})`}. ` +
        `Driver headroom: ${headroom.ratio.toFixed(2)}× against a null server ` +
        `(${headroom.sufficient ? 'clears' : 'below'} the 10× bar; this bound is conservative).`;

  return { publishable: grounds !== 'none', grounds, explanation };
}
