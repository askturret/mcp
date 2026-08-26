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

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
} finally {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
