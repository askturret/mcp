#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Dashboard/metric drift guard (#63: "CI test ensures dashboards don't
 * reference metrics we don't emit").
 *
 * ## What breaks without this
 *
 * A dashboard that queries a metric the runtime never emits does not error.
 * Grafana draws an empty panel, which is indistinguishable from a panel whose
 * metric is legitimately at zero — "no errors" and "error counter renamed six
 * months ago" render identically. The failure surfaces during an incident, at
 * the moment the panel was supposed to earn its keep.
 *
 * That is why this is a CI check and not a review convention: the broken state
 * is invisible by construction, so nothing else will report it.
 *
 * ## Why this parses source instead of importing the built module
 *
 * Same reasoning as check-metric-cardinality.mjs: the guard must run even when
 * the build is broken. Importing `dist` would make the guard depend on the
 * thing it guards, so a compile error would silently SKIP it rather than fail
 * it — and a skipped guard reads exactly like a passing one in a CI log.
 *
 * Run: node .github/scripts/check-dashboard-metrics.mjs [dashboardDir] [typesFile]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

const DASHBOARD_DIR = process.argv[2] ?? join(repoRoot, 'examples/dashboards');
const TYPES_FILE =
  process.argv[3] ?? join(repoRoot, 'packages/core/src/telemetry/types.ts');
const RULES_FILE = process.argv[4] ?? join(repoRoot, 'examples/dashboards/alerts.yaml');

/**
 * Labels Prometheus itself attaches, or that PromQL introduces — none of which
 * appear in METRIC_DEFINITIONS because the runtime does not emit them.
 *
 * `le` is the histogram bucket boundary, synthesised by the histogram type.
 * The rest are target labels applied by the scrape config. Omitting these
 * would make every correct `histogram_quantile(...) by (le, ...)` fail, which
 * is the fastest way to get a guard switched off.
 */
const PROMETHEUS_LABELS = new Set([
  'le',
  'job',
  'instance',
  'pod',
  'namespace',
  'container',
  'service',
  'cluster',
  'node',
]);

/** Histogram families expand into these suffixed series at scrape time. */
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];

/**
 * Metric names the runtime emits, plus each one's declared label set.
 *
 * Reads the two constants in telemetry/types.ts:
 *   METRIC             — key -> wire name
 *   METRIC_DEFINITIONS — { name: METRIC.key, kind, labels: [...] }
 */
export function parseEmittedMetrics(source) {
  const byKey = new Map();
  const metricBlock = source.match(/export const METRIC\s*=\s*\{([\s\S]*?)\}\s*as const;/);
  if (!metricBlock) {
    throw new Error('could not locate `export const METRIC = {...}` in the telemetry types');
  }
  for (const [, key, name] of metricBlock[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
    byKey.set(key, name);
  }

  const metrics = new Map();
  const defsBlock = source.match(/export const METRIC_DEFINITIONS[\s\S]*?\n\];/);
  if (!defsBlock) {
    throw new Error('could not locate `export const METRIC_DEFINITIONS = [...]` in the telemetry types');
  }

  // Each entry: name: METRIC.foo, kind: 'counter', labels: ['a', 'b'],
  const entryRe =
    /name:\s*METRIC\.(\w+)\s*,\s*kind:\s*'(\w+)'\s*,\s*labels:\s*\[([^\]]*)\]/g;
  for (const [, key, kind, rawLabels] of defsBlock[0].matchAll(entryRe)) {
    const name = byKey.get(key);
    if (!name) continue;
    const labels = rawLabels
      .split(',')
      .map((l) => l.trim().replace(/^['"`]|['"`]$/g, ''))
      .filter(Boolean);
    metrics.set(name, { kind, labels: new Set(labels) });
  }

  if (metrics.size === 0) {
    throw new Error('parsed zero metric definitions — the guard would pass vacuously');
  }

  // Every declared entry must have been PARSED, not merely most of them (#136).
  //
  // `entryRe` matches `name … kind … labels` as one span with only whitespace
  // between, so anything else in that gap — a comment, a reordered key — makes
  // the entry vanish from this map. Silently: the loop above just does not
  // match it, and `metrics.size === 0` only catches total failure.
  //
  // The symptom is a lie in the opposite direction from the one this guard
  // exists to catch. A dashboard panelling the dropped metric is reported as
  // "references a metric the runtime does not emit", which sends a reader to
  // fix a dashboard that was correct. That is exactly what happened when a
  // comment was added between `kind` and `labels`.
  const declared = [...defsBlock[0].matchAll(/name:\s*METRIC\.(\w+)/g)].map(([, key]) => key);
  const unparsed = declared.filter((key) => {
    const name = byKey.get(key);
    return name === undefined || !metrics.has(name);
  });
  if (unparsed.length > 0) {
    throw new Error(
      `parsed ${String(metrics.size)} of ${String(declared.length)} metric definitions; ` +
        `could not read: ${unparsed.join(', ')}. ` +
        'Each entry must keep `name`, `kind` and `labels` adjacent — put any comment ABOVE ' +
        'the entry, not between its keys.',
    );
  }

  return metrics;
}

/**
 * Metric identifiers referenced by a PromQL expression.
 *
 * Recording-rule outputs use a colon-separated namespace (`mcp:foo:rate5m`)
 * per Prometheus convention, so they never match `mcp_...` and are correctly
 * ignored here. They are defined in alerts.yaml — which this guard now reads
 * too (see `parseRuleFile`), so "correctly ignored" no longer means unchecked.
 */
export function extractMetricRefs(expr) {
  return [...new Set(expr.match(/\bmcp_[a-z0-9_]+/g) ?? [])];
}

/** Recording-rule outputs (`mcp:foo:bar`) referenced by an expression. */
export function extractRecordingRefs(expr) {
  return [...new Set(expr.match(/\bmcp:[a-z0-9_:]+/g) ?? [])];
}

/**
 * Rule names and PromQL expressions declared in a Prometheus rule file.
 *
 * ## Why this exists (#136 QA)
 *
 * Until this was added, the guard read `examples/dashboards/*.json` and
 * nothing else, on the stated grounds that recording rules are "defined in
 * alerts.yaml, not emitted by the runtime". True of the rule OUTPUTS, and
 * badly wrong about their INPUTS: a recording rule is a PromQL expression over
 * real emitted metrics, so it drifts exactly like a panel does.
 *
 * It drifted. #136 removed the `registry_hash` label from
 * `mcp_registry_operations`, and `mcp:registry_hashes:count` — which counts
 * DISTINCT values of that label — silently became a constant 1. A missing
 * label collapses to `""` for every series, so there was no error anywhere:
 * `McpRegistryHashDivergence` (severity: critical) simply could never fire
 * again. The dashboards that read the rule kept passing this guard, because
 * the rule's name was all they mentioned.
 *
 * A rule file is the worse case of the two, because a panel at least renders
 * visibly empty. An alert that cannot fire looks exactly like an alert with
 * nothing to report.
 *
 * Deliberately a narrow reader, not a YAML parser: it wants `record:`,
 * `alert:` and `expr:`, and it THROWS on an `expr:` it cannot read rather than
 * skipping it. Skipping is how a guard silently checks less than it claims —
 * the same failure this file already carries a fix for in `parseEmittedMetrics`.
 */
export function parseRuleFile(source) {
  const expressions = [];
  const recorded = new Set();
  let context = '(before any rule)';
  let declared = 0;

  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    if (/^\s*#/.test(line)) continue;

    const named = /^\s*-?\s*(record|alert):\s*(\S+)\s*$/.exec(line);
    if (named) {
      context = `${named[1]} ${named[2]}`;
      if (named[1] === 'record') recorded.add(named[2]);
      continue;
    }

    const expr = /^\s*expr:\s*(.*)$/.exec(line);
    if (!expr) continue;
    declared += 1;

    const value = expr[1].trim();
    if (value === '' || value === '|' || value === '>' || value === '>-' || value === '|-') {
      throw new Error(
        `line ${String(index + 1)} (${context}): multi-line \`expr:\` blocks are not supported ` +
          'by this reader. Keep rule expressions on one line, or teach parseRuleFile to read ' +
          'the block — do NOT leave it unread, which is a guard that silently checks less ' +
          'than it reports.',
      );
    }
    expressions.push({ expr: value, context });
  }

  if (declared !== expressions.length) {
    throw new Error(
      `read ${String(expressions.length)} of ${String(declared)} \`expr:\` entries`,
    );
  }

  return { expressions, recorded };
}

/**
 * Resolve a referenced series back to a declared metric.
 *
 * Returns the declared base name, or null when nothing matches. Histogram
 * series are stored suffixed at scrape time, so `mcp_x_bucket` legitimately
 * refers to declared histogram `mcp_x`.
 */
export function resolveMetric(ref, metrics) {
  if (metrics.has(ref)) return ref;

  for (const suffix of HISTOGRAM_SUFFIXES) {
    if (!ref.endsWith(suffix)) continue;
    const base = ref.slice(0, -suffix.length);
    if (metrics.get(base)?.kind === 'histogram') return base;
  }
  return null;
}

/**
 * Label keys used by an expression: both selector matchers (`{tool="x"}`) and
 * aggregation clauses (`by (tool, outcome)`).
 */
export function extractLabelRefs(expr) {
  const labels = new Set();

  for (const [, body] of expr.matchAll(/\{([^}]*)\}/g)) {
    for (const [, key] of body.matchAll(/(\w+)\s*(?:=~|!~|!=|=)/g)) {
      labels.add(key);
    }
  }
  for (const [, , body] of expr.matchAll(/\b(by|without)\s*\(([^)]*)\)/g)) {
    for (const key of body.split(',')) {
      const trimmed = key.trim();
      if (trimmed) labels.add(trimmed);
    }
  }
  return [...labels];
}

/** Every `expr` string anywhere in a dashboard document. */
export function collectExpressions(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectExpressions(child, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'expr' && typeof value === 'string') out.push(value);
      else collectExpressions(value, out);
    }
  }
  return out;
}

/**
 * Check every dashboard in `dashboardDir` against the emitted metric set.
 *
 * ## On attributing labels to metrics
 *
 * An expression may join several metrics, and PromQL does not say which
 * `by (...)` label belongs to which. Rather than guess, a label is accepted
 * when ANY metric in the SAME expression declares it. That deliberately
 * under-constrains a multi-metric expression — the alternative is rejecting
 * correct queries, and a guard that cries wolf gets disabled, which costs more
 * than the narrow case it would catch. Single-metric panels, which are almost
 * all of them, are still checked exactly.
 */
export function check(dashboardDir, typesFile, rulesFile) {
  const metrics = parseEmittedMetrics(readFileSync(typesFile, 'utf8'));
  const errors = [];
  const referenced = new Set();
  const recordingRefs = [];
  let panels = 0;

  /**
   * Validate one PromQL expression against the emitted metric set.
   *
   * Shared by dashboards and rule files ON PURPOSE: an alert expression drifts
   * from the metrics exactly as a panel does, so checking it differently is how
   * one of the two ends up unchecked (#136 QA).
   */
  const checkExpression = (expr, where) => {
    for (const ref of extractRecordingRefs(expr)) recordingRefs.push({ ref, expr, where });

    const refs = extractMetricRefs(expr);
    if (refs.length === 0) return;

    const resolved = [];
    for (const ref of refs) {
      const base = resolveMetric(ref, metrics);
      if (base === null) {
        errors.push(
          `${where}: references '${ref}', which the runtime does not emit\n` +
            `           in: ${expr}`,
        );
      } else {
        resolved.push(base);
        referenced.add(base);
      }
    }

    // Union of the declared labels of every metric in this expression.
    const allowed = new Set(PROMETHEUS_LABELS);
    for (const base of resolved) {
      for (const label of metrics.get(base).labels) allowed.add(label);
    }
    for (const label of extractLabelRefs(expr)) {
      if (!allowed.has(label)) {
        errors.push(
          `${where}: uses label '${label}', which no metric in this expression declares\n` +
            `           in: ${expr}`,
        );
      }
    }
  };

  if (!existsSync(dashboardDir)) {
    return {
      errors: [`dashboard directory not found: ${dashboardDir}`],
      metrics, referenced, panels, files: 0, rules: 0,
    };
  }

  const files = readdirSync(dashboardDir).filter((f) => f.endsWith('.json')).sort();

  for (const file of files) {
    const full = join(dashboardDir, file);
    let doc;
    try {
      doc = JSON.parse(readFileSync(full, 'utf8'));
    } catch (err) {
      errors.push(`${file}: not valid JSON — ${err.message}`);
      continue;
    }

    for (const expr of collectExpressions(doc)) {
      panels += 1;
      checkExpression(expr, file);
    }
  }

  // Rule file. Absent is an ERROR, not a skip: the rule file IS the whole of
  // Option A divergence detection (#64), so "I could not find it" must never
  // read the same as "it is fine".
  let recorded = new Set();
  let rules = 0;
  if (rulesFile !== undefined) {
    if (!existsSync(rulesFile)) {
      errors.push(`rule file not found: ${rulesFile}`);
    } else {
      const parsed = parseRuleFile(readFileSync(rulesFile, 'utf8'));
      recorded = parsed.recorded;
      rules = parsed.expressions.length;
      const name = relative(repoRoot, rulesFile);
      for (const { expr, context } of parsed.expressions) {
        checkExpression(expr, `${name} (${context})`);
      }
    }
  }

  // A reference to a recording rule nobody defines renders an empty panel and
  // an alert that never fires — the same invisible failure, one indirection out.
  //
  // Only checked when a rule file was actually supplied. With no `rulesFile`
  // there is no basis on which to judge, and reporting every reference as
  // undefined would turn "I was not asked to check" into "this is broken" —
  // the same conflation, pointed the other way, that this guard exists to stop.
  if (rulesFile !== undefined) {
    for (const { ref, expr, where } of recordingRefs) {
      if (recorded.has(ref)) continue;
      errors.push(
        `${where}: references recording rule '${ref}', which no rule file defines\n` +
          `           in: ${expr}`,
      );
    }
  }

  return { errors, metrics, referenced, panels, files: files.length, rules };
}

// --- CLI -------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { errors, metrics, referenced, panels, files, rules } = check(
    DASHBOARD_DIR,
    TYPES_FILE,
    RULES_FILE,
  );

  for (const error of errors) console.error(`  FAIL  ${error}`);

  if (errors.length > 0) {
    console.error(
      '\nA dashboard querying a metric we do not emit renders an EMPTY panel, not an\n' +
        'error — indistinguishable from a metric that is legitimately zero. An ALERT rule\n' +
        'over a metric we do not emit is worse: it cannot fire, and an alert that cannot\n' +
        'fire looks exactly like one with nothing to report. Both are invisible until an\n' +
        'incident, which is why they are caught here.\n' +
        `Emitted metrics are declared in ${relative(repoRoot, TYPES_FILE)}.`,
    );
    console.error(
      `\n${errors.length} error(s) across ${files} dashboard(s) and ${rules} rule expression(s).`,
    );
    process.exit(1);
  }

  // Coverage is reported, NOT enforced. Not every metric deserves a panel, and
  // failing on an unpanelled metric would make adding one a chore with a CI
  // failure attached. Printing it keeps the gap visible without that.
  const uncovered = [...metrics.keys()].filter((m) => !referenced.has(m)).sort();

  console.log(
    `Dashboard metric guard: ${panels} expression(s) across ${files} dashboard(s) ` +
      `+ ${rules} rule expression(s), ` +
      `${referenced.size}/${metrics.size} emitted metrics referenced, 0 violations.`,
  );
  if (uncovered.length > 0) {
    console.log(`  note: no panel references ${uncovered.join(', ')}`);
  }
}
