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
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Scan root. Defaults to `packages`; an explicit argument keeps this guard
 * testable the same way the others are (check-guards.test.mjs passes a
 * throwaway directory).
 */
const ROOTS = [process.argv[2] ?? 'packages'];

/**
 * The §9.2 denylist, READ FROM the runtime module rather than copied.
 *
 * ## Why it is extracted by regex and not imported
 *
 * Importing would mean importing `dist`, and the whole reason this guard parses
 * source is that it must run when the build is broken. So it reads the array
 * literal out of the TypeScript source instead — no build, one definition.
 *
 * ## Why it is not simply duplicated (#136)
 *
 * It was. There were two hand-maintained copies of these terms, and the comment
 * on the second even pointed at the first. They agreed until they did not:
 * `hash` was added to the runtime list to close an unbounded-cardinality label,
 * every unit test went green, and THIS guard — the one CI runs, and the one
 * readiness criterion 8 cites as evidence — still passed the reintroduced
 * label. A guard that reports "0 violations" against a list it has not been
 * told about is worse than no guard, because it is quoted as proof.
 *
 * Extraction failure is FATAL rather than a fallback to a hardcoded copy. A
 * fallback is how this silently returns to two lists.
 */
function readDenylist() {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = resolve(here, '../../packages/core/src/telemetry/cardinality.ts');

  let contents;
  try {
    contents = readFileSync(source, 'utf-8');
  } catch (error) {
    console.error(`Could not read the denylist source at ${source}: ${error.message}`);
    console.error('This guard derives its terms from that file; it will not guess.');
    process.exit(2);
  }

  const block = /export const LABEL_DENYLIST:[^=]*=\s*\[([^\]]*)\]/.exec(contents);
  if (!block) {
    console.error(`Could not find LABEL_DENYLIST in ${source}.`);
    console.error('Refusing to fall back to a copied list — that is how the two drift apart.');
    process.exit(2);
  }

  const terms = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (terms.length === 0) {
    console.error(`LABEL_DENYLIST in ${source} parsed as empty.`);
    console.error('An empty denylist would pass every label, so this fails instead.');
    process.exit(2);
  }

  return terms;
}

const DENYLIST = readDenylist();

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
