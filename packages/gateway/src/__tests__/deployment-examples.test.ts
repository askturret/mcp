// SPDX-License-Identifier: Apache-2.0
/**
 * The reference deployments, checked against their own files (#63).
 *
 * ## Why this test exists
 *
 * §63 ships a Helm chart and a compose stack as the REFERENCE architecture —
 * the thing an adopter copies. Examples rot silently: a config key is
 * tightened, a mounted path is renamed, a dashboard file moves, and the
 * example keeps claiming to work until someone runs it. The reference is the
 * worst possible place for that, because a copied mistake propagates.
 *
 * So this reads the REAL files the containers mount and asserts the things
 * that would otherwise only fail in front of an operator.
 *
 * ## What it does NOT cover — stated rather than implied
 *
 * Neither `helm` nor `kubectl` nor Docker is available in this suite, so:
 *
 *   - the chart is NOT rendered (`helm template`) or linted
 *   - `docker compose up` is NOT executed
 *   - Grafana is NOT started, so "dashboards import cleanly" is NOT proven here
 *
 * What IS proven: the gateway config both deployments ship is accepted by the
 * gateway's own parser, every host path the compose file mounts exists, the
 * telemetry wiring points at files that are really there, and the probe
 * invariant below holds. Rendering and a live import belong to a smoke test.
 */

import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { parseConfigFile, resolveConfig } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '../../../..');
const COMPOSE = join(REPO, 'examples/deployments/docker-compose');
const CHART = join(REPO, 'examples/deployments/kubernetes');
const DASHBOARDS = join(REPO, 'examples/dashboards');

const read = (path: string): Promise<string> => readFile(path, 'utf8');

/**
 * Pull a top-level block out of a YAML document by indentation, and dedent it.
 *
 * Used to lift the Helm chart's `config:` block so it can be fed to the
 * gateway's REAL parser. A full YAML library is not a dependency of this
 * package, and the block is plain scalars — no anchors, no flow collections.
 */
function extractBlock(yaml: string, key: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start === -1) throw new Error(`no top-level '${key}:' block in the document`);

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    // A non-indented, non-comment line ends the block.
    if (!/^\s/.test(line)) break;
    body.push(line.replace(/^ {2}/, ''));
  }
  return body.join('\n');
}

describe('examples/deployments/docker-compose', () => {
  it('ships a gateway config the gateway actually accepts', async () => {
    // A key the parser has since tightened fails HERE, not in front of an
    // evaluator running `docker compose up`.
    const parsed = parseConfigFile(
      await read(join(COMPOSE, 'askturret.gateway.yaml')),
      'askturret.gateway.yaml',
    );
    const config = resolveConfig(parsed, {} as never);

    expect(config.port).toBe(7000);
    expect(config.metricsPort).toBe(9464);
    // The reference runs `production`, not `light`. If this ever silently
    // becomes `light`, the reference stops demonstrating the posture §11.2
    // assumes — bounded concurrency, breakers, a real audit sink.
    expect(config.preset).toBe('production');
    // stdout is a pipe to a log collector, not a delivery guarantee.
    expect(config.audit.sink).toBe('jsonl');
  });

  it('mounts only host paths that exist', async () => {
    const compose = await read(join(COMPOSE, 'docker-compose.yml'));

    // `- ./x:/y:ro` and `- ../../x:/y` — the relative host paths. A named
    // volume (`audit:/var/lib/...`) has no leading dot and is skipped.
    const hostPaths = [...compose.matchAll(/^\s*-\s+(\.[^:\s]*):/gm)].map((m) => m[1]);

    // Guard the guard: a regex that matched nothing would pass this test
    // while checking nothing at all.
    expect(hostPaths.length).toBeGreaterThanOrEqual(6);

    for (const relative of hostPaths) {
      expect({ path: relative, exists: existsSync(resolve(COMPOSE, relative)) }).toEqual({
        path: relative,
        exists: true,
      });
    }
  });

  it('scrapes both instances under ONE job, or the divergence rules cannot fire', async () => {
    const prometheus = await read(join(COMPOSE, 'prometheus.yml'));

    // alerts.yaml groups `by (job)`. Two instances split across two jobs are
    // only ever compared against themselves, so the hash count is permanently
    // 1 and #64's detector can never fire however far the configs drift.
    const jobs = [...prometheus.matchAll(/^\s*-\s*job_name:\s*(\S+)/gm)].map((m) => m[1]);
    expect(jobs).toEqual(['askturret-mcp']);

    expect(prometheus).toContain('mcp-a:9464');
    expect(prometheus).toContain('mcp-b:9464');
  });

  it('loads the canonical alert rules rather than a copy', async () => {
    const prometheus = await read(join(COMPOSE, 'prometheus.yml'));
    const compose = await read(join(COMPOSE, 'docker-compose.yml'));

    expect(prometheus).toContain('/etc/prometheus/alerts.yaml');
    // ...and that path is the real examples/dashboards/alerts.yaml, mounted.
    expect(compose).toContain('../../dashboards/alerts.yaml:/etc/prometheus/alerts.yaml');
    expect(existsSync(join(DASHBOARDS, 'alerts.yaml'))).toBe(true);
  });

  it('provisions Grafana from the same directory CI checks', async () => {
    const provider = await read(
      join(COMPOSE, 'grafana/provisioning/dashboards/dashboards.yml'),
    );
    const compose = await read(join(COMPOSE, 'docker-compose.yml'));

    // The provider's path and the compose mount target must agree, or Grafana
    // provisions an empty directory and reports no error.
    const match = provider.match(/path:\s*(\S+)/);
    expect(match).not.toBeNull();
    const target = match![1];

    expect(compose).toContain(`../../dashboards:${target}`);
  });
});

describe('examples/deployments/kubernetes', () => {
  it('ships a gateway config the gateway actually accepts', async () => {
    const values = await read(join(CHART, 'values.yaml'));
    const parsed = parseConfigFile(extractBlock(values, 'config'), 'values.yaml');
    const config = resolveConfig(parsed, {} as never);

    expect(config.port).toBe(7000);
    expect(config.metricsPort).toBe(9464);
    expect(config.preset).toBe('production');
    expect(config.audit.sink).toBe('jsonl');
  });

  it('keeps the compose and Helm references on the same posture', async () => {
    // Two reference deployments that disagree about the preset or the audit
    // sink would each be teaching something different, and only one of them
    // could be the reference.
    const composeConfig = resolveConfig(
      parseConfigFile(await read(join(COMPOSE, 'askturret.gateway.yaml')), 'a.yaml'),
      {} as never,
    );
    const helmConfig = resolveConfig(
      parseConfigFile(extractBlock(await read(join(CHART, 'values.yaml')), 'config'), 'b.yaml'),
      {} as never,
    );

    expect(helmConfig.preset).toBe(composeConfig.preset);
    expect(helmConfig.audit.sink).toBe(composeConfig.audit.sink);
    expect(helmConfig.basePath).toBe(composeConfig.basePath);
  });

  /**
   * The invariant this whole chart is careful about.
   *
   * /health/ready reports NOT READY for a sustained registry divergence (#64)
   * and while draining (#47) — conditions that must pull an instance out of
   * the load balancer WITHOUT killing it.
   *
   * If liveness pointed at the same endpoint, a sustained divergence would
   * fail liveness on every replica at once. Kubernetes would restart them all,
   * they would return with the same divergent config, and fail again — a
   * CrashLoopBackOff caused entirely by the detector installed to prevent a
   * quieter problem.
   *
   * This is a one-word edit to make and gives no feedback until the day it
   * matters, which is exactly why it is asserted rather than only explained.
   */
  it('probes readiness and liveness on DIFFERENT endpoints', async () => {
    const deployment = await read(join(CHART, 'templates/deployment.yaml'));

    const readiness = deployment.match(/readinessProbe:[\s\S]*?path:\s*(\S+)/);
    const liveness = deployment.match(/livenessProbe:[\s\S]*?path:\s*(\S+)/);

    expect(readiness).not.toBeNull();
    expect(liveness).not.toBeNull();

    expect(readiness![1]).toBe('/health/ready');
    expect(liveness![1]).toBe('/health/live');
    expect(liveness![1]).not.toBe(readiness![1]);
  });

  it('gives shutdown longer than the pre-stop pause it has to contain', async () => {
    const values = await read(join(CHART, 'values.yaml'));

    const grace = Number(values.match(/terminationGracePeriodSeconds:\s*(\d+)/)?.[1]);
    const preStop = Number(values.match(/preStopDelaySeconds:\s*(\d+)/)?.[1]);

    expect(Number.isFinite(grace)).toBe(true);
    expect(Number.isFinite(preStop)).toBe(true);
    // Otherwise SIGKILL lands partway through draining the very calls the
    // pre-stop pause exists to protect.
    expect(grace).toBeGreaterThan(preStop);
  });

  it('rolls with bounded surge, so a normal deploy cannot trip the 5m debounce', async () => {
    const values = await read(join(CHART, 'values.yaml'));

    // maxUnavailable 0 holds capacity flat; maxSurge 1 bounds how long two
    // registry hashes coexist. An unbounded surge would replace the whole
    // deployment at once and could hold two hashes past the debounce window,
    // firing the divergence alert on a correct deploy.
    expect(values).toMatch(/maxUnavailable:\s*0/);
    expect(values).toMatch(/maxSurge:\s*1/);
  });

  it('refuses to install a PrometheusRule with no rules in it', async () => {
    const template = await read(join(CHART, 'templates/prometheusrule.yaml'));

    // An empty PrometheusRule installs cleanly, appears in `kubectl get
    // prometheusrules`, and alerts on nothing — indistinguishable from working.
    expect(template).toContain('fail');
    expect(template).toContain('set-file monitoring.prometheusRule.rules');
  });
});

describe('examples/dashboards', () => {
  it('ships every dashboard the reference architecture refers to', () => {
    for (const file of [
      'mcp-overview.json',
      'policy-activity.json',
      'reliability.json',
      'audit-health.json',
      'registry.json',
      'alerts.yaml',
    ]) {
      expect({ file, exists: existsSync(join(DASHBOARDS, file)) }).toEqual({
        file,
        exists: true,
      });
    }
  });

  it('gives every dashboard a distinct uid', async () => {
    const files = [
      'mcp-overview.json',
      'policy-activity.json',
      'reliability.json',
      'audit-health.json',
      'registry.json',
    ];
    const uids: string[] = [];
    for (const file of files) {
      const doc = JSON.parse(await read(join(DASHBOARDS, file))) as { uid: string };
      uids.push(doc.uid);
    }
    // Grafana keys provisioned dashboards by uid: a duplicate means the second
    // file silently OVERWRITES the first, and the folder shows four dashboards
    // where five were provisioned.
    expect(new Set(uids).size).toBe(files.length);
  });
});
