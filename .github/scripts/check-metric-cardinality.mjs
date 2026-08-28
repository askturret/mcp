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

import { isProcessEntryPoint } from './lib/entry-point.mjs';

/**
 * Where the denylist is read FROM, by default.
 *
 * Resolved from this file's own location rather than from the scan root,
 * because the denylist lives at a fixed place in the repository and the scan
 * root is a parameter. That is correct for production and is exactly what made
 * the three cannot-check paths below unwitnessable: no fixture directory can
 * change this path, so nothing could ever provoke a read failure (#456).
 *
 * `check()` therefore takes it as a parameter defaulting to this — #349's
 * fixture-parameter technique. The production path is unchanged; the test can
 * point it at a fixture.
 */
export function defaultDenylistPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../packages/core/src/telemetry/cardinality.ts');
}

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
export function readDenylist(source = defaultDenylistPath(), readFile = readFileSync) {
  let contents;
  try {
    contents = readFile(source, 'utf-8');
  } catch (error) {
    return {
      code: 2,
      message:
        `Could not read the denylist source at ${source}: ${error.message}\n` +
        'This guard derives its terms from that file; it will not guess.',
    };
  }

  const block = /export const LABEL_DENYLIST:[^=]*=\s*\[([^\]]*)\]/.exec(contents);
  if (!block) {
    return {
      code: 2,
      message:
        `Could not find LABEL_DENYLIST in ${source}.\n` +
        'Refusing to fall back to a copied list — that is how the two drift apart.',
    };
  }

  const terms = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (terms.length === 0) {
    return {
      code: 2,
      message:
        `LABEL_DENYLIST in ${source} parsed as empty.\n` +
        'An empty denylist would pass every label, so this fails instead.',
    };
  }

  return { code: 0, terms };
}

/**
 * Normalized comparison, matching `normalizeLabel` in
 * packages/core/src/telemetry/cardinality.ts.
 *
 * The denylist mixes conventions (`requestId` camelCase; real labels are
 * snake_case), so a literal match would miss `request_id` — the spelling an
 * implementation would actually use.
 */
const normalize = (s) => s.toLowerCase().replace(/[_\-.\s]/g, '');

function splitParts(label) {
  return label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-.\s]+/)
    .filter(Boolean);
}

/** Exported so the matcher can be exercised directly, as check-codeowners does. */
export function deniedBy(label, denylist) {
  const normalized = denylist.map(normalize);
  if (normalized.includes(normalize(label))) {
    return denylist[normalized.indexOf(normalize(label))];
  }
  for (const part of splitParts(label)) {
    const idx = normalized.indexOf(normalize(part));
    if (idx !== -1) return denylist[idx];
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

/**
 * Scan `rootDir` for metric labels matching the §9.2 denylist.
 *
 * Exported so the self-test can reach the failure sites (#456). Two things had
 * to change before that was possible, and only one of them is the usual seam:
 *
 *   1. `readDenylist()` ran at MODULE SCOPE (`const DENYLIST = readDenylist()`),
 *      so importing this file could `process.exit(2)` before a test executed a
 *      single line. There was no way to import the guard in order to test it.
 *   2. Its source path came from `import.meta.url`, so no fixture could reach
 *      any of its three cannot-check paths (#456).
 *
 * @param {string} rootDir - tree to scan. Defaults to `packages`.
 * @param {object} [options]
 * @param {string} [options.denylistSource] - path to read LABEL_DENYLIST from.
 *   Defaults to the real runtime module. This is the #349 fixture parameter.
 * @param {(path: string, enc: string) => string} [options.readFile=readFileSync]
 *   injectable reader, so the unreadable-source path is witnessable without
 *   `chmod 000` (a no-op as root, which would make the witness vacuous on the
 *   CI images most likely to run it).
 * @param {string} [options.cwd] - base for reported relative paths. Defaults to
 *   `process.cwd()`, matching the previous behaviour.
 * @returns {{code: number, message: string, errors: number, scanned: number, labelsChecked: number}}
 *   `code` is 2 for cannot-check, 1 for violations found, 0 for clean.
 */
export function check(rootDir = 'packages', options = {}) {
  const {
    denylistSource = defaultDenylistPath(),
    readFile = readFileSync,
    cwd = process.cwd(),
  } = options;

  const denylistResult = readDenylist(denylistSource, readFile);
  if (denylistResult.code !== 0) {
    // Cannot check. PROPAGATED, not re-stated as a literal 2 — for two reasons.
    // A hardcoded 2 here would flatten any future non-2 code `readDenylist`
    // learned to return, and it would add a mutation site that duplicates one
    // already witnessed rather than covering a distinct path.
    //
    // Note this is the OPPOSITE call to the one taken in check-nul-bytes on
    // #455, where three failure paths were deliberately given their own literal
    // rather than a shared helper. The distinction is whether the sites are
    // different PATHS or the same path written twice: there they were three
    // genuinely independent branches, here it is one branch relayed. Per-site
    // witnessing is worth repetition; it is not worth duplication.
    return {
      code: denylistResult.code,
      message: denylistResult.message,
      errors: 0,
      scanned: 0,
      labelsChecked: 0,
    };
  }
  const denylist = denylistResult.terms;

  const out = [];
  let errors = 0;
  let scanned = 0;
  let labelsChecked = 0;

  for (const file of walk(rootDir)) {
    const source = readFile(file, 'utf8');
    if (!source.includes('METRIC') && !source.includes('labels:')) continue;

    scanned += 1;
    for (const { label, line } of [...declaredLabels(source), ...callSiteLabels(source)]) {
      labelsChecked += 1;
      const matched = deniedBy(label, denylist);
      if (matched !== null) {
        out.push(
          `  FAIL  ${relative(cwd, file)}:${line}  metric label '${label}' ` +
            `matches denylist term '${matched}'`,
        );
        errors += 1;
      }
    }
  }

  if (errors > 0) {
    out.push(
      '\nHigh-cardinality metric labels are forbidden (§9.2). Each distinct value of ' +
        'an unbounded label creates a new time series, which is how a metrics backend ' +
        'falls over. Tool names are bounded by the registry and are allowed; user, ' +
        'tenant, request ID and raw input values are not.',
      `${errors} error(s) across ${scanned} file(s).`,
    );
    return { code: 1, message: out.join('\n'), errors, scanned, labelsChecked };
  }

  out.push(
    `Metric cardinality guard: ${labelsChecked} label(s) across ${scanned} file(s), 0 violations.`,
  );
  return { code: 0, message: out.join('\n'), errors, scanned, labelsChecked };
}

if (isProcessEntryPoint(import.meta.url)) {
  const result = check(process.argv[2] ?? 'packages');
  if (result.code === 0) console.log(result.message);
  else console.error(result.message);
  process.exit(result.code);
}
