#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The system under test: one gateway, alone in its own process (#197).
 *
 * WHY A SEPARATE PROCESS
 * ----------------------
 * The deliverable is "CPU/memory PER INSTANCE". If the load driver and the mock
 * upstream shared this process, their CPU would be indistinguishable from the
 * gateway's and the headline number would be wrong in the flattering direction.
 * Here the gateway is the only thing running, so `process.cpuUsage()` and
 * `process.memoryUsage.rss()` are attributable to it by construction.
 *
 * This is also what makes the measurement robust to running everything on one
 * developer machine. `cpuUsage()` reports CPU *charged to this process* by the
 * kernel, not a share of a machine-wide meter, so the driver competing for the
 * other cores cannot inflate or deflate it. Latency is a different matter — that
 * one IS affected by co-location, and `run.mjs` says so where it reports it.
 *
 * Speaks a tiny request/response protocol over Node's child-process IPC channel
 * rather than over a control port: one less socket to confuse with the socket
 * being measured.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Imported from `dist/`, not `src/`: the harness measures the code an operator
// would actually run. If the build is missing this throws here, at startup,
// with a resolution error naming the file — not later as a confusing timeout.
const { resolveConfig } = await import(join(__dirname, '../dist/config.js'));
const { startGateway } = await import(join(__dirname, '../dist/server.js'));

if (typeof process.send !== 'function') {
  console.error('sut.mjs must be spawned with an IPC channel (stdio: [..., "ipc"]).');
  process.exit(2);
}

/** Options arrive as one JSON argument so nothing has to be re-parsed by hand. */
const options = JSON.parse(process.argv[2] ?? '{}');

let running = null;

/**
 * Resident set size, after giving V8 a chance to collect.
 *
 * RSS is the number an operator's memory limit is enforced against, so it is
 * the right metric — but it is also noisy, because it includes garbage not yet
 * collected. When the harness is run with `--expose-gc` we collect first, which
 * turns "how much memory is held" into a number that means what the reader will
 * assume it means. Without the flag we report it as-is and `run.mjs` records
 * that the reading was un-collected, rather than quietly presenting the two as
 * the same measurement.
 */
function rssBytes() {
  if (typeof globalThis.gc === 'function') {
    // Twice: the first pass can resurrect finalisable objects, the second
    // actually reclaims them.
    globalThis.gc();
    globalThis.gc();
  }
  return process.memoryUsage.rss();
}

function sample() {
  const cpu = process.cpuUsage();
  return {
    userMicros: cpu.user,
    systemMicros: cpu.system,
    // `performance.now()` is monotonic, so a clock adjustment mid-run cannot
    // produce a negative window the way Date.now() could.
    wallMillis: performance.now(),
    rssBytes: rssBytes(),
  };
}

process.on('message', (message) => {
  void (async () => {
    try {
      if (message?.type === 'sample') {
        process.send({ type: 'sample', id: message.id, sample: sample() });
        return;
      }

      if (message?.type === 'stop') {
        if (running) await running.close();
        process.send({ type: 'stopped', id: message.id });
        process.exit(0);
      }
    } catch (error) {
      process.send({ type: 'error', id: message?.id, message: String(error?.stack ?? error) });
      process.exit(1);
    }
  })();
});

try {
  const config = resolveConfig(
    {},
    {
      spec: options.spec,
      upstream: options.upstream,
      port: 0,
      metricsPort: 0,
      audit: options.audit ?? { sink: 'none' },
    },
  );

  running = await startGateway(config);

  process.send({
    type: 'ready',
    port: running.port,
    operationCount: running.operationCount,
    gcExposed: typeof globalThis.gc === 'function',
    nodeVersion: process.version,
    sample: sample(),
  });
} catch (error) {
  process.send({ type: 'error', message: String(error?.stack ?? error) });
  process.exit(1);
}
