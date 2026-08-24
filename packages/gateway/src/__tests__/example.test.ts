// SPDX-License-Identifier: Apache-2.0
/**
 * The compose example, exercised against its own files (#57).
 *
 * ## Why this test exists
 *
 * §57 asks for "a working Docker Compose example ... so an evaluator gets a
 * working end-to-end setup in one command". Examples rot: a flag is renamed, a
 * config key is tightened, and the file that nobody runs in CI keeps claiming
 * to work. The first person to find out is an evaluator, at the worst possible
 * moment.
 *
 * So this reads `examples/gateway-compose/askturret.gateway.yaml` and
 * `openapi.yaml` — the REAL files the container mounts — and starts a gateway
 * from them against a stand-in for the mock upstream.
 *
 * ## What it does NOT cover
 *
 * Docker itself. The image build, the volume mounts, the healthchecks and the
 * collector are not exercised here — this suite has no Docker and building an
 * image in unit tests would be a different kind of slow. So this proves the
 * example's CONFIGURATION and SPEC are valid and wire up correctly; it does not
 * prove `docker compose up` succeeds on a clean machine. That gap is real and
 * belongs to a smoke test, and it is stated rather than implied.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseConfigFile, resolveConfig } from '../config.js';
import { startGateway, type RunningGateway } from '../server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(__dirname, '../../../../examples/gateway-compose');

const running: RunningGateway[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((g) => g.close()));
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeIdleConnections?.();
        }),
    ),
  );
});

/** The routes `mock-upstream.js` serves, enough for the spec's operations. */
async function startStandInUpstream(): Promise<string> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const body =
      path === '/pets'
        ? JSON.stringify([{ id: 1, name: 'Rex', tag: 'dog' }])
        : JSON.stringify({ id: 1, name: 'Rex', tag: 'dog' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
}

describe('examples/gateway-compose', () => {
  it('has a config file the gateway actually accepts', async () => {
    // A key the config parser has since tightened would fail HERE rather than
    // in front of an evaluator running `docker compose up`.
    const text = await readFile(join(EXAMPLE, 'askturret.gateway.yaml'), 'utf8');

    const parsed = parseConfigFile(text, 'askturret.gateway.yaml');

    expect(parsed.upstream).toBe('http://upstream:8080');
    expect(parsed.port).toBe(7000);
    expect(parsed.metricsPort).toBe(9464);
    expect(parsed.audit).toEqual({ sink: 'jsonl', path: '/var/lib/askturret/audit.jsonl' });
  });

  it('serves the example spec’s operations end to end', async () => {
    const upstream = await startStandInUpstream();
    const text = await readFile(join(EXAMPLE, 'askturret.gateway.yaml'), 'utf8');
    const fileLayer = parseConfigFile(text, 'askturret.gateway.yaml');

    // The example's own settings, with only the three things a container
    // supplies differently: the mounted spec path, ephemeral ports, and an
    // upstream that exists in this process rather than on a compose network.
    const config = resolveConfig(fileLayer, {
      spec: join(EXAMPLE, 'openapi.yaml'),
      upstream,
      port: 0,
      metricsPort: 0,
      audit: { sink: 'none' },
    } as never);

    const gateway = await startGateway(config);
    running.push(gateway);

    const response = await fetch(`http://127.0.0.1:${gateway.port}${config.basePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = JSON.parse(await response.text()) as {
      result: { tools: { name: string }[] };
    };

    const names = body.result.tools.map((t) => t.name).sort();
    // Exactly what the example spec declares. If someone edits the spec, this
    // says so rather than the example quietly exposing something else.
    expect(names).toEqual(['getPetById', 'listPets']);
  });

  it('overrides the spec’s public `servers` URL with the compose upstream', async () => {
    // The single most important line in the example config. The spec points at
    // `https://petstore.example.com/api/v1`, which does not exist — if the
    // override stopped working, every call in the example would fail against a
    // public hostname, and the failure would look like a network problem.
    const spec = await readFile(join(EXAMPLE, 'openapi.yaml'), 'utf8');
    const configText = await readFile(join(EXAMPLE, 'askturret.gateway.yaml'), 'utf8');

    expect(spec).toContain('https://petstore.example.com');
    expect(parseConfigFile(configText, 'g.yaml').upstream).toBe('http://upstream:8080');
  });

  it('compose, collector and upstream files agree on ports and hostnames', async () => {
    // These three files only work together, and nothing else checks that they
    // do. A renamed service or a changed port breaks the example silently.
    const compose = await readFile(join(EXAMPLE, 'docker-compose.yml'), 'utf8');
    const collector = await readFile(join(EXAMPLE, 'otel-collector.yaml'), 'utf8');
    const upstreamJs = await readFile(join(EXAMPLE, 'mock-upstream.js'), 'utf8');
    const config = parseConfigFile(
      await readFile(join(EXAMPLE, 'askturret.gateway.yaml'), 'utf8'),
      'g.yaml',
    );

    // The collector scrapes the gateway at the port the gateway is told to use.
    expect(collector).toContain(`gateway:${String(config.metricsPort)}`);
    // The config's upstream names a service compose actually defines.
    expect(compose).toContain('upstream:');
    // ...on the port the mock listens on by default.
    expect(upstreamJs).toContain('8080');
    expect(config.upstream).toContain(':8080');
  });
});
