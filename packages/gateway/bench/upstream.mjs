#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The mock upstream, and the null server used to calibrate the driver (#197).
 *
 * The upstream stands in for the adopter's existing API. It answers immediately
 * by default, and that default is a measurement decision worth stating: upstream
 * latency is time the gateway spends AWAITING, not time it spends on CPU, so
 * adding delay here would change how many connections are needed to saturate the
 * event loop without changing the CPU cost per call. Since CPU per call is the
 * transferable number this harness exists to produce, the default isolates it.
 *
 * `--upstream-delay-ms` is available for anyone who wants to see the
 * concurrency effect instead; `run.mjs` records the value it used.
 */

import { createServer } from 'node:http';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeIdleConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * A stand-in for the adopter's API. Returns a small fixed JSON payload.
 *
 * The payload is deliberately small and constant. A large or variable response
 * would move the measurement toward JSON parsing throughput, which is a real
 * cost but one that scales with the adopter's own payloads rather than with the
 * runtime — so it belongs in the caveats, not baked into the headline number.
 */
export async function startUpstream({ delayMillis = 0 } = {}) {
  const payload = Buffer.from(
    JSON.stringify({ id: 1, name: 'Rex', tag: 'dog', createdAt: '2026-01-01T00:00:00Z' }),
    'utf8',
  );

  const server = createServer((req, res) => {
    // The body must be drained even though it is unused, or keep-alive sockets
    // stall once a request carries one.
    req.resume();
    req.on('end', () => {
      const respond = () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
        res.end(payload);
      };
      if (delayMillis > 0) setTimeout(respond, delayMillis);
      else respond();
    });
  });

  return listen(server);
}

/**
 * A server that does as close to nothing as an HTTP server can.
 *
 * This is the calibration target. Driving it measures the DRIVER's ceiling on
 * this machine — the fastest it could possibly report — which is the evidence
 * that the gateway numbers describe the gateway and not the harness. Without
 * this, a hand-written driver's results would be an assertion; with it, the
 * margin is printed and a reader can check it.
 */
export async function startNullServer() {
  const payload = Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}', 'utf8');

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
      res.end(payload);
    });
  });

  return listen(server);
}
