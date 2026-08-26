#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Fails when a workspace package's configured test command does not actually
 * execute any tests.
 *
 * Issue #79 documented eight instances of "shipped tests never ran", across
 * three unrelated causes: a broken jest invocation path, a missing jest config
 * despite ts-jest being installed, and a `"test": "exit 0"` no-op script. Each
 * was caught by hand during QA, one PR at a time.
 *
 * They share one observable symptom — the job goes green having run nothing —
 * so this checks the symptom rather than any single cause. A package must
 * either run at least one test, or say in writing that it has none.
 *
 * Usage:  node .github/scripts/check-test-execution.mjs
 *
 * ## Two granularities, one symptom (#339)
 *
 * The package-level rule above is silent on a FILE that contributes no tests,
 * and that gap has cost three files: #216 found one, #313 found two more. Every
 * one was found by a human reading a config — never by CI — which is what an
 * unguarded class looks like. It is not academic: enabling #313's two files
 * immediately surfaced a real defect in `packages/core` that had been sitting
 * behind a test file reporting as present and executing nothing.
 *
 * So a second question is asked of the SAME run: **did every test file on disk
 * contribute to it?** Both known causes are covered because the check keys on
 * the shared symptom rather than on either cause — the same reason the
 * package-level rule survived three unrelated causes of its own:
 *
 *   - a `testPathIgnorePatterns` entry, so jest never sees the file;
 *   - a file with no jest construct at all, only an `import.meta.url`
 *     self-invocation block that jest never fires.
 *
 * #313's two files had BOTH, independently. A check keyed on either alone would
 * have passed them.
 *
 * ## It costs nothing extra
 *
 * The executed-file set is read from the output this guard ALREADY captures —
 * jest prints one `PASS`/`FAIL` line per suite. This guard re-runs every
 * package's suite, roughly duplicating the test matrix (PR #106's cost note),
 * and adding a second full pass to answer a question the first pass already
 * answered would double that again.
 *
 * Opting out: both exemptions are a written line in a diff, never a default.
 *
 *   "askturret": { "testsNotRequired": "why this package has no tests" }
 *   "askturret": { "testFilesNotExecuted": { "src/x.test.ts": "why it cannot run" } }
 *
 * A `testFilesNotExecuted` entry that no longer applies — naming a file that
 * does run, or one that no longer exists — FAILS rather than lingering. An
 * exemption outliving its reason is the same silent rot this guard exists to
 * catch. And a package cannot both declare `testsNotRequired` and ship test
 * files: that combination strands them permanently.
 *
 * Exit codes: 0 all good · 1 one or more packages fail · 2 usage/IO error
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(process.argv[2] ?? '.');

/** Test scripts that cannot possibly run a test. */
const NO_OP_SCRIPT = /^\s*(exit\s+0|true|echo\b.*)\s*$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Expand the root package.json `workspaces` globs (only the `dir/*` form is used here). */
function workspacePackages() {
  const root = readJson(join(repoRoot, 'package.json'));
  const patterns = root.workspaces ?? [];
  const found = [];

  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) {
      console.error(`::error::unsupported workspace pattern "${pattern}" — expected "dir/*"`);
      process.exit(2);
    }
    const dir = join(repoRoot, pattern.slice(0, -2));
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(dir, entry.name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      found.push({ dir: join(dir, entry.name), pkg: readJson(pkgPath) });
    }
  }
  return found.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
}

/**
 * Pull the executed-test count out of a runner's output.
 *
 * Returns null when no count could be found — treated as a failure, never as a
 * pass. "I could not tell" is not "it worked".
 */
function parseTestCount(output) {
  const line = output.match(/^Tests:.*$/m);
  if (!line) return null;
  const total = line[0].match(/(\d+)\s+total/);
  if (total) return Number(total[1]);
  // Some reporters print only the passing count.
  const passed = line[0].match(/(\d+)\s+passed/);
  return passed ? Number(passed[1]) : null;
}

/** A test file, by any of the extensions this repo's runners pick up. */
const TEST_FILE = /\.test\.(ts|mts|tsx|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'build', '.git']);

/** Every test file on disk under a package, as package-relative posix paths. */
function testFilesOnDisk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFilesOnDisk(full, base, out);
    else if (TEST_FILE.test(entry.name)) out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/**
 * Which files did the runner actually execute?
 *
 * Read from the SAME output the count is parsed from — jest prints one
 * `PASS <path>` / `FAIL <path>` line per suite — so this costs no extra run.
 * That matters: this guard already re-runs every package's suite, and adding a
 * second full pass to answer a question the first pass already answered would
 * roughly double the matrix again (PR #106's cost note).
 *
 * Returns null when no such line exists, which is treated as a failure. An
 * unparseable run is indistinguishable from a clean one, so "I could not tell"
 * must never collapse into "it passed".
 */
function parseExecutedFiles(output) {
  const matches = [...output.matchAll(/^\s*(?:PASS|FAIL)\s+(\S+)/gm)];
  if (matches.length === 0) return null;
  return new Set(matches.map((m) => m[1].split('\\').join('/')));
}

/**
 * Per-FILE execution (#339).
 *
 * The package-level check above asks "did this package run any tests". It is
 * right, and it is silent on a file that contributes none: #216 found one such
 * file, #313 found two more, and all three were found by a human reading a
 * config rather than by CI.
 *
 * Both known causes are keyed on the SHARED SYMPTOM rather than on either
 * cause, which is what let the package-level check survive three different
 * causes of its own:
 *
 *   - a `testPathIgnorePatterns` entry — the file is never handed to jest, so
 *     it never appears in the executed set;
 *   - a file with no jest construct, only an `import.meta.url` self-invocation
 *     block — jest fails such a file outright ("must contain at least one
 *     test"), so it cannot pass silently once it IS handed over.
 *
 * #313's two files had BOTH independently. A check keyed on either cause alone
 * would have passed them.
 */
function checkPerFileExecution(dir, pkg, output) {
  const onDisk = testFilesOnDisk(dir);
  if (onDisk.length === 0) return null;

  const executed = parseExecutedFiles(output);
  if (executed === null) {
    return (
      `ran tests but no per-suite PASS/FAIL lines were found, so the executed-file set ` +
      `could not be determined — failing closed rather than assuming all ${onDisk.length} ` +
      'test file(s) ran'
    );
  }

  const exemptions = pkg.askturret?.testFilesNotExecuted ?? {};
  if (typeof exemptions !== 'object' || exemptions === null || Array.isArray(exemptions)) {
    return 'askturret.testFilesNotExecuted must be an object mapping a file path to a reason';
  }

  const missing = onDisk.filter((f) => !executed.has(f));

  // A stale exemption is the same silent rot this guard exists to catch, so an
  // entry that no longer applies fails rather than lingering.
  for (const [file, reason] of Object.entries(exemptions)) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      return `askturret.testFilesNotExecuted["${file}"] must be a non-empty reason`;
    }
    if (!onDisk.includes(file)) {
      return `askturret.testFilesNotExecuted names "${file}", which is not a test file in this package — remove the stale entry`;
    }
    if (!missing.includes(file)) {
      return `askturret.testFilesNotExecuted names "${file}", but it DOES execute — remove the stale entry`;
    }
  }

  const unexplained = missing.filter((f) => !(f in exemptions));
  if (unexplained.length > 0) {
    return (
      `${unexplained.length} test file(s) contributed no tests to the run: ` +
      `${unexplained.join(', ')} — the file name promises coverage the suite never executed`
    );
  }
  return null;
}

const results = [];

for (const { dir, pkg } of workspacePackages()) {
  const name = pkg.name ?? dir;
  const declared = pkg.askturret?.testsNotRequired;

  if (typeof declared === 'string' && declared.trim().length > 0) {
    // "This package has nothing to test" and "this package ships test files"
    // cannot both be true. The declaration would otherwise exempt the files
    // from ever running, which is the silence this guard exists to refuse.
    const stranded = testFilesOnDisk(dir);
    if (stranded.length > 0) {
      results.push({
        name,
        status: 'fail',
        detail:
          `declares askturret.testsNotRequired but contains ${stranded.length} test file(s) ` +
          `that therefore never run: ${stranded.join(', ')}`,
      });
      continue;
    }
    results.push({ name, status: 'exempt', detail: declared.trim() });
    continue;
  }
  if (declared !== undefined) {
    results.push({
      name,
      status: 'fail',
      detail: 'askturret.testsNotRequired must be a non-empty string explaining why',
    });
    continue;
  }

  const script = pkg.scripts?.test;

  if (!script) {
    results.push({
      name,
      status: 'fail',
      detail: 'no "test" script — add one, or declare askturret.testsNotRequired',
    });
    continue;
  }

  if (NO_OP_SCRIPT.test(script)) {
    results.push({
      name,
      status: 'fail',
      detail: `test script "${script}" is a no-op and runs nothing — the job would go green ` +
        'having executed no tests',
    });
    continue;
  }

  // Both streams: jest prints its "Tests: N passed" summary to stderr, so
  // reading stdout alone finds no count and fails every package.
  const run = spawnSync('npm', ['test', '--workspace', name], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: { ...process.env, CI: 'true' },
  });
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const failed = run.status !== 0;

  const count = parseTestCount(output);

  if (failed) {
    results.push({
      name,
      status: 'fail',
      detail:
        count === 0 || /No tests found/i.test(output)
          ? 'test command ran but found no tests'
          : 'test command exited non-zero',
    });
    continue;
  }

  if (count === null) {
    results.push({
      name,
      status: 'fail',
      detail: 'could not determine how many tests ran from the output — failing closed',
    });
    continue;
  }

  if (count === 0) {
    results.push({ name, status: 'fail', detail: 'test command executed 0 tests' });
    continue;
  }

  const perFile = checkPerFileExecution(dir, pkg, output);
  if (perFile !== null) {
    results.push({ name, status: 'fail', detail: perFile });
    continue;
  }

  const fileCount = testFilesOnDisk(dir).length;
  results.push({
    name,
    status: 'ok',
    detail: `${count} test(s) executed across ${fileCount} test file(s), all of which ran`,
  });
}

const pad = Math.max(...results.map((r) => r.name.length), 10);
for (const r of results) {
  const mark = r.status === 'ok' ? 'ok    ' : r.status === 'exempt' ? 'exempt' : 'FAIL  ';
  console.log(`  ${mark} ${r.name.padEnd(pad)}  ${r.detail}`);
}

const failures = results.filter((r) => r.status === 'fail');
console.log(
  `\n${results.length} package(s): ${results.filter((r) => r.status === 'ok').length} running ` +
    `tests, ${results.filter((r) => r.status === 'exempt').length} declared exempt, ` +
    `${failures.length} failing.`,
);

if (failures.length > 0) {
  console.error(
    `\n::error::${failures.length} package(s) do not execute any tests. A green test job that ` +
      'ran nothing is worse than a red one: it reports coverage that does not exist.\n' +
      'Fix the package\'s test setup, or — if it genuinely has nothing to test — declare it:\n' +
      '  "askturret": { "testsNotRequired": "reason" }',
  );
  process.exit(1);
}
