#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The sizing harness (#197).
 *
 * Produces the measurements behind `docs/reference-architecture.md` §2, which
 * before this shipped a caveat where a table should be because no load data
 * existed. See `bench/README.md` for the dependency decision and the method.
 *
 * Three measurements, because the sizing question has three parts:
 *
 *   1. CALIBRATION — how fast can the driver go against a server that does
 *      nothing? Everything else is only meaningful below this ceiling.
 *   2. THROUGHPUT SWEEP — at each concurrency level: achieved QPS, latency
 *      percentiles, and the gateway process's own CPU. Yields CPU-ms per call.
 *   3. MEMORY MODEL — RSS across several spec sizes, fitted to a line, plus a
 *      check of whether traffic moves RSS at all.
 *
 * Usage:
 *   node packages/gateway/bench/run.mjs [--quick] [--out results.json]
 *
 * Requires a build first: `npx tsc -b`. The harness runs `dist/`, not `src/`,
 * so the numbers describe the code an operator would actually deploy.
 */

import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { driveParallel, toolCallBody } from './driver.mjs';
import { startUpstream, startNullServer } from './upstream.mjs';
import { syntheticSpec, syntheticToolName } from './spec.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUT = join(__dirname, 'sut.mjs');
const PETSTORE = join(__dirname, '../../sources-openapi/src/__tests__/fixtures/petstore.json');

const { summarise, deriveCost, fitMemoryModel, assessHeadroom, assessSaturation, certify } =
  await import(join(__dirname, '../dist/bench/stats.js'));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};

const QUICK = flag('--quick');
const DURATION_MS = Number(value('--duration-ms', QUICK ? 1500 : 5000));
const WARMUP_MS = Number(value('--warmup-ms', QUICK ? 750 : 2000));
const UPSTREAM_DELAY_MS = Number(value('--upstream-delay-ms', 0));
const CONNECTIONS = String(value('--connections', QUICK ? '1,4,16' : '1,2,4,8,16,32,64'))
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const SPEC_SIZES = String(value('--spec-sizes', QUICK ? '10,100,400' : '10,50,100,250,500,1000'))
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const OUT = value('--out', null);

// ---------------------------------------------------------------------------
// SUT lifecycle
// ---------------------------------------------------------------------------

/**
 * Start one gateway in its own process.
 *
 * `--expose-gc` so RSS can be read after a collection: without it the reading
 * includes whatever garbage V8 has not got round to, which for a memory MODEL
 * is noise that would show up as a worse fit.
 */
async function startSut({ spec, upstream, audit }) {
  const child = fork(SUT, [JSON.stringify({ spec, upstream, audit })], {
    execArgv: ['--expose-gc'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const ready = await new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type === 'ready') {
        child.off('message', onMessage);
        resolve(message);
      } else if (message?.type === 'error') {
        child.off('message', onMessage);
        reject(new Error(message.message));
      }
    };
    child.on('message', onMessage);
    child.on('exit', (code) =>
      reject(new Error(`gateway process exited with ${code} before becoming ready. ${stderr}`)),
    );
  });

  let nextId = 0;
  const request = (type) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const onMessage = (message) => {
        if (message?.id !== id) return;
        child.off('message', onMessage);
        if (message.type === 'error') reject(new Error(message.message));
        else resolve(message);
      };
      child.on('message', onMessage);
      child.send({ type, id });
    });

  return {
    port: ready.port,
    operationCount: ready.operationCount,
    gcExposed: ready.gcExposed,
    nodeVersion: ready.nodeVersion,
    bootSample: ready.sample,
    sample: async () => (await request('sample')).sample,
    stop: async () => {
      try {
        await request('stop');
      } catch {
        // A gateway that has already exited is stopped, which is the goal.
      }
      child.kill();
    },
  };
}

/** CPU/wall delta between two samples, in the shape `deriveCost` wants. */
const delta = (before, after) => ({
  userMicros: after.userMicros - before.userMicros,
  systemMicros: after.systemMicros - before.systemMicros,
  wallMillis: after.wallMillis - before.wallMillis,
});

// ---------------------------------------------------------------------------
// 1. Calibration
// ---------------------------------------------------------------------------

/**
 * How fast can the driver go when the server is not the limit?
 *
 * This is the number that makes a hand-written driver defensible. It is run at
 * the highest concurrency in the sweep, because that is where a driver is most
 * likely to be the bottleneck.
 */
async function calibrate() {
  const nullServer = await startNullServer();
  try {
    const connections = Math.max(...CONNECTIONS);
    // Warm the driver's own JIT before timing it, for the same reason the
    // gateway gets a warmup: a first-run number measures compilation.
    await driveParallel({
      port: nullServer.port,
      connections,
      durationMillis: WARMUP_MS,
      body: toolCallBody('noop'),
    });
    const result = await driveParallel({
      port: nullServer.port,
      connections,
      durationMillis: DURATION_MS,
      body: toolCallBody('noop'),
    });

    return {
      connections,
      workers: result.workers,
      perSecond: (result.completed / result.wallMillis) * 1000,
      latency: summarise(result.latencies),
      errors: result.errors.length,
    };
  } finally {
    await nullServer.close();
  }
}

// ---------------------------------------------------------------------------
// 2. Throughput sweep
// ---------------------------------------------------------------------------

/**
 * Sweep concurrency against one warm gateway.
 *
 * One process for the whole sweep, deliberately: a production instance is warm,
 * and restarting per level would fold JIT compilation into whichever level ran
 * first. Warmup happens once, before the first measured level.
 */
async function throughputSweep({ upstreamUrl, auditLabel, audit, connectionLevels = CONNECTIONS }) {
  const sut = await startSut({ spec: PETSTORE, upstream: upstreamUrl, audit });
  try {
    const body = toolCallBody('listPets');

    // Warmup is unmeasured on purpose. Its only job is to get V8 past the
    // interpreter for the code paths about to be timed.
    await driveParallel({
      port: sut.port,
      connections: Math.max(...connectionLevels),
      durationMillis: WARMUP_MS,
      body,
    });

    const levels = [];
    for (const connections of connectionLevels) {
      const before = await sut.sample();
      const result = await driveParallel({ port: sut.port, connections, durationMillis: DURATION_MS, body });
      const after = await sut.sample();

      if (result.completed === 0) {
        levels.push({ connections, failed: true, errors: result.errors.slice(0, 3) });
        continue;
      }

      const cpu = delta(before, after);
      levels.push({
        connections,
        driverWorkers: result.workers,
        latencyMillis: summarise(result.latencies),
        cost: deriveCost(cpu, result.completed),
        completed: result.completed,
        errors: result.errors.length,
        statusCounts: result.statusCounts,
        rssBytesAfter: after.rssBytes,
      });
    }

    return {
      auditLabel,
      operationCount: sut.operationCount,
      gcExposed: sut.gcExposed,
      levels,
      rssAtRest: sut.bootSample.rssBytes,
    };
  } finally {
    await sut.stop();
  }
}

// ---------------------------------------------------------------------------
// 3. Memory model
// ---------------------------------------------------------------------------

/**
 * RSS across spec sizes, plus whether traffic moves it.
 *
 * The second half matters as much as the first. §2 claims memory is a function
 * of spec size "not of traffic" — so the harness drives a short burst at each
 * size and reports RSS before and after. If traffic moved RSS materially, the
 * claim in the document would be wrong, and this is what would show it.
 */
async function memoryModel({ upstreamUrl, workDir }) {
  const points = [];

  for (const operationCount of SPEC_SIZES) {
    const specPath = join(workDir, `synthetic-${operationCount}.json`);
    await writeFile(specPath, JSON.stringify(syntheticSpec(operationCount, upstreamUrl)), 'utf8');
    const specBytes = (await stat(specPath)).size;

    const sut = await startSut({ spec: specPath, upstream: upstreamUrl, audit: { sink: 'none' } });
    try {
      const atRest = await sut.sample();
      await driveParallel({
        port: sut.port,
        connections: 8,
        durationMillis: Math.min(DURATION_MS, 2000),
        body: toolCallBody(syntheticToolName(0), { resourceId: '1' }),
      });
      const underLoad = await sut.sample();

      // Sample again after the connections have closed and V8 has had an idle
      // moment. This separates two very different findings: memory that is
      // transient garbage (would fall back) from memory the process keeps
      // (would not). A memory LIMIT has to accommodate whichever is larger, so
      // the distinction decides what the sizing guidance can honestly say.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const settled = await sut.sample();

      points.push({
        operationCount: sut.operationCount,
        requestedOperationCount: operationCount,
        specBytes,
        rssBytes: atRest.rssBytes,
        rssBytesUnderLoad: underLoad.rssBytes,
        rssBytesSettled: settled.rssBytes,
      });
    } finally {
      await sut.stop();
    }
  }

  // Also measure the real fixture, so the report can show where a hand-written
  // spec sits relative to the synthetic line rather than assuming they agree.
  const petstoreSut = await startSut({ spec: PETSTORE, upstream: upstreamUrl, audit: { sink: 'none' } });
  let petstore;
  try {
    const atRest = await petstoreSut.sample();
    petstore = {
      operationCount: petstoreSut.operationCount,
      specBytes: (await stat(PETSTORE)).size,
      rssBytes: atRest.rssBytes,
    };
  } finally {
    await petstoreSut.stop();
  }

  const model = fitMemoryModel(points);

  /**
   * How the two contributors compare.
   *
   * §2 says memory is a function of spec size "not of traffic". Measuring both
   * turns that into a crossover rather than an absolute: below some operation
   * count the fixed cost of serving traffic is the larger term, above it the
   * spec is. Expressing the traffic delta in "operations' worth" makes the two
   * directly comparable in the unit the reader is already sizing in.
   */
  const deltas = points.map((p) => p.rssBytesSettled - p.rssBytes).sort((a, b) => a - b);
  const medianDeltaBytes = deltas[Math.floor(deltas.length / 2)] ?? 0;

  return {
    points,
    petstore,
    model,
    traffic: {
      medianDeltaBytes,
      equivalentOperations:
        model.bytesPerOperation > 0 ? medianDeltaBytes / model.bytesPerOperation : Infinity,
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const mib = (bytes) => bytes / 1024 / 1024;
const round = (n, dp = 2) => Number(n.toFixed(dp));

function renderMarkdown(report) {
  const lines = [];
  const { environment: env, calibration, sweep, memory, auditDelta } = report;

  lines.push('### Measured throughput and CPU');
  lines.push('');
  lines.push('| Connections | Achieved QPS | p50 ms | p95 ms | p99 ms | CPU-ms/call | Cores used |');
  lines.push('|---:|---:|---:|---:|---:|---:|---:|');
  for (const level of sweep.levels) {
    if (level.failed) {
      lines.push(`| ${level.connections} | — | — | — | — | — | run failed |`);
      continue;
    }
    lines.push(
      `| ${level.connections} | ${Math.round(level.cost.throughputPerSecond)} | ` +
        `${round(level.latencyMillis.p50)} | ${round(level.latencyMillis.p95)} | ` +
        `${round(level.latencyMillis.p99)} | ${round(level.cost.cpuMillisPerCall, 3)} | ` +
        `${round(level.cost.coresUsed)} |`,
    );
  }
  lines.push('');
  lines.push('### Measured memory by spec size');
  lines.push('');
  lines.push('| Operations | Spec on disk | RSS at rest | RSS after traffic | RSS once idle | Retained |');
  lines.push('|---:|---:|---:|---:|---:|---:|');
  for (const p of memory.points) {
    lines.push(
      `| ${p.operationCount} | ${round(p.specBytes / 1024)} KiB | ${round(mib(p.rssBytes))} MiB | ` +
        `${round(mib(p.rssBytesUnderLoad))} MiB | ${round(mib(p.rssBytesSettled))} MiB | ` +
        `+${round(mib(p.rssBytesSettled - p.rssBytes))} MiB |`,
    );
  }
  lines.push('');
  lines.push(
    `Fitted (at rest): RSS ≈ ${round(mib(memory.model.interceptBytes))} MiB + ` +
      `${round(memory.model.bytesPerOperation / 1024)} KiB × operations ` +
      `(R² = ${round(memory.model.rSquared, 4)}, ${memory.model.points} points).`,
  );
  lines.push(
    `Petstore fixture (${memory.petstore.operationCount} operations, ` +
      `${round(memory.petstore.specBytes / 1024)} KiB on disk): ` +
      `${round(mib(memory.petstore.rssBytes))} MiB at rest.`,
  );
  lines.push(
    `Memory RETAINED after traffic stops: ${round(mib(memory.traffic.medianDeltaBytes))} MiB ` +
      `(median across sizes) — equivalent to ${Math.round(memory.traffic.equivalentOperations)} ` +
      `operations' worth of spec. Spec size only becomes the larger term above roughly that ` +
      `many operations.`,
  );
  lines.push('');
  lines.push(
    `Environment: ${env.cpuModel}, ${env.cpuCount} cores, ${round(mib(env.totalMemoryBytes) / 1024)} GiB RAM, ` +
      `Node ${env.nodeVersion}, measured ${env.measuredAt}.`,
  );
  lines.push(
    `Certification: ${report.certification.publishable ? 'PUBLISHABLE' : 'INCONCLUSIVE'} ` +
      `(grounds: ${report.certification.grounds}). ${report.certification.explanation}`,
  );
  lines.push(
    `Driver ceiling: ${round(calibration.perSecond)} QPS against a null server ` +
      `(${calibration.workers} driver processes) versus ${round(report.peakThroughput)} QPS peak measured.`,
  );
  if (auditDelta) {
    lines.push(
      `Audit sink cost at ${auditDelta.connections} connections: ` +
        `${round(auditDelta.noneCpuMillisPerCall, 3)} CPU-ms/call with the sink off versus ` +
        `${round(auditDelta.jsonlCpuMillisPerCall, 3)} with JSONL — ` +
        `${round(auditDelta.overheadPercent, 1)}% more CPU per call.`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const workDir = await mkdtemp(join(tmpdir(), 'gateway-bench-'));
const upstream = await startUpstream({ delayMillis: UPSTREAM_DELAY_MS });

try {
  process.stderr.write('calibrating driver against a null server…\n');
  const calibration = await calibrate();

  process.stderr.write('sweeping concurrency (audit sink off)…\n');
  const sweep = await throughputSweep({
    upstreamUrl: upstream.url,
    auditLabel: 'none',
    audit: { sink: 'none' },
  });

  // One concurrency level, not a second full sweep: the question is what the
  // sink costs per call, and that is a ratio at a comparable operating point.
  process.stderr.write('measuring audit sink overhead…\n');
  const auditConnections = CONNECTIONS[Math.floor(CONNECTIONS.length / 2)];
  const auditSweep = await throughputSweep({
    upstreamUrl: upstream.url,
    auditLabel: 'jsonl',
    audit: { sink: 'jsonl', path: join(workDir, 'audit.jsonl') },
    connectionLevels: [auditConnections],
  });

  process.stderr.write('measuring memory across spec sizes…\n');
  const memory = await memoryModel({ upstreamUrl: upstream.url, workDir });

  const ok = sweep.levels.filter((l) => !l.failed);
  if (ok.length === 0) throw new Error('every concurrency level failed; nothing to report');
  const peakThroughput = Math.max(...ok.map((l) => l.cost.throughputPerSecond));

  const saturation = assessSaturation(
    ok.map((l) => ({
      connections: l.connections,
      throughputPerSecond: l.cost.throughputPerSecond,
      coresUsed: l.cost.coresUsed,
      p50Millis: l.latencyMillis.p50,
    })),
  );
  const headroom = assessHeadroom(calibration.perSecond, peakThroughput);

  const pick = (levels, connections) =>
    levels.find((l) => l.connections === connections && !l.failed) ?? null;
  const noneAt = pick(sweep.levels, auditConnections);
  const jsonlAt = pick(auditSweep.levels, auditConnections);

  const report = {
    issue: 197,
    environment: {
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      platform: `${process.platform}/${process.arch}`,
      nodeVersion: process.version,
      measuredAt: new Date().toISOString(),
    },
    parameters: {
      durationMillis: DURATION_MS,
      warmupMillis: WARMUP_MS,
      connections: CONNECTIONS,
      specSizes: SPEC_SIZES,
      upstreamDelayMillis: UPSTREAM_DELAY_MS,
      quick: QUICK,
      workload: 'tools/call listPets (Petstore fixture) proxied to a local mock upstream',
    },
    calibration,
    sweep,
    auditSweep,
    auditDelta:
      noneAt && jsonlAt
        ? {
            connections: auditConnections,
            noneCpuMillisPerCall: noneAt.cost.cpuMillisPerCall,
            jsonlCpuMillisPerCall: jsonlAt.cost.cpuMillisPerCall,
            overheadPercent:
              ((jsonlAt.cost.cpuMillisPerCall - noneAt.cost.cpuMillisPerCall) /
                noneAt.cost.cpuMillisPerCall) *
              100,
          }
        : null,
    memory,
    peakThroughput,
    saturation,
    headroom,
    certification: certify(saturation, headroom),
  };

  const markdown = renderMarkdown(report);
  process.stdout.write(`${markdown}\n`);

  if (OUT) {
    await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stderr.write(`\nwrote ${OUT}\n`);
  }

  // A run that cannot show the gateway was the bottleneck must not read as a
  // success. Printing the table and exiting 0 is how an inconclusive run gets
  // copied into a document.
  if (!report.certification.publishable) {
    process.stderr.write(`\nINCONCLUSIVE: ${report.certification.explanation}\nDo not publish these numbers.\n`);
    process.exitCode = 1;
  }
} finally {
  await upstream.close();
  await rm(workDir, { recursive: true, force: true });
}
