#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the #687 integrated-tree runner.
 *
 * This runner is the SOLE proof for the tree `main` actually has, now that
 * test.yml no longer runs on `push: main`. So the assertion that matters most
 * here is not "it passes when everything passes" — it is that it CANNOT report
 * a pass without having run something, and that its three verdicts are all
 * reachable. A runner nothing can redden is the same defect one level up.
 *
 * Exercised, end to end through the real CLI where the exit code is the
 * subject, and in process where the arm cannot be provoked for real:
 *
 *   - every suite passes                  -> exit 0, SHA named
 *   - a suite fails                       -> exit 1, SHA and package named
 *   - no package declares a `test` script -> exit 2 (an empty scan must not pass)
 *   - test.yml declares no test-<key> job -> exit 2 (parser no longer understands it)
 *   - the two suite sets disagree         -> exit 2, in BOTH directions
 *   - test.yml missing entirely           -> exit 2
 *   - a suite cannot be RUN               -> exit 2, and it dominates a real failure
 *   - spawn never started (status null)   -> cannot-run, never pass and never fail (#371)
 *   - GITHUB_SHA unset and git silent     -> exit 2, never an unattributed verdict
 *
 * Plus one structural assertion: the runner must not reach the path filters at
 * all. That is the ADR-024 trap this whole change exists to avoid — a nightly
 * reusing `test.yml`'s `changes` job computes a diff against nothing, schedules
 * zero suites, and reports green having run nothing. Asserting it structurally,
 * against the runner's source, is what stops a future "reuse the filters"
 * simplification passing review.
 *
 * Run: node .github/scripts/nightly-integrated-tree.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  CannotCheck,
  discoverSuites,
  declaredSuiteJobs,
  runIntegratedTree,
  runSuiteWithNpm,
  resolveSha,
  report,
} from './nightly-integrated-tree.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(here, 'nightly-integrated-tree.mjs');

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

let skipped = 0;

/**
 * Whether `npm` can actually be spawned here.
 *
 * The end-to-end arms below drive the REAL CLI, which shells out to npm — the
 * only way to exercise exit 0 and exit 1 through the same path CI uses. On a
 * workstation where npm is not on the spawn PATH those arms fail for a reason
 * that has nothing to do with the runner, and #361 is the record of what that
 * costs: an environmental failure wearing the costume of a code defect, read by
 * someone who arrived already holding the hypothesis "a guard is broken".
 *
 * So: report it as an environment gap and name the arms not exercised — but
 * ONLY off CI. Under `CI` npm is provided by `actions/setup-node`, so its
 * absence there is a real failure and is treated as one. Tolerating it in both
 * places would let the two arms that prove the pass/fail verdicts quietly stop
 * running in the one place that matters.
 */
const npmAvailable = spawnSync('npm', ['--version'], { encoding: 'utf8' }).status === 0;
if (!npmAvailable && process.env.CI) {
  console.log('FAIL - npm is not spawnable, and this is CI where setup-node guarantees it');
  process.exit(1);
}

function e2e(desc, fn) {
  if (!npmAvailable) {
    console.log(`SKIP - ${desc} (npm is not on the spawn PATH; not exercised)`);
    skipped++;
    return;
  }
  fn();
}

const fixtures = [];

/**
 * A throwaway npm workspace.
 *
 * `packages` maps a directory name to the exit code its `test` script should
 * produce, or `null` for a package that declares no `test` script at all.
 * `jobs` is the list of `test-<key>` job names written into the fake test.yml,
 * defaulting to exactly the packages that have tests.
 */
function fixture({ packages, jobs = undefined, workflow = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'integrated-tree-'));
  fixtures.push(dir);

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['packages/*'] }, null, 2),
  );

  mkdirSync(join(dir, 'packages'), { recursive: true });
  for (const [name, exitCode] of Object.entries(packages)) {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    const scripts = exitCode === null ? {} : { test: `node -e "process.exit(${exitCode})"` };
    writeFileSync(
      join(dir, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@fixture/${name}`, version: '0.0.0', scripts }, null, 2),
    );
  }

  if (workflow) {
    const keys = jobs ?? Object.entries(packages).filter(([, c]) => c !== null).map(([n]) => n);
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'test.yml'),
      ['name: Test', '', 'jobs:', '  changes:', '    runs-on: [self-hosted]', ...keys.flatMap((k) => [`  test-${k}:`, '    runs-on: [self-hosted]'])].join('\n') + '\n',
    );
  }

  return dir;
}

/** The real CLI, with a fixed SHA so the verdict is attributable without git. */
function runCli(dir, sha = 'deadbeefcafe0000000000000000000000000000') {
  return spawnSync(process.execPath, [RUNNER, dir], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_SHA: sha },
  });
}

try {
  // -------------------------------------------------------------------------
  // The happy path — and it must NAME the tree it proved.
  // -------------------------------------------------------------------------
  e2e('every suite passes -> exit 0', () => {
    const dir = fixture({ packages: { alpha: 0, beta: 0 } });
    const r = runCli(dir);
    check('every suite passes -> exit 0', r.status, 0);
    check('...and the SHA is named on the pass', r.stdout.includes('deadbeefcafe'), true);
    check('...and both suites actually ran', /2 suites ran and passed/.test(r.stdout), true);
  });

  // -------------------------------------------------------------------------
  // A real failure. Exit 1, and the report must be actionable: which package,
  // and which commit. "main is broken" alone is not, a dozen merges later.
  // -------------------------------------------------------------------------
  e2e('a suite fails -> exit 1', () => {
    const dir = fixture({ packages: { alpha: 0, beta: 1 } });
    const r = runCli(dir);
    check('a suite fails -> exit 1', r.status, 1);
    check('...and the failing package is named', r.stderr.includes('beta'), true);
    check('...and the SHA is named on the failure', r.stderr.includes('deadbeefcafe'), true);
    check('...and the passing suite is not blamed', /INTEGRATED TREE IS BROKEN[\s\S]*alpha/.test(r.stderr), false);
  });

  // -------------------------------------------------------------------------
  // The empty-scan trap. A discovery step that finds nothing is, in a green
  // log, indistinguishable from one that found everything passing.
  // -------------------------------------------------------------------------
  {
    const dir = fixture({ packages: { alpha: null }, jobs: [] });
    const r = runCli(dir);
    check('no package declares a test script -> exit 2, not 0', r.status, 2);
    check('...and it says so rather than reporting a pass', r.stderr.includes('CANNOT CHECK'), true);
  }

  // -------------------------------------------------------------------------
  // Same shape one level along: a test.yml the parser no longer understands
  // must not read as "no suites are scheduled, so nothing to run".
  // -------------------------------------------------------------------------
  {
    const dir = fixture({ packages: { alpha: 0 }, jobs: [] });
    const r = runCli(dir);
    check('test.yml declares no test-<key> job -> exit 2', r.status, 2);
  }

  {
    const dir = fixture({ packages: { alpha: 0 }, workflow: false });
    const r = runCli(dir);
    check('test.yml missing entirely -> exit 2', r.status, 2);
  }

  // -------------------------------------------------------------------------
  // Drift between the two derivations, in BOTH directions. This is what keeps
  // the suite list from becoming a hand-maintained set with no checkable
  // membership — the #601 / #427 shape.
  // -------------------------------------------------------------------------
  {
    const dir = fixture({ packages: { alpha: 0, beta: 0 }, jobs: ['alpha'] });
    const r = runCli(dir);
    check('a package with tests and no test-<key> job -> exit 2', r.status, 2);
    check('...and the direction is named', /has tests, no test-<key> job: beta/.test(r.stderr), true);
  }

  {
    const dir = fixture({ packages: { alpha: 0 }, jobs: ['alpha', 'ghost'] });
    const r = runCli(dir);
    check('a test-<key> job with no such package -> exit 2', r.status, 2);
    check('...and that direction is named too', /test-<key> job, no package tests: ghost/.test(r.stderr), true);
  }

  // -------------------------------------------------------------------------
  // Cannot-run, and its PRECEDENCE. An unrunnable suite undermines the whole
  // verdict rather than one line of it, so it outranks a genuine failure —
  // same rule check-runners.mjs applies to an unreadable workflow.
  // -------------------------------------------------------------------------
  {
    const dir = fixture({ packages: { alpha: 0 } });
    const verdict = runIntegratedTree({
      repoRoot: dir,
      sha: 'abc123',
      runSuite: () => ({ outcome: 'cannot-run', detail: 'injected' }),
    });
    check('a suite that cannot run is recorded as such', verdict.unrunnable.length, 1);
    check('...and is not counted as a failure', verdict.failed.length, 0);
    check('...and the report says CANNOT RUN, not PASS', /CANNOT RUN\s+alpha/.test(report(verdict)), true);
  }

  {
    const dir = fixture({ packages: { alpha: 0, beta: 0 } });
    const verdict = runIntegratedTree({
      repoRoot: dir,
      sha: 'abc123',
      runSuite: (pkg) =>
        pkg === 'alpha' ? { outcome: 'fail', detail: 'exit 1' } : { outcome: 'cannot-run', detail: 'injected' },
    });
    // The CLI branches on `unrunnable` BEFORE `failed`, so this combination
    // exits 2. Asserted on the verdict rather than the exit code because both
    // arms must be populated for the precedence to mean anything.
    check('cannot-run and fail can coexist', verdict.unrunnable.length === 1 && verdict.failed.length === 1, true);
  }

  // -------------------------------------------------------------------------
  // #371: a process that never STARTED reports status null. `status !== 0`
  // reads that as a failure and `status === 0` reads it as a pass; neither is
  // true, and the second is how a PASS was once reported from a compiler that
  // never ran.
  // -------------------------------------------------------------------------
  {
    const arm = (fake) => runSuiteWithNpm('/nowhere', 'alpha', () => fake).outcome;
    check('spawn error -> cannot-run', arm({ error: new Error('ENOENT') }), 'cannot-run');
    check('status null -> cannot-run, not fail', arm({ status: null, signal: null }), 'cannot-run');
    check('killed by a signal -> cannot-run', arm({ status: null, signal: 'SIGKILL' }), 'cannot-run');
    check('status 0 -> pass', arm({ status: 0 }), 'pass');
    check('status 1 -> fail', arm({ status: 1 }), 'fail');
  }

  // -------------------------------------------------------------------------
  // An unattributable verdict is the thing this exists to prevent, so an
  // unresolvable SHA is cannot-check rather than "unknown".
  // -------------------------------------------------------------------------
  {
    let code = null;
    try {
      resolveSha({ env: {}, repoRoot: '.', git: () => ({ status: 128, stdout: '' }) });
    } catch (err) {
      code = err instanceof CannotCheck ? 'cannot-check' : 'other';
    }
    check('GITHUB_SHA unset and git silent -> cannot-check', code, 'cannot-check');

    check(
      'GITHUB_SHA wins when set',
      resolveSha({ env: { GITHUB_SHA: 'feedface' }, git: () => ({ status: 128 }) }),
      'feedface',
    );
    check(
      'git is the fallback',
      resolveSha({ env: {}, git: () => ({ status: 0, stdout: 'cafebabe\n' }) }),
      'cafebabe',
    );
  }

  // -------------------------------------------------------------------------
  // Discovery and declaration, read directly.
  // -------------------------------------------------------------------------
  {
    const dir = fixture({ packages: { zeta: 0, alpha: 0, noTests: null }, jobs: ['alpha', 'zeta'] });
    check('discovery skips packages without a test script', discoverSuites(dir).join(','), 'alpha,zeta');
    check('declaration reads the test-<key> job keys', declaredSuiteJobs(dir).join(','), 'alpha,zeta');
  }

  // -------------------------------------------------------------------------
  // The two exclusions, both found by running this against the real repository
  // before it was believed.
  //
  // `packages/examples` declares `test: "exit 0"` and `testsNotRequired` — so
  // counting it would have added a suite that passes by construction, which is
  // the constant-wearing-a-verdict shape one level down. `test-integrity` is
  // the repo-integrity job and has no package at all.
  // -------------------------------------------------------------------------
  {
    const dir = fixture({ packages: { alpha: 0, aggregator: 0 }, jobs: ['alpha'] });
    writeFileSync(
      join(dir, 'packages', 'aggregator', 'package.json'),
      JSON.stringify({
        name: '@fixture/aggregator',
        version: '0.0.0',
        scripts: { test: 'node -e "process.exit(0)"' },
        askturret: { testsNotRequired: 'aggregator with no source of its own' },
      }),
    );
    check(
      'a package declaring askturret.testsNotRequired is not a suite',
      discoverSuites(dir).join(','),
      'alpha',
    );
    e2e('...so the two sets agree and the run proceeds', () => {
      check('...so the two sets agree and the run proceeds', runCli(dir).status, 0);
    });
  }

  {
    const dir = fixture({ packages: { alpha: 0 }, jobs: ['alpha', 'integrity'] });
    check(
      'test-integrity is not counted as a package suite',
      declaredSuiteJobs(dir).join(','),
      'alpha',
    );
  }

  {
    // The forcing function: a NEW non-package `test-*` job is a refusal that
    // names it, not a silent pass. Someone has to decide whether it belongs in
    // NON_PACKAGE_TEST_JOBS.
    const dir = fixture({ packages: { alpha: 0 }, jobs: ['alpha', 'coverage'] });
    const r = runCli(dir);
    check('an unrecognised non-package test-* job -> exit 2', r.status, 2);
    check('...and it is named', r.stderr.includes('coverage'), true);
  }

  // -------------------------------------------------------------------------
  // THE TRAP, asserted structurally against the runner's source.
  //
  // Comments are stripped first, so the prose ABOUT the trap — which names
  // `paths-filter` and `needs.changes.outputs` repeatedly, on purpose — cannot
  // satisfy or defeat the assertion. The scan window is the runner, never this
  // file, so this cannot match itself (the Decorative Guard antipattern in
  // docs/TESTING.md).
  // -------------------------------------------------------------------------
  {
    const source = readFileSync(RUNNER, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');

    check('the runner never reads a paths-filter output', /paths-filter/.test(source), false);
    check('...nor the `changes` job outputs', /needs\.changes\.outputs/.test(source), false);
    check(
      '...and it does derive its suites from the packages tree',
      /readdirSync/.test(source) && /scripts\?\.test/.test(source),
      true,
    );
    check('...and treats a null spawn status as cannot-run', /status === null/.test(source), true);
  }
} finally {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped (no npm)` : ''}`);
process.exit(failed === 0 ? 0 : 1);
