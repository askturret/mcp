#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the NUL-byte guard (#455, closing a gap found in #431).
 *
 * Wired into `test.yml:569` with **no self-test at all**. Four failure paths,
 * none of them ever executed by anything — so a guard that had stopped
 * detecting NUL bytes would have gone on reporting "No NUL bytes found" and
 * nothing would have contradicted it.
 *
 * That matters more here than the file count suggests. This guard exists
 * *because* tsc, jest and every other check in the repo PASS with a NUL
 * present: it is the only thing looking at the bytes. A silent failure has no
 * second line of defence.
 *
 * ## Every failure site here has been observed red
 *
 * Each `WITNESS` was built by neutralising its site and confirming this file
 * turns red — verified mechanically by `check-mutation-audit.mjs`, which
 * neutralises each site in turn and requires the self-test to fail.
 *
 * Assertions labelled `CONTROL` pin behaviour that is already correct and would
 * survive their site being neutralised. They guard against over-correction into
 * false positives, but they are NOT evidence a failure path works. Keeping the
 * two apart is the whole subject of #431.
 *
 * Run: node .github/scripts/check-nul-bytes.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check } from './check-nul-bytes.mjs';
import { didNotStart } from './sdk-upgrade-drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const guardPath = join(here, 'check-nul-bytes.mjs');

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

/**
 * A tree with every REQUIRED scan root present, so a test aimed at one failure
 * site is not answered by the missing-root site firing first.
 */
function scratch({ roots = ['packages', 'examples', 'docs', '.github'], files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nul-bytes-'));
  tmpDirs.push(dir);
  for (const root of roots) mkdirSync(join(dir, root), { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

/** A tree with one clean source file, so scans are non-empty by default. */
const populated = (extra = {}) =>
  scratch({ files: { 'packages/a/src/index.ts': 'export const a = 1;\n', ...extra } });

/**
 * Run the guard as CI runs it, so the real exit code is observable.
 *
 * `check()` cannot witness `process.exit` — neutralise that call and every
 * in-process assertion still passes. `process.execPath` rather than `'node'`
 * because #429 was a space-separated PATH making `node` unresolvable, and a
 * self-test is the last place that should depend on PATH. A child that never
 * starts FAILS this file rather than reading as a passing exit code (#281,
 * and the #443 `status: null` defect).
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
// Site 1 — a missing REQUIRED scan root, under --require-roots
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 1 — missing required scan root\n');

{
  // The real hazard #121 is about: `packages/` is RENAMED, so the guard's main
  // body of coverage silently disappears while it carries on reporting success
  // on whatever is left.
  const dir = scratch({ roots: ['examples', 'docs', '.github'], files: { 'docs/a.md': 'ok\n' } });
  const result = check(dir, { requireRoots: true });

  check_('FAILS when a required scan root is missing', result.code, 1);
  check_('...and names the missing root', result.message.includes('packages'), true);
  check_('...and marks it REQUIRED', result.message.includes('REQUIRED'), true);
  check_(
    '...and says it has NOT reported success on the remainder',
    result.message.includes('has NOT reported success on the remainder'),
    true,
  );
  check_('...and emits a CI annotation', result.message.includes('::error::'), true);
}

{
  // The default must stay lenient: a fixture directory is not the repository,
  // and demanding the full layout would make every other test mock four dirs.
  const dir = scratch({ roots: ['examples', 'docs', '.github'], files: { 'docs/a.md': 'ok\n' } });
  const result = check(dir, { requireRoots: false });
  check_('CONTROL: without requireRoots a missing required root only warns', result.code, 0);
  check_('...and says how to make it fatal', result.message.includes('--require-roots'), true);
}

{
  // `scripts/` is declared but absent on purpose. It must never fail, even
  // under --require-roots, or the declaration becomes unusable.
  const result = check(populated(), { requireRoots: true });
  check_('CONTROL: a missing OPTIONAL root does not fail even under requireRoots', result.code, 0);
  check_('...and is still reported so the declaration stays visible', result.message.includes('scripts/'), true);
  check_('...and is labelled optional', result.message.includes('optional'), true);
}

// ---------------------------------------------------------------------------
// Site 2 — a scan that examined nothing
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 2 — empty scan\n');

{
  const result = check(scratch(), { requireRoots: true });
  check_('FAILS when the scan found no files at all', result.code, 1);
  check_(
    '...and refuses to report success on it',
    result.message.includes('Refusing to report success on a scan that examined nothing'),
    true,
  );
  check_('...and reports zero scanned', result.scanned, 0);
}

{
  // Only unscanned extensions present — the scan is genuinely empty even though
  // the tree is not, which is the subtler shape of the same failure.
  const result = check(scratch({ files: { 'packages/a/logo.png': 'x' } }), { requireRoots: true });
  check_('FAILS when the tree has files but none of a scanned type', result.code, 1);
}

// ---------------------------------------------------------------------------
// Site 3 — a file that cannot be read
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 3 — unreadable file\n');

{
  // Injected rather than provoked with chmod 000: as root that call is a no-op,
  // so a chmod-based witness would pass vacuously on exactly the CI images most
  // likely to run it. Injecting keeps the branch deterministic (#349).
  const dir = populated();
  const result = check(dir, {
    requireRoots: true,
    readFile: () => {
      throw new Error('EACCES: permission denied');
    },
  });

  check_('FAILS when a file cannot be read', result.code, 1);
  check_('...and names the file it could not read', result.message.includes('Could not read'), true);
  check_('...and quotes the underlying error', result.message.includes('EACCES'), true);
}

{
  // The important half: an unreadable file must NOT be skipped into a green
  // result. A guard that shrugs off files it cannot read is the silent-narrowing
  // failure this guard exists to prevent, one level up.
  const dir = populated({ 'packages/a/src/other.ts': 'export const b = 2;\n' });
  let calls = 0;
  const result = check(dir, {
    requireRoots: true,
    readFile: (p) => {
      calls++;
      throw new Error('EIO');
    },
  });
  check_('an unreadable file stops the scan rather than being skipped', result.code, 1);
  check_('...on the FIRST failure, without reading the rest', calls, 1);
}

// ---------------------------------------------------------------------------
// Site 4 — NUL bytes actually found
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 4 — NUL bytes detected\n');

{
  const dir = populated({ 'packages/a/src/bad.ts': 'const a = 1;\nconst b = "x\0y";\n' });
  const result = check(dir, { requireRoots: true });

  check_('FAILS when a source file contains a NUL byte', result.code, 1);
  check_('...and names the offending file', result.message.includes('packages/a/src/bad.ts'), true);
  check_('...and reports one offender', result.offenders.length, 1);
  check_('...and locates it on the right line', result.offenders[0].line, 2);
  // Line 1 is 13 bytes including its newline; the NUL is the 13th byte of
  // line 2, so column 13 and absolute offset 25.
  check_('...and gives the column', result.offenders[0].column, 13);
  check_('...and gives the byte offset', result.offenders[0].index, 25);
  check_('...and emits a CI annotation', result.message.includes('::error::'), true);
  check_(
    '...and explains why the other checks did not catch it',
    result.message.includes('tsc, jest and the other guards all PASS'),
    true,
  );
}

{
  const dir = populated({
    'packages/a/src/one.ts': 'a\0\n',
    'docs/two.md': 'b\0\n',
  });
  const result = check(dir, { requireRoots: true });
  check_('every offender is reported, not just the first', result.offenders.length, 2);
}

{
  // A NUL in the very first byte — the off-by-one most likely to be got wrong.
  const dir = populated({ 'packages/a/src/first.ts': '\0rest\n' });
  const result = check(dir, { requireRoots: true });
  check_('detects a NUL at byte offset 0', result.offenders[0]?.index, 0);
  check_('...reported at line 1, column 1', result.offenders[0]?.column, 1);
}

{
  const result = check(populated(), { requireRoots: true });
  check_('CONTROL: a clean tree passes', result.code, 0);
  check_('...and says so', result.message.includes('No NUL bytes found'), true);
}

{
  // Extensions outside SCANNED_EXT legitimately contain NULs. Flagging them is
  // how this guard would get switched off within a day.
  const dir = populated({ 'packages/a/src/asset.bin': 'x\0y' });
  check_('CONTROL: a NUL in an unscanned extension is ignored', check(dir, { requireRoots: true }).code, 0);
}

{
  const dir = populated();
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'bad.ts'), 'x\0y');
  check_('CONTROL: node_modules is not scanned', check(dir, { requireRoots: true }).code, 0);
}

{
  // Root-level files were demonstrably unscanned before #121, and are the ones
  // most likely to be edited by a script doing string surgery.
  const dir = populated({ 'package.json': '{"a":1\0}\n' });
  const result = check(dir, { requireRoots: true });
  check_('a NUL in a root-level file is detected (#121)', result.code, 1);
  check_('...and the root file is named', result.message.includes('package.json'), true);
}

// ---------------------------------------------------------------------------
// The exit code CI reads
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: the guard process exit code\n');

{
  const dir = populated({ 'packages/a/src/bad.ts': 'x\0y\n' });
  const run = runGuard([dir, '--require-roots']);
  checkSpawned('the guard PROCESS exits non-zero on a NUL', run, () => {
    check_('the guard PROCESS exits non-zero on a NUL', run.status, 1);
    check_('...and the annotation reaches stderr', run.stderr.includes('::error::'), true);
  });
}

{
  const run = runGuard([populated(), '--require-roots']);
  checkSpawned('CONTROL: the guard PROCESS exits 0 on a clean tree', run, () => {
    check_('CONTROL: the guard PROCESS exits 0 on a clean tree', run.status, 0);
  });
}

{
  // The flag has to actually reach the option, not just be accepted. Without
  // it a missing required root must not fail.
  const dir = scratch({ roots: ['examples', 'docs', '.github'], files: { 'docs/a.md': 'ok\n' } });
  const withFlag = runGuard([dir, '--require-roots']);
  const without = runGuard([dir]);
  checkSpawned('--require-roots is wired through to the option', withFlag, () => {
    check_('--require-roots makes a missing required root fatal', withFlag.status, 1);
  });
  checkSpawned('...and its absence does not', without, () => {
    check_('...and its absence does not', without.status, 0);
  });
}

// ---------------------------------------------------------------------------
// The real repository
// ---------------------------------------------------------------------------

console.log('\n# this repository\n');

{
  const result = check(repoRoot, { requireRoots: true });
  check_('CONTROL: the repository passes its own guard', result.code, 0);
  // A scan that collapsed to a handful of files would still pass; assert the
  // coverage is real so a broken walk cannot look healthy.
  check_('CONTROL: and the scan actually examined the tree', result.scanned > 100, true);
}

// ---------------------------------------------------------------------------

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${String(passed)} passed, ${String(failed)} failed\n`);
process.exit(failed === 0 ? 0 : 1);
