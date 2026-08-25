#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Readiness matrix gate (#65 / §17, extracted from test.yml by #269).
 *
 * Verifies that every numbered row of `docs/readiness.md` reads "✅ met".
 *
 * ## Why this is a script rather than inline bash
 *
 * It has two callers with different consequences, and one implementation is
 * the only way they cannot drift apart:
 *
 *   - `test.yml` runs it on every PR and push to `main` — a COMMIT-TIME gate.
 *   - `supply-chain.yml` runs it on `release: published` — a RELEASE-TIME gate,
 *     which `publish` depends on via `needs:`, so a red matrix refuses
 *     publication of a `1.0.*` release.
 *
 * Note what is NOT claimed: nothing here blocks a tag. GitHub Actions runs
 * after a ref exists, so a tag-triggered workflow can only fail a run
 * afterwards — it cannot refuse the tag. Publication is the gated act. See
 * docs/releasing.md.
 *
 * ## Modes
 *
 *   --advisory   report the verdict and exit 0 regardless. Used for `0.x`
 *                releases, which the matrix does not certify: readiness.md
 *                certifies 1.0 readiness, and compatibility-policy.md is
 *                explicit that 0.x carries no compatibility guarantee at all.
 *
 * Writes `met`, `total` and `ok` to $GITHUB_OUTPUT when set, and a human
 * summary to $GITHUB_STEP_SUMMARY when set.
 *
 * Run: node .github/scripts/check-readiness-matrix.mjs [--advisory] [--file PATH]
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The matrix certifies exactly this many criteria. See anti-vacuity below. */
export const EXPECTED_ROWS = 12;

const DEFAULT_FILE = 'docs/readiness.md';

/**
 * Count the matrix rows and how many are met.
 *
 * Count only NUMBERED MATRIX ROWS ('| 4 | ...'), never a bare
 * occurrence of the marker. A plain `grep "✅ met" | wc -l` also counts
 * the prose line that DESCRIBES the gate ("verifies all rows are
 * ✅ met"), so 11 met rows plus that sentence summed to 12 and the gate
 * passed with a criterion still unmet — a false pass that reads exactly
 * like a real one in the CI log.
 */
export function parseMatrix(markdown) {
  const rowPattern = /^\| [0-9]+ \|/;
  const metPattern = /^\| [0-9]+ \|.*✅ met/;

  const rows = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!rowPattern.test(text)) continue;
    rows.push({ line: i + 1, text, met: metPattern.test(text) });
  }

  return {
    total: rows.length,
    met: rows.filter((r) => r.met).length,
    unmet: rows.filter((r) => !r.met),
  };
}

/**
 * Decide whether the matrix passes, and say why if it does not.
 *
 * Returns `{ ok, total, met, unmet, errors }`. Never throws and never exits —
 * that is `main`'s job, so the caller can choose advisory or blocking.
 */
export function evaluate(markdown, expectedRows = EXPECTED_ROWS) {
  const { total, met, unmet } = parseMatrix(markdown);
  const errors = [];

  // Anti-vacuity: an empty or restructured table must FAIL, not pass by
  // having nothing to disagree with.
  if (total !== expectedRows) {
    errors.push(`expected ${expectedRows} criterion rows in the readiness matrix, found ${total}`);
  }

  // Equality, not '-lt': the gate must not be satisfiable by adding rows.
  if (met !== total) {
    errors.push(
      `only ${met} of ${total} criteria marked '✅ met' (all ${total} required for 1.0)`,
    );
  }

  return { ok: errors.length === 0, total, met, unmet, errors };
}

function emit(name, value) {
  const file = process.env[name];
  if (!file) return;
  appendFileSync(file, value);
}

function main() {
  const argv = process.argv.slice(2);
  const advisory = argv.includes('--advisory');
  const fileIndex = argv.indexOf('--file');
  const file = fileIndex === -1 ? DEFAULT_FILE : argv[fileIndex + 1];

  if (!existsSync(file)) {
    console.error(`ERROR: ${file} is missing`);
    process.exit(advisory ? 0 : 1);
  }

  const result = evaluate(readFileSync(file, 'utf8'));

  // The structured output docs/readiness.md's Verification 4 claims. Written
  // unconditionally on both paths so the claim is true of every run, not only
  // of the ones that fail.
  emit(
    'GITHUB_OUTPUT',
    `met=${result.met}\ntotal=${result.total}\nok=${result.ok}\n`,
  );

  const mode = advisory ? 'advisory' : 'blocking';
  const verdict = result.ok
    ? `Readiness gate: ${result.met}/${result.total} criteria met`
    : `Readiness gate FAILED (${mode}): ${result.errors.join('; ')}`;

  emit(
    'GITHUB_STEP_SUMMARY',
    `### Readiness matrix (${mode})\n\n${verdict}\n\n` +
      result.unmet.map((r) => `- line ${r.line}: ${r.text}\n`).join(''),
  );

  if (result.ok) {
    console.log(verdict);
    return;
  }

  for (const err of result.errors) console.error(`ERROR: ${err}`);
  for (const row of result.unmet) console.error(`${row.line}:${row.text}`);

  if (advisory) {
    // A 0.x release is allowed to ship on a red matrix, but it does not get to
    // do so quietly — saying so in the summary is the whole point of the mode.
    console.log('Advisory mode: not blocking this release. The matrix is red and shipping anyway.');
    return;
  }
  process.exit(1);
}

// Only run when invoked directly, so the parsing helpers can be imported by
// tests without executing the gate.
if (process.argv[1] && resolve(process.argv[1]).endsWith('check-readiness-matrix.mjs')) {
  main();
}
