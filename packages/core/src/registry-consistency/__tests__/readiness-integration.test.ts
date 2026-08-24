// SPDX-License-Identifier: Apache-2.0
/**
 * Option B reaching readiness, and the reference alert rules (#64, §11.2).
 *
 * §64's fourth test: "Option B refuses readiness on divergence within scope."
 * The interesting half is everything that must NOT refuse — a detector that
 * pulls instances from rotation for the wrong reason is worse than no detector,
 * because it converts a monitoring gap into an outage.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { evaluateReadiness } from '../../health/readiness.js';
import { parseYamlSubset } from '../../overlay/yaml.js';
import { METRIC_DEFINITIONS } from '../../telemetry/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALERTS = join(__dirname, '../../../../../examples/dashboards/alerts.yaml');

const HEALTHY = { shuttingDown: false, hasRegistrySnapshot: true };

describe('Option B — readiness', () => {
  it('REFUSES readiness on sustained divergence', () => {
    const report = evaluateReadiness({
      ...HEALTHY,
      divergence: { status: 'diverged', detail: '2 registry hashes have persisted' },
    });

    expect(report.ready).toBe(false);
    expect(report.httpStatus).toBe(503);
    expect(report.reason).toBe('registry-divergence');
    expect(report.detail).toContain('2 registry hashes');
  });

  it('stays ready while divergence is inside the grace period', () => {
    // The monitor reports `ok` during a rolling update. If readiness refused
    // here, the first new pod would take every old pod out of rotation and the
    // deploy would take the service down.
    const report = evaluateReadiness({ ...HEALTHY, divergence: { status: 'ok' } });

    expect(report.ready).toBe(true);
  });

  it('stays ready when divergence is UNKNOWN', () => {
    // A peer store outage must not pull a correctly-configured instance from
    // rotation. The monitor's dependency failing is not the application's
    // failure — that is the outage amplification §8.7 forbids.
    const report = evaluateReadiness({ ...HEALTHY, divergence: { status: 'unknown' } });

    expect(report.ready).toBe(true);
  });

  it('stays ready when Option B is not wired at all', () => {
    // The default. §64 makes the external check primary precisely because this
    // one costs availability.
    expect(evaluateReadiness(HEALTHY).ready).toBe(true);
  });

  it('reports shutting-down ahead of divergence', () => {
    // A draining instance diverges from its replacements by definition. An
    // operator reading `registry-divergence` on a pod that is simply being
    // replaced would go and investigate a config bug that does not exist.
    const report = evaluateReadiness({
      ...HEALTHY,
      shuttingDown: true,
      divergence: { status: 'diverged', detail: 'diverged' },
    });

    expect(report.reason).toBe('shutting-down');
  });

  it('reports divergence WITHOUT enforceDependencies', () => {
    // Divergence is a correctness problem, not a degraded upstream. Wiring
    // Option B at all is the opt-in; there is no second switch.
    const report = evaluateReadiness({
      ...HEALTHY,
      enforceDependencies: false,
      divergence: { status: 'diverged', detail: 'diverged' },
    });

    expect(report.reason).toBe('registry-divergence');
  });
});

describe('Option A — the reference alert rules', () => {
  // Parsed with the project's OWN yaml reader, which refuses what it does not
  // understand. That makes this a real structural check rather than a
  // substring search — but see the honest note at the end of this block.
  const document = parseYamlSubset(readFileSync(ALERTS, 'utf8')) as {
    groups: { name: string; interval: string; rules: Record<string, unknown>[] }[];
  };

  const rules = document.groups.flatMap((group) => group.rules);
  const alerts = rules.filter((rule) => 'alert' in rule);
  const records = rules.filter((rule) => 'record' in rule);

  it('parses as YAML at all', () => {
    expect(document.groups.length).toBeGreaterThan(0);
  });

  it('records the distinct-hash count the alert keys on', () => {
    const record = records.find((r) => r['record'] === 'mcp:registry_hashes:count');

    expect(record).toBeDefined();
    // The double-count idiom: inner groups instances by the hash they report,
    // outer counts the groups.
    expect(String(record?.['expr'])).toContain(
      'count_values by (job) ("registry_hash", mcp_registry_hash_id)',
    );
  });

  // #136 QA — the assertion above is TEXT, and text is exactly what stayed
  // green while the rule went inert.
  //
  // #136 removed the `registry_hash` label from `mcp_registry_operations`. The
  // rule kept its expression, so every textual assertion in this block passed
  // — but a missing label collapses to `""` on every series, so the inner
  // grouping became one group per job and the count became a constant 1.
  // `McpRegistryHashDivergence` (severity: critical) could never fire again,
  // and nothing anywhere said so.
  //
  // So assert the rules against the METRIC CONTRACT rather than against their
  // own text: every `mcp_*` series a rule reads must be declared, and every
  // label it groups by must be declared ON one of those metrics. Those are the
  // two facts whose absence made the rule inert.
  it('keys on metrics and labels the runtime actually declares', () => {
    const declared = new Map<string, readonly string[]>(
      METRIC_DEFINITIONS.map((d) => [d.name as string, d.labels]),
    );
    // Attached by Prometheus at scrape time; no metric declares them.
    const SCRAPE_LABELS = ['job', 'instance', 'pod', 'namespace', 'cluster', 'le'];

    for (const rule of rules) {
      const expr = String(rule['expr']);
      const used = [...new Set(expr.match(/\bmcp_[a-z0-9_]+/g) ?? [])];

      // The alerts read recording rules only, so they have nothing to check here.
      if (used.length === 0) continue;

      const allowed = new Set<string>(SCRAPE_LABELS);
      for (const name of used) {
        expect(declared.has(name)).toBe(true);
        for (const label of declared.get(name) ?? []) allowed.add(label);
      }

      // `by (...)` / `without (...)` only. A quoted `count_values` output label
      // is deliberately NOT one of these: it is synthesised from the metric's
      // VALUE and so need not exist on the metric — which is precisely what
      // lets the hash live in the value instead of in an unbounded label.
      for (const match of expr.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)) {
        for (const raw of (match[1] ?? '').split(',')) {
          const label = raw.trim();
          if (label !== '') expect(allowed.has(label)).toBe(true);
        }
      }
    }
  });

  it('groups by job, so two deployments are not compared with each other', () => {
    // §64's scope rule expressed in PromQL. Without it, one Prometheus
    // scraping prod and staging alerts permanently on a correct setup.
    for (const record of records) {
      expect(String(record['expr'])).toContain('by (job');
    }
  });

  it('DEBOUNCES every alert, so a rolling update does not fire it', () => {
    // The whole design. An alert that fired on every successful deploy is one
    // that gets silenced — after which it does not fire on the real bug either.
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(alert['for']).toBe('5m');
    }
  });

  it('uses the same 5m window as Option B’s default grace period', () => {
    // The dashboard and the load balancer must not disagree about how long a
    // rollout may take.
    const DEFAULT_GRACE_MS = 300_000;
    for (const alert of alerts) {
      expect(alert['for']).toBe(`${String(DEFAULT_GRACE_MS / 60_000)}m`);
    }
  });

  it('alerts only above one hash — never on agreement', () => {
    const primary = alerts.find((a) => a['alert'] === 'McpRegistryHashDivergence');

    expect(String(primary?.['expr'])).toBe('mcp:registry_hashes:count > 1');
  });

  it('tells the operator not to auto-remediate', () => {
    // §64 non-goal: the runtime does not know which hash is correct, and
    // neither does the alert. An operator killing the minority on a hunch can
    // delete the only pods running the CORRECT configuration.
    const primary = alerts.find((a) => a['alert'] === 'McpRegistryHashDivergence');
    const annotations = primary?.['annotations'] as Record<string, string>;

    expect(annotations['description']).toContain('Do NOT auto-remediate');
  });

  it('carries a runbook on every alert', () => {
    for (const alert of alerts) {
      const annotations = alert['annotations'] as Record<string, string>;
      expect(annotations['runbook']).toContain('registry-divergence.md');
    }
  });

  // WHAT THIS DOES NOT CHECK, stated rather than implied: that Prometheus
  // accepts the file. `promtool check rules` is the only thing that validates
  // PromQL, and it is not available here. These assertions establish that the
  // structure and the semantics we care about are present — not that the
  // expressions parse. Running promtool is a smoke-test item.
});
