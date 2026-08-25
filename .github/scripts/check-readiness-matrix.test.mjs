#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the readiness matrix gate (#269).
 *
 * This gate decides whether a 1.0 release publishes, so it is verified before
 * it is trusted — the same reasoning as check-licenses.test.mjs.
 *
 * Two properties here were learned from a REAL false pass and are the reason
 * this file exists rather than being assumed:
 *
 *   1. Only numbered rows count. A bare marker match also caught the prose
 *      line describing the gate, and 11 met rows plus that sentence summed to
 *      12 — a green gate with a criterion unmet.
 *   2. Equality, not "at least". A gate satisfiable by ADDING rows is not a
 *      gate, and an emptied table must fail rather than pass vacuously.
 *
 * The CLI is exercised through a SUBPROCESS rather than by calling `evaluate`
 * again: the workflows invoke the binary, and a unit-green evaluator proves
 * nothing about exit codes, --advisory, or the $GITHUB_OUTPUT write.
 *
 * Run: node .github/scripts/check-readiness-matrix.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMatrix, evaluate, EXPECTED_ROWS } from './check-readiness-matrix.mjs';

let passed = 0;
let failed = 0;

function check(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

/** A matrix of `n` rows, the first `met` of which are met. */
function matrix(n, met = n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push(`| ${i} | Criterion ${i} | ${i <= met ? '✅ met' : '❌ not met'} | evidence |`);
  }
  return ['| # | Criterion | Status | Evidence |', '|---|---|---|---|', ...rows].join('\n');
}

// --- the historical false pass ---------------------------------------------
// 11 met rows plus a prose sentence containing the marker. A bare marker count
// returns 12 here and the gate goes green with criterion 12 unmet.
const falsePassDoc = [
  matrix(EXPECTED_ROWS, EXPECTED_ROWS - 1),
  '',
  'On every commit to `main`, CI verifies all rows are ✅ met.',
].join('\n');

check('prose containing the marker is not counted as a row', parseMatrix(falsePassDoc).total, EXPECTED_ROWS);
check('prose containing the marker is not counted as met', parseMatrix(falsePassDoc).met, EXPECTED_ROWS - 1);
check('the historical false pass now fails', evaluate(falsePassDoc).ok, false);

// A document that is ONLY the prose line must not look like a passing matrix.
const proseOnly = 'CI verifies all rows are ✅ met.\n';
check('a prose-only document has no rows', parseMatrix(proseOnly).total, 0);
check('a prose-only document fails', evaluate(proseOnly).ok, false);

// --- equality, not "at least" ----------------------------------------------
check('a full matrix passes', evaluate(matrix(EXPECTED_ROWS)).ok, true);
check('one unmet row fails', evaluate(matrix(EXPECTED_ROWS, EXPECTED_ROWS - 1)).ok, false);
check('adding a 13th met row fails rather than helping', evaluate(matrix(EXPECTED_ROWS + 1)).ok, false);
check('removing a row fails', evaluate(matrix(EXPECTED_ROWS - 1)).ok, false);

// --- anti-vacuity ----------------------------------------------------------
check('an empty document fails', evaluate('').ok, false);
check('a table with no numbered rows fails', evaluate('| # | Criterion |\n|---|---|\n').ok, false);
check(
  'an emptied table reports the row count, not just "unmet"',
  evaluate('').errors[0],
  `expected ${EXPECTED_ROWS} criterion rows in the readiness matrix, found 0`,
);

// --- row shape -------------------------------------------------------------
// Faithful to the original grep: anchored, one space, digits, one space, pipe.
check('an indented row is not a row', parseMatrix('  | 1 | x | ✅ met |').total, 0);
check('a non-numeric first cell is not a row', parseMatrix('| a | x | ✅ met |').total, 0);
check('a multi-digit row number counts', parseMatrix('| 10 | x | ✅ met |').total, 1);

// --- unmet rows are reported so a human can act ----------------------------
const oneShort = evaluate(matrix(EXPECTED_ROWS, EXPECTED_ROWS - 1));
check('the unmet row is surfaced', oneShort.unmet.length, 1);
check('the unmet row carries its line number', typeof oneShort.unmet[0].line, 'number');

// --- the CLI, via subprocess ------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'check-readiness-matrix.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'readiness-'));

function runCli(doc, args = []) {
  const file = join(tmp, `m-${Math.abs(doc.length + args.join().length)}-${args.length}.md`);
  writeFileSync(file, doc);
  const outFile = join(tmp, `out-${args.length}-${doc.length}.txt`);
  writeFileSync(outFile, '');
  const res = spawnSync(process.execPath, [script, '--file', file, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: '' },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, output: readFileSync(outFile, 'utf8') };
}

const green = runCli(matrix(EXPECTED_ROWS));
check('CLI exits 0 on a full matrix', green.status, 0);

const red = runCli(matrix(EXPECTED_ROWS, EXPECTED_ROWS - 1));
check('CLI exits 1 on a red matrix', red.status, 1);

const redAdvisory = runCli(matrix(EXPECTED_ROWS, EXPECTED_ROWS - 1), ['--advisory']);
check('CLI exits 0 on a red matrix in advisory mode', redAdvisory.status, 0);
check(
  'advisory mode still says the matrix is red',
  redAdvisory.stdout.includes('not blocking this release'),
  true,
);

// Verification 4's "structured output" claim — asserted against the file the
// workflow would read, not against a return value.
check('CLI writes ok=true to GITHUB_OUTPUT when green', green.output.includes('ok=true'), true);
check('CLI writes ok=false to GITHUB_OUTPUT when red', red.output.includes('ok=false'), true);
check('CLI writes the met count', green.output.includes(`met=${EXPECTED_ROWS}`), true);
check('CLI writes the total', green.output.includes(`total=${EXPECTED_ROWS}`), true);
check(
  'advisory mode writes ok=false even though it exits 0',
  redAdvisory.output.includes('ok=false'),
  true,
);

// A missing file must fail the blocking gate rather than pass by absence.
const missing = spawnSync(process.execPath, [script, '--file', join(tmp, 'nope.md')], { encoding: 'utf8' });
check('CLI exits 1 when the file is missing', missing.status, 1);

// --- the real document ------------------------------------------------------
// The gate's actual subject. If this ever fails, the repository is genuinely
// not 1.0-ready — which is the gate working, not the test being wrong.
const realDoc = join(here, '..', '..', 'docs', 'readiness.md');
if (existsSync(realDoc)) {
  const real = evaluate(readFileSync(realDoc, 'utf8'));
  check('docs/readiness.md parses as 12 rows', real.total, EXPECTED_ROWS);
  check('docs/readiness.md is all met', real.ok, true);
}

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
