#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the #227 runtime-marker ignore guard.
 *
 * A guard that silently stops working is the same failure one level up, so
 * this exercises every root cause the guard claims to catch, plus the
 * near-misses that would make it cry wolf:
 *
 *   - the entry present            -> passes
 *   - the entry deleted            -> fails (the regression it exists for)
 *   - the entry present but later
 *     NEGATED with `!`             -> fails (a literal grep would pass this)
 *   - a BROADER pattern that still
 *     ignores the marker           -> passes (a literal grep would fail this)
 *   - not a git repository         -> exit 2, never a silent pass
 *
 * The middle two are the point of asking `git check-ignore` instead of
 * grepping .gitignore, so they are the cases that would catch a future
 * "simplification" back to a string match.
 *
 * Run: node .github/scripts/check-runtime-marker-ignored.test.mjs
 */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-runtime-marker-ignored.mjs');

let passed = 0;
let failed = 0;

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (expected exit ${expected}, got ${actual})`);
    failed++;
  }
}

/** A throwaway directory, optionally `git init`ed, with an optional .gitignore. */
function fixture({ git = true, gitignore = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'marker-guard-'));
  if (git) {
    const init = spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  }
  if (gitignore !== null) writeFileSync(join(dir, '.gitignore'), gitignore);
  return dir;
}

function runGuard(dir) {
  return spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf8' }).status;
}

const fixtures = [];
function track(dir) {
  fixtures.push(dir);
  return dir;
}

try {
  check(
    'passes when the marker is ignored',
    runGuard(track(fixture({ gitignore: 'node_modules/\n.operum-stash-recovery\n' }))),
    0,
  );

  check(
    'fails when the .gitignore entry is missing — the regression it exists for',
    runGuard(track(fixture({ gitignore: 'node_modules/\ndist/\n' }))),
    1,
  );

  check(
    'fails when there is no .gitignore at all',
    runGuard(track(fixture({ gitignore: null }))),
    1,
  );

  // A literal line-grep would PASS this: the line is present. git resolves
  // precedence and knows the negation wins.
  check(
    'fails when a later negation un-ignores the marker',
    runGuard(
      track(fixture({ gitignore: '.operum-stash-recovery\n!.operum-stash-recovery\n' })),
    ),
    1,
  );

  // A literal line-grep would FAIL this: the exact line is absent, yet the
  // marker is genuinely ignored.
  check(
    'passes when a broader pattern still ignores the marker',
    runGuard(track(fixture({ gitignore: '.operum-stash-*\n' }))),
    0,
  );

  check(
    'exits 2 rather than passing when the directory is not a git repository',
    runGuard(track(fixture({ git: false, gitignore: '.operum-stash-recovery\n' }))),
    2,
  );
  // -------------------------------------------------------------------------
  // git that never RAN (#443)
  //
  // This guard keyed its never-ran test on `result.error`, which is set when a
  // process fails to START and is UNDEFINED when it is killed by a SIGNAL —
  // both leaving `status: null`. A signal-killed git therefore fell past it
  // into the exit-code ladder and was reported as `git check-ignore exited
  // null`, diagnosing an exit that never happened.
  //
  // It failed CLOSED throughout, so no wrong verdict ever shipped. What was
  // wrong is the sentence a reader has to act on, and that is what these pin.
  // -------------------------------------------------------------------------
  {
    const dir = track(fixture({ git: true, gitignore: '.operum-stash-recovery\n' }));
    const run = spawnSync(process.execPath, [GUARD, dir], {
      encoding: 'utf8',
      env: { ...process.env, PATH: join(tmpdir(), 'operum-there-is-no-git-here') },
    });
    const out = `${run.stdout}${run.stderr}`;

    check('with git unresolvable the guard still refuses', run.status !== 0, true);
    check('...and says git could not be RUN', /git could not be run/.test(out), true);
    check('...rather than naming an exit that never happened', /exited null/.test(out), false);
    check('...and names the spawn cause', /ENOENT/.test(out), true);
  }

  // THE FOUR ABOVE ARE CONTROLS, NOT WITNESSES, and saying so is the point.
  //
  // Verified by reverting: with the old `if (result.error)` keying they all
  // still pass, because a MISSING git sets `error` and both keyings catch it.
  // The two differ only on the signal-killed row — `error` undefined, `status`
  // null — which cannot be produced for `git` on demand from a self-test.
  //
  // That row IS witnessed, against a real SIGKILLed child, in
  // `sdk-upgrade-drill.test.mjs`, which also asserts that the inlined
  // `result.error.message` throws on it. What that suite cannot see is whether
  // THIS file still keys on the right thing — so the shared vocabulary is
  // tested there and its use is pinned here.
  //
  // Comments are stripped first: this file's own explanation names both forms,
  // and a scan window including its documentation would go red for a comment
  // and green for a real call site a comment happened to mention (#449).
  {
    const source = readFileSync(GUARD, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');

    check('the guard keys its never-ran test on didNotStart', /didNotStart\s*\(/.test(source), true);
    check('...and builds its detail with the shared helper', /spawnFailureDetail\s*\(/.test(source), true);
    // The inlined form this replaced. Its ABSENCE is the assertion: a call site
    // reaching for `.error.message` has kept the condition and dropped the
    // defence, which is #443 finding 2.
    check('...and never dereferences `.error.message` directly', /\.error\.message/.test(source), false);
  }
} finally {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
