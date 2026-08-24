#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * One driver process (#197).
 *
 * The driver is parallelised across processes for one reason: a single Node
 * driver is itself one event loop on one core, so against a gateway that is
 * also one event loop it can only ever be a few times faster. That is not
 * enough margin to prove the gateway — not the harness — was the bottleneck.
 *
 * Spreading the connections over several processes lifts the driver's ceiling
 * onto the machine's spare cores, so the headroom check in `stats.ts` can be
 * cleared on merit rather than by lowering the bar it checks against.
 *
 * Raw latencies are shipped back rather than per-worker summaries: percentiles
 * do not average, and a p99 computed from four p99s is not a p99 of anything.
 */

import { drive } from './driver.mjs';

if (typeof process.send !== 'function') {
  console.error('driver-worker.mjs must be spawned with an IPC channel.');
  process.exit(2);
}

process.on('message', (message) => {
  void (async () => {
    if (message?.type !== 'drive') return;
    try {
      const result = await drive(message.options);
      process.send({ type: 'result', result });
    } catch (error) {
      process.send({ type: 'error', message: String(error?.stack ?? error) });
    }
  })();
});

process.send({ type: 'ready' });
