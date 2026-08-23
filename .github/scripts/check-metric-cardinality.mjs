#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * CI cardinality guard (#39, §9.2 "add a CI test that enumerates label sets
 * across all emitted metrics and fails if any label matches a denylist";
 * §17 criterion 8).
 *
 * ## Why this parses source instead of importing the built module
 *
 * The guard must run even when the build is broken — that is exactly when a
 * bad label is most likely to be sitting in the tree. Importing `dist` would
 * make the guard depend on the thing it is guarding, so a compile error would
 * silently skip it rather than fail it.
 *
 * It also catches labels passed at CALL SITES, which the declaration table
 * cannot see: `metrics.add(METRIC.x, 1, { user_id: ... })` never appears in
 * METRIC_DEFINITIONS.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Scan root. Defaults to `packages`; an explicit argument keeps this guard
 * testable the same way the others are (check-guards.test.mjs passes a
 * throwaway directory).
 */
const ROOTS = [process.argv[2] ?? 'packages'];

/** §9.2 denylist, verbatim. */
const DENYLIST = [
  'user',
  'tenant',
  'principal',
  'email',
  'sub',
  'requestId',
  'input',
  'arg',
];

/**
 * Normalized comparison, matching `normalizeLabel` in
 * packages/core/src/telemetry/cardinality.ts.
 *
 * The denylist mixes conventions (`requestId` camelCase; real labels are
 * snake_case), so a literal match would miss `request_id` — the spelling an
 * implementation would actually use.
 */
const normalize = (s) => s.toLowerCase().replace(/[_\-.\s]/g, '');
const NORMALIZED = DENYLIST.map(normalize);

function splitParts(label) {
  return label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-.\s]+/)
    .filter(Boolean);
}

function deniedBy(label) {
  if (NORMALIZED.includes(normalize(label))) {
    return DENYLIST[NORMALIZED.indexOf(normalize(label))];
  }
  for (const part of splitParts(label)) {
    const idx = NORMALIZED.indexOf(normalize(part));
    if (idx !== -1) return DENYLIST[idx];
  }
  return null;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      yield full;
    }
  }
}

/**
 * Label keys declared in METRIC_DEFINITIONS entries: `labels: ['a', 'b']`.
 */
function declaredLabels(source) {
  const found = [];
  const re = /labels:\s*\[([^\]]*)\]/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const line = source.slice(0, match.index).split('\n').length;
    for (const raw of match[1].split(',')) {
      const label = raw.trim().replace(/^['"`]|['"`]$/g, '');
      if (label.length > 0) found.push({ label, line });
    }
  }
  return found;
}

/**
 * Label keys passed at metric call sites: `.add(NAME, value, { k: v })`.
 */
function callSiteLabels(source) {
  const found = [];
  const re = /\.(?:add|record|set)\(\s*METRIC\.[A-Za-z]+\s*,[^,]*,\s*\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const line = source.slice(0, match.index).split('\n').length;
    for (const pair of match[1].split(',')) {
      const key = pair.split(':')[0]?.trim().replace(/^['"`]|['"`]$/g, '');
      if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) found.push({ label: key, line });
    }
  }
  return found;
}

let errors = 0;
let scanned = 0;
let labelsChecked = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('METRIC') && !source.includes('labels:')) continue;

    scanned += 1;
    for (const { label, line } of [...declaredLabels(source), ...callSiteLabels(source)]) {
      labelsChecked += 1;
      const matched = deniedBy(label);
      if (matched !== null) {
        console.error(
          `  FAIL  ${relative(process.cwd(), file)}:${line}  metric label '${label}' ` +
            `matches denylist term '${matched}'`,
        );
        errors += 1;
      }
    }
  }
}

if (errors > 0) {
  console.error(
    '\nHigh-cardinality metric labels are forbidden (§9.2). Each distinct value of ' +
      'an unbounded label creates a new time series, which is how a metrics backend ' +
      'falls over. Tool names are bounded by the registry and are allowed; user, ' +
      'tenant, request ID and raw input values are not.',
  );
  console.error(`${errors} error(s) across ${scanned} file(s).`);
  process.exit(1);
}

console.log(
  `Metric cardinality guard: ${labelsChecked} label(s) across ${scanned} file(s), 0 violations.`,
);
