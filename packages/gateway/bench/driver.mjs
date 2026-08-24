#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The load driver (#197).
 *
 * WHY THIS IS CLOSED-LOOP, AND WHY THAT REMOVES THE NEED FOR RATE CONTROL
 * ----------------------------------------------------------------------
 * There are two ways to generate load. An OPEN-loop driver fires at a fixed
 * rate regardless of whether replies come back; a CLOSED-loop driver keeps N
 * requests in flight and starts the next one only when a reply arrives.
 *
 * Open-loop is where the classic "coordinated omission" error lives: once the
 * server slows down, a naive open-loop driver quietly stops issuing requests on
 * schedule, so the very requests that would have recorded the worst latencies
 * are never sent, and the reported p99 improves as the server gets worse.
 * Avoiding that is most of what a mature load tool does for you.
 *
 * A closed-loop driver cannot make that error, because it has no schedule to
 * fall behind. `N` requests in flight is the definition of the workload, not a
 * target it can miss. Every request that is issued is measured, and slowdown
 * shows up honestly as lower throughput at the same N.
 *
 * That is also the workload shape being sized for: MCP clients hold a
 * connection pool and issue the next call when the previous returns. Concurrency
 * is the parameter an operator actually has, so sweeping it is what produces a
 * usable "QPS band" — each N yields an (achieved QPS, latency) pair rather than
 * a rate we asserted up front.
 *
 * Everything here uses `node:http` directly. See `bench/README.md` for why this
 * harness adds no load-testing dependency.
 */

import { fork } from 'node:child_process';
import { Agent, request } from 'node:http';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Drive `connections` concurrent JSON-RPC calls for `durationMillis`.
 *
 * @returns latencies in milliseconds, plus error and status accounting. Errors
 * are returned rather than thrown: a partially-failed run must be visible in
 * the report, and averaging over it silently is exactly how a broken run gets
 * published as a sizing table.
 */
export async function drive({
  port,
  host = '127.0.0.1',
  connections,
  durationMillis,
  body,
  path = '/mcp',
}) {
  // One socket per worker, kept alive. Without keepAlive every call would pay a
  // fresh TCP handshake and we would be sizing the connection setup path rather
  // than the runtime.
  const agent = new Agent({
    keepAlive: true,
    maxSockets: connections,
    maxFreeSockets: connections,
  });

  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const latencies = [];
  const statusCounts = new Map();
  const errors = [];

  const deadline = performance.now() + durationMillis;
  let stopped = false;

  /** One request/response round trip, resolving with its latency in ms. */
  const roundTrip = () =>
    new Promise((resolve) => {
      const started = performance.now();
      const req = request(
        {
          host,
          port,
          path,
          method: 'POST',
          agent,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Content-Length': payload.length,
          },
        },
        (res) => {
          statusCounts.set(res.statusCode, (statusCounts.get(res.statusCode) ?? 0) + 1);
          // The body must be fully consumed before the socket can be reused,
          // and "time to last byte" is the latency an operator experiences.
          // Resuming without reading would recycle the socket early and report
          // a latency that excludes the response.
          res.resume();
          res.on('end', () => resolve(performance.now() - started));
          res.on('error', (error) => {
            errors.push(String(error?.message ?? error));
            resolve(null);
          });
        },
      );

      req.on('error', (error) => {
        errors.push(String(error?.message ?? error));
        resolve(null);
      });

      req.end(payload);
    });

  /** One worker: round trips back to back until the deadline passes. */
  const worker = async () => {
    while (!stopped && performance.now() < deadline) {
      const latency = await roundTrip();
      if (latency !== null) latencies.push(latency);
    }
  };

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: connections }, () => worker()));
  const wallMillis = performance.now() - startedAt;
  stopped = true;

  agent.destroy();

  return {
    latencies,
    wallMillis,
    errors,
    statusCounts: Object.fromEntries(statusCounts),
    completed: latencies.length,
  };
}

/**
 * How many driver processes to use for a given connection count.
 *
 * Capped so the driver never crowds out the thing it is measuring: the gateway
 * needs a core, and the mock upstream needs one too. Never more workers than
 * connections, since a worker with zero connections would just sit idle.
 */
export function workerCount(connections) {
  const spare = Math.max(1, cpus().length - 3);
  return Math.max(1, Math.min(connections, spare, 6));
}

/**
 * Run `drive` across several processes and merge the results.
 *
 * Connections are split as evenly as possible; the remainder is spread one per
 * worker rather than piled onto the last, so no single worker runs hotter than
 * the others and skews its own latencies.
 */
export async function driveParallel(options) {
  const workers = workerCount(options.connections);
  if (workers === 1) {
    const result = await drive(options);
    return { ...result, workers: 1 };
  }

  const base = Math.floor(options.connections / workers);
  const remainder = options.connections % workers;
  const shares = Array.from({ length: workers }, (_, i) => base + (i < remainder ? 1 : 0));

  const children = shares.map(() =>
    fork(join(__dirname, 'driver-worker.mjs'), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }),
  );

  try {
    // Wait for every worker to be up BEFORE any of them starts driving, so the
    // measurement window is the same for all of them. Staggered starts would
    // mean early workers spend part of their window running alone against an
    // unloaded gateway.
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve, reject) => {
            const onMessage = (message) => {
              if (message?.type === 'ready') {
                child.off('message', onMessage);
                resolve();
              }
            };
            child.on('message', onMessage);
            child.once('exit', (code) => reject(new Error(`driver worker exited with ${code}`)));
          }),
      ),
    );

    const results = await Promise.all(
      children.map(
        (child, i) =>
          new Promise((resolve, reject) => {
            const onMessage = (message) => {
              if (message?.type === 'result') {
                child.off('message', onMessage);
                resolve(message.result);
              } else if (message?.type === 'error') {
                child.off('message', onMessage);
                reject(new Error(message.message));
              }
            };
            child.on('message', onMessage);
            child.send({ type: 'drive', options: { ...options, connections: shares[i] } });
          }),
      ),
    );

    const latencies = results.flatMap((r) => r.latencies);
    const statusCounts = {};
    for (const r of results) {
      for (const [status, count] of Object.entries(r.statusCounts)) {
        statusCounts[status] = (statusCounts[status] ?? 0) + count;
      }
    }

    return {
      latencies,
      // The window is the longest worker's, since throughput is calls divided
      // by the wall-clock the whole fan-out spanned. Taking the mean would
      // overstate QPS whenever one worker finished early.
      wallMillis: Math.max(...results.map((r) => r.wallMillis)),
      errors: results.flatMap((r) => r.errors),
      statusCounts,
      completed: latencies.length,
      workers,
    };
  } finally {
    for (const child of children) child.kill();
  }
}

/**
 * The JSON-RPC body used for the sizing workload.
 *
 * `tools/call` rather than `tools/list`: the call path is the one that does the
 * work an operator is sizing for — argument validation, upstream dispatch,
 * response marshalling. `tools/list` mostly returns a precomputed registry and
 * would flatter the numbers.
 */
export function toolCallBody(toolName, args = {}) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } };
}
