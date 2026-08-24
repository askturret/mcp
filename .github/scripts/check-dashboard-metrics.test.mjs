#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the dashboard/metric drift guard (#63).
 *
 * The guard's whole value is that it FAILS on a dashboard referencing a metric
 * we do not emit. A guard that silently passes everything looks identical in a
 * CI log to one that works, so the negative cases below are the point — each
 * one asserts a specific way the guard must say no.
 *
 * The near-misses matter as much as the hits: `_bucket` must resolve for a
 * histogram and must NOT resolve for a counter, or the suffix rule becomes a
 * hole big enough to drive any typo through.
 *
 * Run: node .github/scripts/check-dashboard-metrics.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  check,
  parseEmittedMetrics,
  extractMetricRefs,
  extractLabelRefs,
  resolveMetric,
  collectExpressions,
} from './check-dashboard-metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const REAL_TYPES = join(repoRoot, 'packages/core/src/telemetry/types.ts');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check_(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(
      `FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
    failed++;
  }
}

/** A stand-in telemetry/types.ts with a known, tiny metric set. */
const FIXTURE_TYPES = `
export const METRIC = {
  toolCallsTotal: 'mcp_tool_calls_total',
  toolDurationSeconds: 'mcp_tool_duration_seconds',
  toolInflight: 'mcp_tool_inflight',
} as const;

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    name: METRIC.toolCallsTotal,
    kind: 'counter',
    labels: ['tool', 'outcome'],
    description: 'x',
  },
  {
    name: METRIC.toolDurationSeconds,
    kind: 'histogram',
    labels: ['tool', 'outcome'],
    description: 'x',
  },
  {
    name: METRIC.toolInflight,
    kind: 'gauge',
    labels: ['tool'],
    description: 'x',
  },
];
`;

/** A throwaway dashboard dir plus a fixture types file. */
function scratch(dashboards) {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-metrics-'));
  tmpDirs.push(dir);
  const dashDir = join(dir, 'dashboards');
  mkdirSync(dashDir, { recursive: true });
  for (const [name, doc] of Object.entries(dashboards)) {
    writeFileSync(
      join(dashDir, name),
      typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2),
    );
  }
  const typesFile = join(dir, 'types.ts');
  writeFileSync(typesFile, FIXTURE_TYPES);
  return { dashDir, typesFile };
}

/** A minimal dashboard document wrapping one PromQL expression. */
const panel = (expr) => ({
  title: 'T',
  uid: 'u',
  panels: [{ title: 'p', type: 'timeseries', targets: [{ expr, legendFormat: '{{tool}}' }] }],
});

function errorsFor(expr) {
  const { dashDir, typesFile } = scratch({ 'd.json': panel(expr) });
  return check(dashDir, typesFile).errors;
}

// ---------------------------------------------------------------------------
console.log('\n# parsing the emitted metric set\n');
// ---------------------------------------------------------------------------

const fixture = parseEmittedMetrics(FIXTURE_TYPES);
check_('parses every declared metric', fixture.size, 3);
check_('carries the metric kind', fixture.get('mcp_tool_duration_seconds').kind, 'histogram');
check_('carries the declared labels', fixture.get('mcp_tool_calls_total').labels.has('outcome'), true);
check_(
  'does not invent labels',
  fixture.get('mcp_tool_inflight').labels.has('outcome'),
  false,
);

// A guard that parses nothing would pass every dashboard. That must be an
// error, not an empty allowlist — this is the vacuous-pass trap.
let threw = false;
try {
  parseEmittedMetrics('export const METRIC = {} as const;\nexport const METRIC_DEFINITIONS = [\n];');
} catch {
  threw = true;
}
check_('refuses to run against an empty metric set rather than passing vacuously', threw, true);

// The real file must parse — otherwise the guard silently protects nothing.
const real = parseEmittedMetrics(readFileSync(REAL_TYPES, 'utf8'));
check_('parses the REAL telemetry/types.ts', real.size >= 20, true);
check_('...including a known counter', real.has('mcp_requests_total'), true);
check_('...and a known audit metric', real.has('mcp_audit_dropped_total'), true);

// ---------------------------------------------------------------------------
console.log('\n# extracting references from PromQL\n');
// ---------------------------------------------------------------------------

check_(
  'finds a metric inside a rate()',
  extractMetricRefs('sum by (tool) (rate(mcp_tool_calls_total[5m]))').join(),
  'mcp_tool_calls_total',
);
check_(
  'ignores recording-rule outputs, which use the colon namespace',
  extractMetricRefs('mcp:registry_hashes:count > 1').length,
  0,
);
check_(
  'finds selector labels',
  extractLabelRefs('mcp_tool_calls_total{tool="a", outcome!="error"}').sort().join(),
  'outcome,tool',
);
check_(
  'finds aggregation labels',
  extractLabelRefs('sum by (tool, outcome) (x)').sort().join(),
  'outcome,tool',
);
check_(
  'finds labels in a without() clause',
  extractLabelRefs('sum without (tool) (x)').join(),
  'tool',
);
check_(
  'walks nested panel structures for expressions',
  collectExpressions({ rows: [{ panels: [{ targets: [{ expr: 'E' }] }] }] }).join(),
  'E',
);

// ---------------------------------------------------------------------------
console.log('\n# histogram suffixes\n');
// ---------------------------------------------------------------------------

check_(
  'a histogram _bucket series resolves to its declared metric',
  resolveMetric('mcp_tool_duration_seconds_bucket', fixture),
  'mcp_tool_duration_seconds',
);
check_('_sum resolves too', resolveMetric('mcp_tool_duration_seconds_sum', fixture), 'mcp_tool_duration_seconds');
check_(
  'a COUNTER with a _bucket suffix does NOT resolve — the suffix rule is not blanket',
  resolveMetric('mcp_tool_calls_total_bucket', fixture),
  null,
);
check_('an unknown metric resolves to nothing', resolveMetric('mcp_invented_total', fixture), null);

// ---------------------------------------------------------------------------
console.log('\n# the guard verdict\n');
// ---------------------------------------------------------------------------

check_(
  'a dashboard using a real metric and real labels passes',
  errorsFor('sum by (tool, outcome) (rate(mcp_tool_calls_total[5m]))').length,
  0,
);

// THE headline requirement of #63.
const invented = errorsFor('sum(rate(mcp_tool_latency_seconds[5m]))');
check_('a dashboard referencing a metric we do not emit FAILS', invented.length, 1);
check_(
  '...and the message names the offending metric',
  invented[0].includes('mcp_tool_latency_seconds'),
  true,
);

check_(
  'a plausible typo of a real metric is caught',
  errorsFor('sum(rate(mcp_tool_call_total[5m]))').length,
  1,
);
check_(
  'histogram_quantile over a real histogram passes, including the le label',
  errorsFor(
    'histogram_quantile(0.99, sum by (le, tool) (rate(mcp_tool_duration_seconds_bucket[5m])))',
  ).length,
  0,
);
check_(
  'Prometheus target labels are accepted',
  errorsFor('sum by (job, instance) (mcp_tool_inflight)').length,
  0,
);
check_(
  'a label no metric in the expression declares FAILS',
  errorsFor('sum by (nonexistent_label) (mcp_tool_inflight)').length,
  1,
);
check_(
  'a label declared on ANOTHER metric in the same expression is accepted',
  errorsFor('sum by (outcome) (mcp_tool_inflight) + sum by (outcome) (mcp_tool_calls_total)').length,
  0,
);
check_(
  'a recording-rule expression with no raw metric passes',
  errorsFor('mcp:registry_hashes:count > 1').length,
  0,
);

{
  const { dashDir, typesFile } = scratch({ 'broken.json': '{ not json' });
  const { errors } = check(dashDir, typesFile);
  check_('malformed dashboard JSON is an error, not a skip', errors.length, 1);
}

{
  const { dashDir, typesFile } = scratch({
    'a.json': panel('rate(mcp_tool_calls_total[5m])'),
    'b.json': panel('rate(mcp_nope_total[5m])'),
  });
  const { errors, files } = check(dashDir, typesFile);
  check_('every dashboard in the directory is read', files, 2);
  check_('...and one bad file among good ones still fails', errors.length, 1);
}

// ---------------------------------------------------------------------------
console.log('\n# the real dashboards in this repository\n');
// ---------------------------------------------------------------------------

{
  const { errors, referenced } = check(join(repoRoot, 'examples/dashboards'), REAL_TYPES);
  check_('the shipped dashboards reference only emitted metrics', errors.length, 0);
  check_('...and actually reference some (not an empty directory passing)', referenced.size > 0, true);
}

// ---------------------------------------------------------------------------

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
