#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the metric-cardinality guard (#456, closing a gap found in #431).
 *
 * Wired into `test.yml:576` with no self-test at all. Three of its four failure
 * sites are `exit(2)` — this repo's CANNOT-CHECK code — and nothing observed
 * any of them. Under #281 that is the highest-value class here: a cannot-check
 * path degrading to a silent pass is the exact defect the doctrine is named
 * for, and these three sit in `readDenylist()`, which is what stops the guard
 * silently falling back to a stale copy of the list it enforces.
 *
 * ## Why this guard needed a different technique from #455's three
 *
 * The Architect's ruling separated these because a fixture DIRECTORY cannot
 * reach them: `readDenylist()` resolved its source from `import.meta.url`, so
 * the path was fixed no matter what root the guard was pointed at. Worse, it
 * ran at MODULE SCOPE — `const DENYLIST = readDenylist()` — so importing the
 * guard in order to test it could terminate the test process before a single
 * assertion ran.
 *
 * The seam is one parameter (#349's fixture-parameter technique) plus moving
 * the call inside `check()`. The Architect's warning was to try it before
 * accepting any "unwitnessable" claim, and the warning was right: **all three
 * cannot-check paths are reachable with the path parameter ALONE.** None of
 * them needed the injected reader, and none is going in the exemption ledger.
 *
 * ## Every failure site here has been observed red
 *
 * Verified mechanically by `check-mutation-audit.mjs`, which neutralises each
 * site in turn and requires this file to fail.
 *
 * `CONTROL` marks assertions that pin already-correct behaviour and would
 * SURVIVE their site being neutralised. They are worth keeping — the matcher's
 * false-positive behaviour is half this guard's value — but they are not
 * evidence a failure path works, and QA has (rightly) attacked that conflation
 * on three consecutive PRs.
 *
 * Run: node .github/scripts/check-metric-cardinality.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, readDenylist, deniedBy, defaultDenylistPath } from './check-metric-cardinality.mjs';
import { didNotStart } from './sdk-upgrade-drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const guardPath = join(here, 'check-metric-cardinality.mjs');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check_(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed++;
  }
}

function scratch(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'metric-cardinality-'));
  tmpDirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

/** A denylist source file with the given terms. */
function denylistFile(body) {
  const dir = scratch({ 'cardinality.ts': body });
  return join(dir, 'cardinality.ts');
}

const GOOD_DENYLIST = denylistFile(
  "export const LABEL_DENYLIST: readonly string[] = ['userId', 'requestId', 'tenant'];\n",
);

/** A scan tree with one source file, so the scan itself is never empty. */
const tree = (source) => scratch({ 'pkg/src/metrics.ts': source });

/**
 * Run the guard as CI runs it, so the real exit CODE is observable.
 *
 * `check()` returns a code; `process.exit` is a separate claim. Neutralise the
 * exit call and every in-process assertion still passes — that is the trap the
 * mutation audit caught on #455's first cut, and it is why this exists.
 *
 * `process.execPath`, never the string 'node': #429 was a space-separated PATH
 * making `node` unresolvable. A child that never started FAILS rather than
 * reading as a passing exit code (#281, and the #443 `status: null` defect).
 */
function runGuard(args) {
  const result = spawnSync(process.execPath, [guardPath, ...args], { encoding: 'utf-8' });
  if (didNotStart(result)) {
    return { cannotCheck: true, why: `guard never started: ${result.error ? result.error.message : '(none reported)'}` };
  }
  return { cannotCheck: false, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function checkSpawned(desc, run, fn) {
  if (run.cannotCheck) {
    console.log(`FAIL - ${desc} (CANNOT CHECK — ${run.why})`);
    failed++;
    return;
  }
  fn();
}

// ---------------------------------------------------------------------------
// Site 1 — the denylist source cannot be read  (CANNOT CHECK, exit 2)
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 1 — denylist source unreadable (cannot-check)\n');

{
  // Reached with the PATH PARAMETER ALONE — no injected reader, no chmod. This
  // is the site the issue described as unreachable by any fixture; one
  // parameter reaches it.
  const missing = join(scratch(), 'does-not-exist.ts');
  const result = check(tree('export const x = 1;\n'), { denylistSource: missing });

  check_('CANNOT CHECK (2) when the denylist source is unreadable', result.code, 2);
  check_('...and names the path it could not read', result.message.includes(missing), true);
  check_('...and says it will not guess', result.message.includes('it will not guess'), true);
  check_('...and does NOT report a violation count as if it had scanned', result.labelsChecked, 0);
}

{
  // The same site via the injected reader, which is how a permissions failure
  // (as opposed to a missing file) would present.
  const result = check(tree('export const x = 1;\n'), {
    denylistSource: GOOD_DENYLIST,
    readFile: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  check_('CANNOT CHECK (2) when the read throws rather than the file being absent', result.code, 2);
  check_('...and quotes the underlying error', result.message.includes('EACCES'), true);
}

{
  const r = readDenylist(join(scratch(), 'nope.ts'));
  check_('readDenylist reports 2 directly, so the unit is testable on its own', r.code, 2);
}

// ---------------------------------------------------------------------------
// Site 2 — LABEL_DENYLIST absent from the source  (CANNOT CHECK, exit 2)
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 2 — LABEL_DENYLIST not found (cannot-check)\n');

{
  // The renaming case: the runtime module still exists and still compiles, but
  // the export this guard derives its terms from is gone. Falling back to a
  // copied list here is exactly how the two lists silently diverged in #136.
  const source = denylistFile("export const SOMETHING_ELSE: readonly string[] = ['userId'];\n");
  const result = check(tree('export const x = 1;\n'), { denylistSource: source });

  check_('CANNOT CHECK (2) when LABEL_DENYLIST is absent', result.code, 2);
  check_('...and names the file it looked in', result.message.includes(source), true);
  check_(
    '...and refuses to fall back to a copied list',
    result.message.includes('Refusing to fall back to a copied list'),
    true,
  );
}

{
  const source = denylistFile('// the module is empty\n');
  check_('CANNOT CHECK (2) on a source with no exports at all', check(tree('x'), { denylistSource: source }).code, 2);
}

// ---------------------------------------------------------------------------
// Site 3 — LABEL_DENYLIST present but empty  (CANNOT CHECK, exit 2)
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 3 — denylist parses as empty (cannot-check)\n');

{
  // The most dangerous of the three, and the least obvious. An empty denylist
  // matches nothing, so the guard would report "0 violations" on every label —
  // a green result that means the opposite of what a reader assumes.
  const source = denylistFile('export const LABEL_DENYLIST: readonly string[] = [];\n');
  const result = check(tree('export const x = 1;\n'), { denylistSource: source });

  check_('CANNOT CHECK (2) when the denylist parses as empty', result.code, 2);
  check_(
    '...and says an empty denylist would pass every label',
    result.message.includes('An empty denylist would pass every label'),
    true,
  );
}

{
  // Present, non-empty in the source text, but no single-quoted terms — so the
  // extractor yields nothing. Same failure, different cause.
  const source = denylistFile('export const LABEL_DENYLIST: readonly string[] = [SOME_CONST];\n');
  check_('CANNOT CHECK (2) when no terms can be extracted', check(tree('x'), { denylistSource: source }).code, 2);
}

{
  // Guards against the guard passing when it cannot see its own input: all
  // three cannot-check causes must produce 2, never 0 and never 1.
  const causes = [
    join(scratch(), 'absent.ts'),
    denylistFile('export const OTHER = 1;\n'),
    denylistFile('export const LABEL_DENYLIST: readonly string[] = [];\n'),
  ];
  const codes = causes.map((s) => check(tree('export const x = 1;\n'), { denylistSource: s }).code);
  check_('all three cannot-check causes report 2, none silently passes', codes.join(','), '2,2,2');
}

// ---------------------------------------------------------------------------
// Site 4 — a denied label actually found  (VIOLATION, exit 1)
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 4 — denied metric label detected\n');

{
  const result = check(tree("counter.add(METRIC.Requests, 1, { userId: id });\n"), {
    denylistSource: GOOD_DENYLIST,
  });

  check_('FAILS on a denied label at a call site', result.code, 1);
  check_('...and names the label', result.message.includes("'userId'"), true);
  check_('...and names the denylist term it matched', result.message.includes("denylist term 'userId'"), true);
  check_('...and counts one error', result.errors, 1);
  check_('...and explains the consequence', result.message.includes('new time series'), true);
}

{
  const result = check(tree("export const M = [{ name: 'x', labels: ['tenant'] }];\n"), {
    denylistSource: GOOD_DENYLIST,
  });
  check_('FAILS on a denied label in a METRIC_DEFINITIONS declaration', result.code, 1);
}

{
  // The normalisation this guard exists for: the denylist says `requestId`,
  // real code writes `request_id`. A literal match would miss it entirely.
  const result = check(tree("counter.add(METRIC.R, 1, { request_id: r });\n"), {
    denylistSource: GOOD_DENYLIST,
  });
  check_('FAILS on a snake_case spelling of a camelCase denylist term', result.code, 1);
}

{
  const result = check(tree("counter.add(METRIC.R, 1, { user_id: a, tenant: b });\n"), {
    denylistSource: GOOD_DENYLIST,
  });
  check_('every denied label is reported, not just the first', result.errors, 2);
}

// ---------------------------------------------------------------------------
// The matcher — CONTROLs that keep the guard from crying wolf
// ---------------------------------------------------------------------------

console.log('\n# CONTROL: the matcher\n');

const TERMS = ['userId', 'requestId', 'tenant'];

check_('CONTROL: an exact term is denied', deniedBy('userId', TERMS), 'userId');
check_('CONTROL: normalisation crosses snake_case', deniedBy('user_id', TERMS), 'userId');
check_('CONTROL: normalisation crosses kebab-case', deniedBy('user-id', TERMS), 'userId');
check_('CONTROL: a compound label is denied by its part', deniedBy('http_tenant_name', TERMS), 'tenant');
check_('CONTROL: an unrelated label is allowed', deniedBy('tool_name', TERMS), null);
check_('CONTROL: a bounded label is allowed', deniedBy('status_code', TERMS), null);

{
  const result = check(tree("counter.add(METRIC.R, 1, { tool_name: t, status: s });\n"), {
    denylistSource: GOOD_DENYLIST,
  });
  check_('CONTROL: a tree with only allowed labels passes', result.code, 0);
  check_('...and reports what it checked rather than only that it passed', result.labelsChecked, 2);
}

{
  const result = check(tree('export const unrelated = 1;\n'), { denylistSource: GOOD_DENYLIST });
  check_('CONTROL: a file mentioning no metrics is skipped', result.scanned, 0);
}

// ---------------------------------------------------------------------------
// The exit code CI reads
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: the guard process exit code\n');

{
  const run = runGuard([tree("counter.add(METRIC.R, 1, { userId: u });\n")]);
  checkSpawned('the guard PROCESS exits 1 on a violation', run, () => {
    check_('the guard PROCESS exits 1 on a violation', run.status, 1);
    check_('...and reports on stderr', run.stderr.includes('userId'), true);
  });
}

{
  const run = runGuard([tree("counter.add(METRIC.R, 1, { tool_name: t });\n")]);
  checkSpawned('CONTROL: the guard PROCESS exits 0 on a clean tree', run, () => {
    check_('CONTROL: the guard PROCESS exits 0 on a clean tree', run.status, 0);
  });
}

// ---------------------------------------------------------------------------
// The real repository
// ---------------------------------------------------------------------------

console.log('\n# this repository\n');

{
  // The production default must still resolve, or every run above would be
  // testing a path the guard never actually uses.
  const real = readDenylist(defaultDenylistPath());
  check_('CONTROL: the real denylist source resolves and parses', real.code, 0);
  check_('CONTROL: and yields a non-empty term list', real.terms.length > 0, true);
}

{
  const result = check(join(repoRoot, 'packages'));
  check_('CONTROL: the repository passes its own guard', result.code, 0);
  // A scan that collapsed to nothing would also report 0; assert the coverage
  // is real so a broken walk cannot look healthy.
  check_('CONTROL: and the scan actually examined labels', result.labelsChecked > 10, true);
}

// ---------------------------------------------------------------------------

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${String(passed)} passed, ${String(failed)} failed\n`);
process.exit(failed === 0 ? 0 : 1);
