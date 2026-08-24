// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end gateway tests (#57).
 *
 * ## These run a real gateway against a real upstream
 *
 * §57 asks for "Petstore + gateway + mock upstream: tools/list returns Petstore
 * ops, tools/call proxies through". So the upstream below is an actual
 * `node:http` server on a real port, the gateway binds real ports, and the
 * assertions go over real sockets.
 *
 * The alternative — injecting a fake `HttpClient` — would have been easier and
 * would have proved less: the thing being tested IS the network hop that §11.3
 * says this topology adds. A test that stubbed the hop would pass on a gateway
 * that could not reach anything.
 *
 * Ports are `0` throughout, so the OS assigns free ones and the suite cannot
 * collide with a developer's running service or with itself under `--runInBand`.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveConfig } from '../config.js';
import { startGateway, type RunningGateway } from '../server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PETSTORE = join(__dirname, '../../../sources-openapi/src/__tests__/fixtures/petstore.json');

/**
 * These tests audit to a JSONL FILE, not to stdout, and that is deliberate.
 *
 * `stdoutAuditSink` resolves its append on the stream's write callback, and
 * mandatory delivery means the dispatcher AWAITS that append before answering
 * (#48 — back-pressure propagates into dispatch so records are never quietly
 * dropped). Under Jest, `process.stdout` is captured and never fires the
 * callback, so the append never settles and the response is never written.
 *
 * That is a Jest artifact, not a gateway defect: the same request returns 200
 * in single-digit milliseconds outside the runner, upstream hit and all.
 * Verified rather than assumed — the probe that established it is what sent
 * these tests to a file sink.
 *
 * Using a file is also the better test. It is a real durable sink, so the audit
 * assertions below check records that actually landed somewhere rather than
 * ones that were formatted and dropped.
 */
const auditDirs: string[] = [];

async function auditPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-audit-'));
  auditDirs.push(dir);
  return join(dir, 'audit.jsonl');
}

/** Requests the upstream saw, so a test can assert what was actually proxied. */
interface UpstreamLog {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

interface MockUpstream {
  readonly url: string;
  readonly requests: UpstreamLog[];
  close(): Promise<void>;
}

/** A stand-in for the adopter's existing API — the thing the gateway fronts. */
async function startUpstream(): Promise<MockUpstream> {
  const requests: UpstreamLog[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      });

      const url = (req.url ?? '').split('?')[0] ?? '';
      if (url === '/pets') {
        const body = JSON.stringify([{ id: 1, name: 'Rex' }]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }
      if (url.startsWith('/pets/')) {
        const body = JSON.stringify({ id: Number(url.slice('/pets/'.length)), name: 'Rex' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"no such upstream route"}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      }),
  };
}

const running: RunningGateway[] = [];
const upstreams: MockUpstream[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((g) => g.close()));
  await Promise.all(upstreams.splice(0).map((u) => u.close()));
  await Promise.all(auditDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function gatewayFor(upstream: MockUpstream, overrides: Record<string, unknown> = {}) {
  const config = resolveConfig(
    {},
    {
      spec: PETSTORE,
      upstream: upstream.url,
      port: 0,
      metricsPort: 0,
      audit: { sink: 'jsonl', path: await auditPath() },
      ...overrides,
    } as never,
  );
  const gateway = await startGateway(config);
  running.push(gateway);
  return gateway;
}

/** One JSON-RPC round trip against the gateway's MCP port. */
async function rpc(gateway: RunningGateway, method: string, params: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  // The transport may answer as SSE; both carry the same JSON-RPC payload.
  const jsonLine = text.startsWith('data:')
    ? (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5).trim()
    : text;
  return { status: response.status, body: JSON.parse(jsonLine) };
}

describe('gateway end to end', () => {
  it('serves the Petstore operations the spec declares', async () => {
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const gateway = await gatewayFor(upstream);

    const { body } = await rpc(gateway, 'tools/list', {});
    const names = (body.result.tools as { name: string }[]).map((t) => t.name).sort();

    expect(names).toEqual(['createPet', 'getPet', 'listPets']);
    expect(gateway.operationCount).toBe(3);
  });

  it('proxies tools/call through to the upstream and returns its response', async () => {
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const gateway = await gatewayFor(upstream);

    const { body } = await rpc(gateway, 'tools/call', { name: 'listPets', arguments: {} });

    expect(body.error).toBeUndefined();
    // The upstream really was called — this is the network hop §11.3 adds.
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.method).toBe('GET');
    expect(upstream.requests[0]?.url.startsWith('/pets')).toBe(true);

    // And its payload came back through, rather than being synthesised.
    expect(JSON.stringify(body.result)).toContain('Rex');
  });

  it('substitutes a path parameter into the upstream request', async () => {
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const gateway = await gatewayFor(upstream);

    await rpc(gateway, 'tools/call', { name: 'getPet', arguments: { petId: '42' } });

    // `/pets/{petId}` must arrive as `/pets/42`. A gateway that forwarded the
    // template would 404 against every real API.
    expect(upstream.requests[0]?.url).toBe('/pets/42');
  });

  it('sends upstream traffic to --upstream, not to the URL baked into the spec', async () => {
    // The fixture declares `http://localhost:3000`. Nothing is listening there
    // in this suite, so a gateway that ignored --upstream would fail to connect
    // and the mock would record nothing.
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const gateway = await gatewayFor(upstream);

    await rpc(gateway, 'tools/call', { name: 'listPets', arguments: {} });

    expect(upstream.requests).toHaveLength(1);
  });

  it('404s a path outside the base path without touching the upstream', async () => {
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const gateway = await gatewayFor(upstream);

    const response = await fetch(`http://127.0.0.1:${gateway.port}/not-mcp`);

    expect(response.status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it('answers readiness and liveness on the MCP port', async () => {
    // Deliberately the MCP port, not the metrics port: an orchestrator probes
    // the port it routes traffic to, and a probe answered elsewhere can report
    // healthy while the listener carrying requests is wedged.
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const gateway = await gatewayFor(upstream);

    const ready = await fetch(`http://127.0.0.1:${gateway.port}/health/ready`);
    const live = await fetch(`http://127.0.0.1:${gateway.port}/health/live`);

    expect([200, 503]).toContain(ready.status);
    expect([200, 503]).toContain(live.status);
    expect(await ready.json()).toHaveProperty('ready');
  });

  it('honours a base path other than the default', async () => {
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const gateway = await gatewayFor(upstream, { basePath: '/api/mcp' });

    const response = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, { method: 'POST' });
    expect(response.status).toBe(404);

    const listed = await fetch(`http://127.0.0.1:${gateway.port}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(listed.status).toBe(200);
  });

  it('closes twice without error', async () => {
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const gateway = await gatewayFor(upstream);

    await gateway.close();
    // §8.6 requires shutdown to be idempotent — two drains would double-flush
    // the audit sink and race to close the same listeners.
    await expect(gateway.close()).resolves.toBeUndefined();
  });
});

describe('audit surface', () => {
  it('writes an audit record for a proxied call', async () => {
    // §57 asks for "the same OTel + audit surfaces as the embedded runtime".
    // The gateway supplies core's sink to the transport and adds nothing, so
    // what this really asserts is that the wiring exists at all — before the
    // transport forwarded these options, it did not.
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const path = await auditPath();
    const gateway = await gatewayFor(upstream, { audit: { sink: 'jsonl', path } });

    await rpc(gateway, 'tools/call', { name: 'listPets', arguments: {} });
    // Flushing is what makes durability observable (#48); reading before it
    // would be reading a buffer, and could pass on a sink that never wrote.
    await gateway.close();

    const lines = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const event = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(event['operationId']).toBe('listPets');
    expect(event['outcome']).toBe('success');
    // The digest stands in for the input; the input itself must never be here.
    expect(event).toHaveProperty('inputDigest');
  });
});

describe('Prometheus scrape endpoint', () => {
  it('serves exposition on the metrics port after traffic', async () => {
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const gateway = await gatewayFor(upstream);

    await rpc(gateway, 'tools/call', { name: 'listPets', arguments: {} });

    const response = await fetch(`http://127.0.0.1:${gateway.metricsPort}/metrics`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    // Non-empty is the assertion that matters: an endpoint that always returned
    // "" would pass a status check while reporting a server with no
    // instrumentation as one with no traffic.
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('# TYPE');
  });

  it('is a SEPARATE listener — /metrics is not served on the MCP port', async () => {
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const gateway = await gatewayFor(upstream);

    // The whole reason for the second port: an operator can expose the MCP port
    // and keep the scrape endpoint on an internal interface.
    const onMcpPort = await fetch(`http://127.0.0.1:${gateway.port}/metrics`);
    expect(onMcpPort.status).toBe(404);
    expect(gateway.metricsPort).not.toBe(gateway.port);
  });

  it('404s a path other than the configured scrape path', async () => {
    const upstream = await startUpstream();
    upstreams.push(upstream);
    const gateway = await gatewayFor(upstream);

    const response = await fetch(`http://127.0.0.1:${gateway.metricsPort}/nope`);
    expect(response.status).toBe(404);
  });
});
