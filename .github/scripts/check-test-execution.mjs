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
 * Opting out: a package with genuinely nothing to test declares it in its
 * package.json, which makes the exemption reviewable in a diff rather than
 * silent:
 *
 *   "askturret": { "testsNotRequired": "why this package has no tests" }
 *
 * Exit codes: 0 all good · 1 one or more packages fail · 2 usage/IO error
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

const results = [];

for (const { dir, pkg } of workspacePackages()) {
  const name = pkg.name ?? dir;
  const declared = pkg.askturret?.testsNotRequired;

  if (typeof declared === 'string' && declared.trim().length > 0) {
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

  results.push({ name, status: 'ok', detail: `${count} test(s) executed` });
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
