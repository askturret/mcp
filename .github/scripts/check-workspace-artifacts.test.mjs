#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the #324 workspace-artifact composite check.
 *
 * The guard's whole reason to exist is that it reports EVERY finding in one
 * run, so these cover each drift case independently and both together:
 *
 *   - lockfile drifted only        -> exit 1, names package-lock.json
 *   - NOTICE drifted only          -> exit 1, names NOTICE
 *   - both drifted                 -> exit 1, names BOTH in one report
 *   - nothing drifted              -> exit 0
 *
 * The fourth case is not filler. A guard that reports both only when both are
 * broken has not been shown capable of passing either, and a guard that can
 * never pass gets switched off.
 *
 * Three more cover the properties a future "simplification" would break:
 *
 *   - every runner is INVOKED even after an earlier one fails. Asserting on
 *     the report alone would pass a guard that short-circuits and prints a
 *     stale summary, so this counts calls rather than reading output.
 *   - `unknown` is never a pass: clean + one unevaluable item exits 2, not 0.
 *   - a runner that THROWS becomes `unknown`, not an accidental pass.
 *
 * And one end-to-end case runs the REAL CLI, so the exported logic and the
 * shipped binary cannot drift apart — a self-test that only ever exercises an
 * exported function would keep passing if the entry point were broken.
 *
 * Run: node .github/scripts/check-workspace-artifacts.test.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { runChecks, formatReport, PASS, FAIL, UNKNOWN } from './check-workspace-artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-workspace-artifacts.mjs');

let passed = 0;
let failed = 0;

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed++;
  }
}

function ok(desc, condition) {
  check(desc, Boolean(condition), true);
}

/** Build a fake check whose result is fixed, and record that it ran. */
function fake(name, artifact, status, calls) {
  return {
    name,
    artifact,
    run: () => {
      calls.push(name);
      return { status, detail: status === FAIL ? 'drifted' : '' };
    },
  };
}

function scenario({ lockfile, notice, licences }) {
  const calls = [];
  const { results, code } = runChecks([
    fake('lockfile', 'package-lock.json', lockfile, calls),
    fake('notice', 'NOTICE', notice, calls),
    fake('licences', 'licence policy', licences, calls),
  ]);
  return { results, code, calls, report: formatReport(results) };
}

// ---------------------------------------------------------------------------
// The four drift combinations
// ---------------------------------------------------------------------------

const lockOnly = scenario({ lockfile: FAIL, notice: PASS, licences: PASS });
check('lockfile drifted only -> exit 1', lockOnly.code, 1);
ok('lockfile drifted only -> report names package-lock.json', lockOnly.report.includes('package-lock.json'));
ok('lockfile drifted only -> report does NOT call NOTICE drifted', !/DRIFTED\s+NOTICE/.test(lockOnly.report));

const noticeOnly = scenario({ lockfile: PASS, notice: FAIL, licences: PASS });
check('NOTICE drifted only -> exit 1', noticeOnly.code, 1);
ok('NOTICE drifted only -> report names NOTICE', noticeOnly.report.includes('NOTICE'));
ok(
  'NOTICE drifted only -> report does NOT call package-lock.json drifted',
  !/DRIFTED\s+package-lock\.json/.test(noticeOnly.report),
);

// The central case: this is the issue.
const both = scenario({ lockfile: FAIL, notice: FAIL, licences: PASS });
check('both drifted -> exit 1', both.code, 1);
ok('both drifted -> ONE report names package-lock.json', both.report.includes('package-lock.json'));
ok('both drifted -> the SAME report names NOTICE', both.report.includes('NOTICE'));
check('both drifted -> both counted together', both.results.filter((r) => r.status === FAIL).length, 2);

const clean = scenario({ lockfile: PASS, notice: PASS, licences: PASS });
check('nothing drifted -> exit 0', clean.code, 0);
ok('nothing drifted -> report says so', clean.report.includes('up to date'));

// ---------------------------------------------------------------------------
// No short-circuit — asserted by INVOCATION, not by output
// ---------------------------------------------------------------------------

check('first item failing still runs the rest', both.calls.length, 3);
check('...and in order', both.calls.join(','), 'lockfile,notice,licences');
check('all three fail -> still three invocations', scenario({ lockfile: FAIL, notice: FAIL, licences: FAIL }).calls.length, 3);

// ---------------------------------------------------------------------------
// "Could not check" is never a pass
// ---------------------------------------------------------------------------

const unevaluable = scenario({ lockfile: PASS, notice: PASS, licences: UNKNOWN });
check('clean but one item unevaluable -> exit 2, NOT 0', unevaluable.code, 2);
ok('...and the report says COULD NOT CHECK', unevaluable.report.includes('COULD NOT CHECK'));
ok('...and does not claim everything is up to date', !unevaluable.report.includes('are up to date'));

const failBeatsUnknown = scenario({ lockfile: FAIL, notice: PASS, licences: UNKNOWN });
check('a known drift outranks an unevaluable item -> exit 1', failBeatsUnknown.code, 1);

const thrower = runChecks([
  {
    name: 'boom',
    artifact: 'exploding artifact',
    run: () => {
      throw new Error('inventory unreadable');
    },
  },
]);
check('a runner that throws -> exit 2, never 0', thrower.code, 2);
check('...recorded as unknown', thrower.results[0].status, UNKNOWN);

// ---------------------------------------------------------------------------
// End-to-end through the real CLI
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'ws-artifacts-'));
try {
  // An empty directory has no package.json, no NOTICE and no node_modules, so
  // nothing here can be evaluated. The one answer that must NOT come back is 0.
  // process.execPath, never a bare `node` (#361) — the guard suite asserts this,
  // because a bare `node` resolves against PATH and can be a different runtime
  // than the one running the test.
  const res = spawnSync(process.execPath, [GUARD, scratch], { encoding: 'utf8' });
  ok('real CLI on an unevaluable tree -> non-zero', res.status !== 0);
  ok('real CLI reports COULD NOT CHECK rather than passing', `${res.stdout}`.includes('COULD NOT CHECK'));
  ok('real CLI names the licence item explicitly', `${res.stdout}`.includes('licence policy'));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
