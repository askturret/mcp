#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the placeholder-test guard (#455, closing a gap found in #431).
 *
 * This guard was wired into `test.yml:522` with **no self-test at all**. Its
 * three error paths and its non-zero exit had never been executed by anything,
 * so if it had stopped detecting tests-that-cannot-fail, nothing would have
 * said so. That is the same claim the guard itself makes about untested code,
 * one level up — and #281's doctrine applied to the checker rather than the
 * checked.
 *
 * ## Every failure site here has been observed red
 *
 * Each `WITNESS` below was built by neutralising the corresponding site in
 * `check-placeholder-tests.mjs`, running this file, and confirming it FAILS —
 * then restoring the site. A self-test that has never been red is exactly the
 * defect #431 exists to close, so "it passes" is not the standard.
 *
 * Assertions that pin behaviour which is already correct, and would survive the
 * site being neutralised, are labelled `CONTROL`. They are worth keeping — they
 * are what catches a fix that over-corrects into false positives — but they are
 * NOT evidence that a failure path works, and naming them apart is the whole
 * subject of #431.
 *
 * Run: node .github/scripts/check-placeholder-tests.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, FAILURE_ANNOTATION } from './check-placeholder-tests.mjs';
import { didNotStart } from './sdk-upgrade-drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

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

/** A throwaway tree containing one test file with the given body. */
function scratch(source, name = 'sample.test.ts') {
  const dir = mkdtempSync(join(tmpdir(), 'placeholder-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'pkg', name), source);
  return dir;
}

/** Messages of every error the guard reported, joined for substring assertions. */
const errorText = (result) => result.errors.map((e) => e.message).join('\n');

const guardPath = join(here, 'check-placeholder-tests.mjs');

/**
 * Run the guard as CI runs it — a real process, so the real exit code is
 * observable.
 *
 * Calling `check()` cannot witness `process.exit()`: neutralise that call and
 * every in-process assertion still passes, which is precisely how the mutation
 * audit found this site unwitnessed on the first cut of this file. The exit
 * code is a separate claim from the returned `code`, and only a subprocess
 * tests it.
 *
 * `process.execPath` rather than the string `'node'` on purpose: #429 was a
 * space-separated PATH making `node` unresolvable, and a guard's self-test is
 * the last place that should depend on PATH.
 *
 * A child that never starts is routed to CANNOT CHECK and FAILS this file
 * rather than being read as a passing exit code — #281, and the #443 defect of
 * letting `status: null` render as an ordinary result.
 */
function runGuard(rootDir) {
  const result = spawnSync(process.execPath, [guardPath, rootDir], { encoding: 'utf-8' });
  if (didNotStart(result)) {
    return {
      cannotCheck: true,
      why: `guard process never started: ${result.error ? result.error.message : '(none reported)'}`,
    };
  }
  return { cannotCheck: false, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Assert on a subprocess run, turning a never-started child into a FAIL. */
function checkSpawned(desc, run, fn) {
  if (run.cannotCheck) {
    console.log(`FAIL - ${desc} (CANNOT CHECK — ${run.why})`);
    failed++;
    return;
  }
  fn();
}

// ---------------------------------------------------------------------------
// Site 1 — `.only`, which silently disables every other test in the file
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 1 — .only detection\n');

for (const keyword of ['describe', 'it', 'test']) {
  const result = check(scratch(`${keyword}.only('x', () => { expect(1).toBe(2); });\n`));

  check_(`FAILS on ${keyword}.only(`, result.code, 1);
  check_(`...and names ${keyword}.only() as the reason`, errorText(result).includes(`${keyword}.only()`), true);
  check_(
    `...and says what the consequence is, for ${keyword}`,
    errorText(result).includes('disables every other test in this file'),
    true,
  );
}

{
  // A body with a real assertion is otherwise clean, so this isolates `.only`
  // as the sole cause rather than the no-assertion path firing as well.
  const result = check(scratch(`it.only('x', () => { expect(a).toBe(b); });\n`));
  check_('the .only error is the ONLY error raised for an otherwise-sound test', result.errors.length, 1);
}

{
  // #328's regression, in the sharpest direction. The lookbehind excludes a
  // preceding dot so `regex.test(` is not read as a declaration — but `.only`'s
  // dot comes AFTER the keyword, so the exclusion must not reach it. A careless
  // "reject anything with a dot" fix would break this and pass every other test
  // in this file.
  const result = check(scratch(`promise.test.only('x', () => {});\n`));
  check_('CONTROL: a method chain `promise.test.only(` is NOT a declaration', result.code, 0);
}

// ---------------------------------------------------------------------------
// Site 2 — tautological assertions
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 2 — tautology detection\n');

for (const literal of ['true', 'false', 'null', 'undefined', '1', '-2.5']) {
  const result = check(scratch(`it('x', () => { expect(${literal}).toBe(${literal}); });\n`));
  check_(`FAILS on expect(${literal}).toBe(${literal})`, result.code, 1);
  check_(`...and quotes the assertion for ${literal}`, errorText(result).includes('assertion cannot fail'), true);
}

for (const matcher of ['toBe', 'toEqual', 'toStrictEqual']) {
  const result = check(scratch(`it('x', () => { expect(true).${matcher}(true); });\n`));
  check_(`FAILS on a tautology using ${matcher}`, result.code, 1);
}

{
  const result = check(scratch(`it('x', () => { expect( true )\n  .toBe(  true  ); });\n`));
  check_('FAILS on a tautology split across lines and padded with spaces', result.code, 1);
}

{
  // The tautology branch `continue`s, so a body that is BOTH tautological and
  // otherwise assertion-bearing must report exactly one error. If this ever
  // reports two, the branch stopped short-circuiting.
  const result = check(scratch(`it('x', () => { expect(true).toBe(true); expect(a).toBe(b); });\n`));
  check_('a tautology is reported once, not compounded', result.errors.length, 1);
}

{
  const result = check(scratch(`it('x', () => { expect(actual).toBe(expected); });\n`));
  check_('CONTROL: a real assertion comparing two identifiers passes', result.code, 0);
}

{
  // Different literals are a real (if odd) assertion — flagging them would make
  // the guard cry wolf, which is how a linter gets switched off.
  const result = check(scratch(`it('x', () => { expect(true).toBe(false); });\n`));
  check_('CONTROL: expect(true).toBe(false) is not a tautology', result.code, 0);
}

// ---------------------------------------------------------------------------
// Site 3 — a test body that asserts nothing
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 3 — no-assertion detection\n');

{
  const result = check(scratch(`it('x', () => { const a = compute(); });\n`));
  check_('FAILS on a body with no expect(', result.code, 1);
  check_('...and says the body contains no assertion', errorText(result).includes('test body contains no assertion'), true);
}

{
  // The shape that actually ships: something is awaited, nothing is checked, and
  // the test passes even when the awaited thing is broken.
  const result = check(scratch(`it('x', async () => { await doTheThing(); });\n`));
  check_('FAILS on an async body that awaits and asserts nothing', result.code, 1);
}

{
  const result = check(scratch(`test('x', () => { setup(); });\n`));
  check_('FAILS on `test(` as well as `it(`', result.code, 1);
}

{
  // A comment mentioning expect( must not satisfy the check — comments are
  // blanked precisely so the guard cannot be fooled by its own documentation.
  const result = check(scratch(`it('x', () => {\n  // expect(a).toBe(b);\n  run();\n});\n`));
  check_('FAILS when the only expect( is inside a comment', result.code, 1);
}

{
  const result = check(scratch(`it('x', () => {\n  const s = "expect(a).toBe(b)";\n  run(s);\n});\n`));
  check_('FAILS when the only expect( is inside a string literal', result.code, 1);
}

{
  const result = check(scratch(`it('x', () => { expect(value).toBe(3); });\n`));
  check_('CONTROL: a body with a real assertion passes', result.code, 0);
}

// ---------------------------------------------------------------------------
// Site 4 — the non-zero exit code CI reads
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 4 — the failing exit code and its annotation\n');

{
  // The in-process half: `check()` computes code 1. This does NOT witness the
  // `process.exit` call — see the subprocess block below, which does.
  const result = check(scratch(`it('x', () => {});\n`));
  check_('a tree containing an error returns code 1', result.code, 1);
}

{
  // The witness for `process.exit(result.code)` itself. Neutralise that call and
  // the guard exits 0 while every in-process assertion above still passes — CI
  // would go green on a tree full of tests that cannot fail.
  const dir = scratch(`it('x', () => {});\n`);
  const run = runGuard(dir);
  checkSpawned('the guard PROCESS exits non-zero on a failing tree', run, () => {
    check_('the guard PROCESS exits non-zero on a failing tree', run.status, 1);
    check_('...and emits the ::error:: annotation on stderr', run.stderr.includes('::error::'), true);
  });
}

{
  const dir = scratch(`it('x', () => { expect(a).toBe(b); });\n`);
  const run = runGuard(dir);
  checkSpawned('CONTROL: the guard PROCESS exits 0 on a clean tree', run, () => {
    check_('CONTROL: the guard PROCESS exits 0 on a clean tree', run.status, 0);
  });
}

{
  const result = check(scratch(`it('x', () => { expect(a).toBe(b); });\n`));
  check_('a clean tree returns code 0', result.code, 0);
}

{
  // Warnings must NOT fail the build — that is the #79 scope note, and getting
  // it wrong is how the guard would start blocking legitimate work.
  const result = check(scratch(`it('x', () => { expect(a).toBeDefined(); });\n`));
  check_('a warning alone does not fail the build', result.code, 0);
  check_('...but it is still reported', result.warnings.length, 1);
}

{
  const result = check(scratch(`it('x', () => {});\nit('y', () => {});\n`));
  check_('every offending test is reported, not just the first', result.errors.length, 2);
}

check_(
  'the failure annotation is a GitHub ::error:: so CI surfaces it',
  FAILURE_ANNOTATION.startsWith('::error::'),
  true,
);

// ---------------------------------------------------------------------------
// Warnings — reported, never fatal
// ---------------------------------------------------------------------------

console.log('\n# warnings\n');

{
  const result = check(scratch(`it.skip('x', () => { expect(a).toBe(b); });\n`));
  check_('CONTROL: .skip warns rather than failing', result.code, 0);
  check_('...and says the test is hidden', result.warnings[0]?.message.includes('hidden test'), true);
}

{
  const result = check(scratch(`it('x', () => { expect(a).toBeTruthy(); });\n`));
  check_('CONTROL: a weak-only assertion warns rather than failing', result.warnings.length, 1);
}

{
  const result = check(scratch(`it('x', () => { expect(a).toBeDefined(); expect(b).toBe(2); });\n`));
  check_('CONTROL: a weak assertion alongside a strong one does not warn', result.warnings.length, 0);
}

// ---------------------------------------------------------------------------
// Not-a-declaration — the #328 false-failure class
// ---------------------------------------------------------------------------

console.log('\n# CONTROL: method calls are not test declarations (#328)\n');

for (const source of [
  `const ok = regex.test('x');\n`,
  `const ok = my$test('x', () => {});\n`,
  `submit('x', () => {});\n`,
]) {
  const result = check(scratch(source));
  check_(`not a declaration: ${source.trim()}`, result.code, 0);
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

console.log('\n# traversal\n');

{
  const dir = scratch(`it('x', () => {});\n`);
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'bad.test.ts'), `it('y', () => {});\n`);
  const result = check(dir);
  check_('CONTROL: node_modules is not scanned', result.errors.length, 1);
}

{
  const dir = scratch(`it('x', () => {});\n`, 'notatest.ts');
  check_('CONTROL: a non-test file is not scanned', check(dir).code, 0);
}

// ---------------------------------------------------------------------------
// The real repository
// ---------------------------------------------------------------------------

console.log('\n# this repository\n');

check_('CONTROL: the repository passes its own guard', check(repoRoot).code, 0);

// ---------------------------------------------------------------------------

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${String(passed)} passed, ${String(failed)} failed\n`);
process.exit(failed === 0 ? 0 : 1);
