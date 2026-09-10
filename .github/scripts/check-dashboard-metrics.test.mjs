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

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  check,
  parseEmittedMetrics,
  parseRuleFile,
  extractMetricRefs,
  extractLabelRefs,
  resolveMetric,
  collectExpressions,
} from './check-dashboard-metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const REAL_TYPES = join(repoRoot, 'packages/core/src/telemetry/types.ts');
const REAL_RULES = join(repoRoot, 'examples/dashboards/alerts.yaml');

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
  const { errors, referenced, rules } = check(
    join(repoRoot, 'examples/dashboards'),
    REAL_TYPES,
    REAL_RULES,
  );
  check_('the shipped dashboards and rules reference only emitted metrics', errors.length, 0);
  check_('...and actually reference some (not an empty directory passing)', referenced.size > 0, true);
  check_('...and the rule file was actually read (not silently skipped)', rules > 0, true);
}

// ---------------------------------------------------------------------------
console.log('\n# alert rule files (#136 QA)\n');
// ---------------------------------------------------------------------------

// Until #136 QA this guard read dashboards and nothing else, because recording
// rules "are defined in alerts.yaml, not emitted by the runtime". True of the
// rule OUTPUTS and wrong about their INPUTS — a recording rule is a PromQL
// expression over real metrics, and it drifts exactly as a panel does.
//
// It drifted. #136 removed `registry_hash` from `mcp_registry_operations`, and
// `mcp:registry_hashes:count` — which counts distinct values of that label —
// became a constant 1, so a severity:critical alert could never fire again.
// Nothing failed, because nobody was reading the rule file.

{
  const rulesFile = join(mkdtempSync(join(tmpdir(), 'rules-')), 'alerts.yaml');
  tmpDirs.push(dirname(rulesFile));

  const rulesWith = (expr) =>
    `groups:\n  - name: g\n    rules:\n      - record: mcp:x:count\n        expr: ${expr}\n`;

  const errorsForRule = (expr, typesFile) => {
    writeFileSync(rulesFile, rulesWith(expr));
    return check(scratch({}).dashDir, typesFile ?? scratch({}).typesFile, rulesFile).errors;
  };

  check_(
    'a rule over a real metric with real labels passes',
    errorsForRule('sum by (tool) (mcp_tool_inflight)').length,
    0,
  );
  check_(
    'a rule over a metric we do not emit FAILS',
    errorsForRule('sum(mcp_nope_total)').length,
    1,
  );

  // THE REGRESSION, verbatim, against the REAL metric declarations — because
  // the point is that this expression was correct until the label it groups by
  // was removed from a metric that still exists. Run against the fixture types
  // it would fail for the uninteresting reason that the metric is unknown there.
  const regression = errorsForRule(
    'count by (job) (count by (job, registry_hash) (mcp_registry_operations))',
    REAL_TYPES,
  );
  check_('a rule grouping by a label the metric no longer declares FAILS', regression.length, 1);
  check_(
    '...and the message names the label, not just the rule',
    regression[0].includes("'registry_hash'"),
    true,
  );

  check_(
    'the rule name is reported, so the failure points at a rule and not a file',
    errorsForRule('sum(mcp_nope_total)')[0].includes('record mcp:x:count'),
    true,
  );

  // An `expr:` the reader cannot parse must THROW, never be skipped. A guard
  // that silently checks fewer expressions than the file contains reads exactly
  // like one that checked them all.
  let threw = false;
  try {
    parseRuleFile('groups:\n  - rules:\n      - record: a\n        expr: >-\n          sum(x)\n');
  } catch {
    threw = true;
  }
  check_('an unreadable multi-line expr THROWS rather than being skipped', threw, true);

  check_(
    'a missing rule file is an error, not a silent pass',
    check(scratch({}).dashDir, REAL_TYPES, join(dirname(rulesFile), 'nope.yaml')).errors.length,
    1,
  );
}

// ---------------------------------------------------------------------------
console.log('\n# recording-rule references\n');
// ---------------------------------------------------------------------------

{
  const rulesFile = join(mkdtempSync(join(tmpdir(), 'rules2-')), 'alerts.yaml');
  tmpDirs.push(dirname(rulesFile));
  writeFileSync(
    rulesFile,
    'groups:\n  - name: g\n    rules:\n      - record: mcp:defined:count\n        expr: sum(mcp_tool_inflight)\n',
  );

  const { dashDir, typesFile } = scratch({ 'd.json': panel('mcp:defined:count > 1') });
  check_(
    'a panel reading a DEFINED recording rule passes',
    check(dashDir, typesFile, rulesFile).errors.length,
    0,
  );

  const orphan = scratch({ 'd.json': panel('mcp:not_defined:count > 1') });
  const errors = check(orphan.dashDir, orphan.typesFile, rulesFile).errors;
  check_('a panel reading an UNDEFINED recording rule FAILS', errors.length, 1);
  check_(
    '...and names the rule',
    errors[0].includes("'mcp:not_defined:count'"),
    true,
  );

  // Without a rule file there is no basis to judge, so this must stay silent.
  // Reporting it would turn "not asked to check" into "broken".
  check_(
    'an undefined recording rule is NOT reported when no rule file is given',
    check(orphan.dashDir, orphan.typesFile).errors.length,
    0,
  );
}

// ---------------------------------------------------------------------------
console.log('\n# the parse refusals, and the exit code that carries them (#559 D2)\n');
// ---------------------------------------------------------------------------

/*
 * WHY THESE PIN THE MESSAGE INSTEAD OF ASSERTING `threw` (#559 D2).
 *
 * The idiom used above — `try { … } catch { threw = true }` — CANNOT witness
 * these two throws, and a test written that way would be indistinguishable
 * from one that does. Neutralise the missing-`METRIC` throw and the very next
 * line dereferences `metricBlock[1]`, so a TypeError is raised from the same
 * call: `threw` is still `true` and the assertion still passes with the guard
 * disarmed. That is the masking shape #559 is about — the assertion reddens on
 * the ABSENCE of an exception, and neutralising the branch does not produce an
 * absence.
 *
 * So each of these pins the message. That is also what makes them
 * BRANCH-DISCRIMINATING, which is the bar #559 sets: substitute a neighbouring
 * branch's message and the regex fails, so the witness distinguishes WHICH
 * refusal fired rather than merely that something did.
 */
function messageFrom(fn) {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '(did not throw)';
}

check_(
  'names the missing `METRIC` constant rather than dying on the next line',
  /could not locate `export const METRIC = \{\.\.\.\}`/.test(
    messageFrom(() =>
      parseEmittedMetrics('export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [\n];'),
    ),
  ),
  true,
);

check_(
  'names the missing `METRIC_DEFINITIONS` constant',
  /could not locate `export const METRIC_DEFINITIONS = \[\.\.\.\]`/.test(
    messageFrom(() => parseEmittedMetrics("export const METRIC = {\n  a: 'x',\n} as const;")),
  ),
  true,
);

/*
 * The partially-parsed set (#136), which needs TWO entries to reach.
 *
 * One entry must parse, or `metrics.size === 0` throws the vacuous-pass
 * refusal first and this branch is never reached — the neighbouring-guard
 * ordering that makes a one-entry fixture measure the wrong site.
 */
const PARTIALLY_PARSED = `
export const METRIC = {
  good: 'mcp_good_total',
  dropped: 'mcp_dropped_total',
} as const;

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    name: METRIC.good,
    kind: 'counter',
    labels: ['tool'],
  },
  {
    name: METRIC.dropped,
    kind: 'counter',
    // A comment here is exactly what #136 hit: it splits the \`name … kind …
    // labels\` span, so this entry vanishes from the map without a word.
    labels: ['tool'],
  },
];
`;

check_(
  'refuses a PARTIALLY parsed definition set, and says how many it read',
  /parsed 1 of 2 metric definitions; could not read: dropped/.test(
    messageFrom(() => parseEmittedMetrics(PARTIALLY_PARSED)),
  ),
  true,
);

/*
 * THE CLI'S EXIT CODE, witnessed at process level (#559 D2).
 *
 * `process.exit(1)` sits behind `process.argv[1] === fileURLToPath(...)`, so
 * no in-process call can reach it — every assertion above imports `check()`
 * and never runs the module as a program. Spawning it is the only way to
 * observe the code the CI step actually reads.
 *
 * BOTH OUTCOMES ARE ASSERTED, and the green one is the POSITIVE CONTROL. A
 * test that only ever expects 1 passes just as well against a script that
 * cannot start at all — a syntax error, a bad import, a crash in argument
 * handling all exit non-zero — so on its own it cannot tell "refused because
 * it found an error" from "never ran". The 0 case is what proves this harness
 * observes the exit code rather than the failure to launch, so a 1 here is a
 * measurement.
 *
 * Asserted as `=== 1` and never as "non-zero", which is what makes it
 * discriminating: change the site to `process.exit(2)` and this reddens.
 */
const GUARD = join(here, 'check-dashboard-metrics.mjs');

function runCli(expr) {
  const { dashDir, typesFile } = scratch({ 'd.json': panel(expr) });
  const rulesFile = join(dashDir, '..', 'empty-alerts.yaml');
  writeFileSync(rulesFile, 'groups: []\n');
  return spawnSync(process.execPath, [GUARD, dashDir, typesFile, rulesFile], {
    encoding: 'utf-8',
  });
}

const cleanRun = runCli('sum by (tool) (rate(mcp_tool_calls_total[5m]))');
check_(
  'exits 0 when every referenced metric is emitted (positive control)',
  cleanRun.status,
  0,
);

const dirtyRun = runCli('sum by (tool) (rate(mcp_not_emitted_total[5m]))');
check_(
  'exits 1 — not merely non-zero — when a dashboard references an unemitted metric',
  dirtyRun.status,
  1,
);
check_(
  '...and the refusal names the offending metric on stderr',
  dirtyRun.stderr.includes('mcp_not_emitted_total'),
  true,
);

// ---------------------------------------------------------------------------

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
