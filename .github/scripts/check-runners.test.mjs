#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the self-hosted runner guard (#280).
 *
 * The guard's whole value is catching a form someone would plausibly WRITE.
 * So the assertions below are organised around the shapes GitHub accepts, and
 * the bare-string case is the one that matters most: `runs-on: ubuntu-latest`
 * is simultaneously the likeliest reintroduction and the form a list-only
 * parser passes in silence. A guard green on that input is worse than no guard,
 * because it also removes the suspicion that would otherwise prompt a look.
 *
 * Each shape is asserted in BOTH directions — compliant input passes, the same
 * shape carrying a hosted runner fails. A guard only ever observed passing has
 * not been shown to be capable of failing.
 *
 * Run: node .github/scripts/check-runners.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-runners.mjs');

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

function checkIncludes(desc, haystack, needle) {
  if (haystack.includes(needle)) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (output did not contain ${JSON.stringify(needle)})`);
    console.log(`       got: ${JSON.stringify(haystack.slice(0, 400))}`);
    failed++;
  }
}

function run(repoRoot) {
  const r = spawnSync(process.execPath, [GUARD, repoRoot], { encoding: 'utf-8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * Build a fixture repo from `{ filename: yamlText }`.
 *
 * Files are written verbatim rather than assembled from a template, because
 * the indentation and value shape ARE the thing under test — a helper that
 * normalised them would test the helper.
 */
function withFixture(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'check-runners-'));
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, '.github', 'workflows', name), text);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const APPROVED = '[self-hosted, Linux, X64, askturret]';

/** A single-job workflow with the given `runs-on:` body spliced in. */
function workflow(runsOnBlock, jobName = 'build') {
  return `name: fixture
on: [push]

jobs:
  ${jobName}:
    ${runsOnBlock}
    steps:
      - run: echo hello
`;
}

const one = (runsOnBlock, jobName) =>
  withFixture({ 'test.yml': workflow(runsOnBlock, jobName) }, run);

// ---------------------------------------------------------------------------
// The four shapes, each asserted compliant-passes / hosted-fails.
// ---------------------------------------------------------------------------

check('flow sequence on the approved pool passes', one(`runs-on: ${APPROVED}`).code, 0);

// THE load-bearing assertion. A parser that only understands the list form
// returns 0 here, and the reintroduction ships.
check('bare string `ubuntu-latest` FAILS', one('runs-on: ubuntu-latest').code, 1);

checkIncludes(
  'the bare-string failure names the offending label',
  one('runs-on: ubuntu-latest').err,
  "'ubuntu-latest'",
);

checkIncludes(
  'the failure names the job it came from',
  one('runs-on: ubuntu-latest', 'publish').err,
  "job 'publish'",
);

check('flow sequence containing a hosted runner FAILS', one('runs-on: [ubuntu-latest]').code, 1);

check(
  'block sequence on the approved pool passes',
  one(`runs-on:
      - self-hosted
      - Linux
      - X64
      - askturret`).code,
  0,
);

check(
  'block sequence containing a hosted runner FAILS',
  one(`runs-on:
      - ubuntu-latest`).code,
  1,
);

check(
  'mapping form with approved `labels` passes',
  one(`runs-on:
      labels: ${APPROVED}`).code,
  0,
);

check(
  'mapping form with a hosted runner in `labels` FAILS',
  one(`runs-on:
      labels: [ubuntu-latest]`).code,
  1,
);

check(
  'mapping form with a nested `labels` sequence passes',
  one(`runs-on:
      labels:
        - self-hosted
        - Linux`).code,
  0,
);

check(
  'mapping form with a hosted runner in a nested `labels` sequence FAILS',
  one(`runs-on:
      labels:
        - ubuntu-latest`).code,
  1,
);

check(
  'mapping form with `group` AND approved `labels` passes',
  one(`runs-on:
      group: askturret-pool
      labels: ${APPROVED}`).code,
  0,
);

// A group name says nothing statically about whether the pool is hosted —
// GitHub-hosted larger runners use groups too. Unverifiable is not verified.
check(
  'mapping form with `group` alone is CANNOT CHECK, not a pass',
  one(`runs-on:
      group: some-pool`).code,
  2,
);

// ---------------------------------------------------------------------------
// Evasions that a naive string comparison would miss.
// ---------------------------------------------------------------------------

check('a quoted hosted runner FAILS', one("runs-on: 'ubuntu-latest'").code, 1);
check('a double-quoted hosted runner FAILS', one('runs-on: "ubuntu-latest"').code, 1);

// GitHub matches labels case-insensitively, so a casing variant is a real
// bypass rather than a hypothetical one.
check('a case-variant hosted runner FAILS', one('runs-on: Ubuntu-Latest').code, 1);

check(
  'approved labels in different casing still pass',
  one('runs-on: [SELF-HOSTED, linux, x64, AskTurret]').code,
  0,
);

// Every label is approved, but nothing pins the job to the self-hosted pool.
check('approved labels omitting `self-hosted` FAIL', one('runs-on: [Linux, X64]').code, 1);

checkIncludes(
  'the missing-`self-hosted` failure explains itself rather than just rejecting',
  one('runs-on: [Linux, X64]').err,
  "omits 'self-hosted'",
);

check('an empty label set FAILS', one('runs-on: []').code, 1);

// Legal GitHub, but the value is decided at run time — so it cannot be
// verified statically, and an unverifiable claim is not a verified one.
check('a `${{ }}` expression FAILS rather than passing', one('runs-on: ${{ matrix.os }}').code, 1);

check(
  'an inline comment after an approved value does not break parsing',
  one(`runs-on: ${APPROVED} # our pool`).code,
  0,
);

check(
  'an inline comment cannot smuggle a hosted runner past the check',
  one('runs-on: ubuntu-latest # self-hosted').code,
  1,
);

// ---------------------------------------------------------------------------
// Reporting behaviour: one pass, every offender.
// ---------------------------------------------------------------------------

const manyOffenders = withFixture(
  {
    'a.yml': `name: a
on: [push]

jobs:
  first:
    runs-on: ubuntu-latest
    steps:
      - run: echo one
  second:
    runs-on: [macos-13]
    steps:
      - run: echo two
`,
    'b.yml': `name: b
on: [push]

jobs:
  third:
    runs-on: windows-latest
    steps:
      - run: echo three
`,
  },
  run,
);

check('multiple offenders across files FAIL', manyOffenders.code, 1);
checkIncludes('offender 1 of 3 is reported', manyOffenders.err, "job 'first'");
checkIncludes('offender 2 of 3 is reported', manyOffenders.err, "job 'second'");
checkIncludes('offender 3 of 3 is reported', manyOffenders.err, "job 'third'");
checkIncludes(
  'all three are reported in ONE pass, not one per run',
  manyOffenders.err,
  '3 problem(s)',
);

// #280 names a NEW workflow file as the likelier route back to a hosted
// runner, and `.yaml` is the extension a newcomer is equally likely to use.
const yamlExt = withFixture(
  { 'legacy.yaml': workflow('runs-on: ubuntu-latest', 'sneaky') },
  run,
);
check('a `.yaml` workflow is scanned, not skipped', yamlExt.code, 1);
checkIncludes('the `.yaml` offender is named', yamlExt.err, "job 'sneaky'");

// ---------------------------------------------------------------------------
// Fail-closed: "could not check" is never "passed".
// ---------------------------------------------------------------------------

check(
  'a job with no `runs-on` at all is CANNOT CHECK, not a pass',
  withFixture(
    {
      'test.yml': `name: fixture
on: [push]

jobs:
  build:
    steps:
      - run: echo hello
`,
    },
    run,
  ).code,
  2,
);

// A reusable-workflow call legitimately has no runner of its own.
check(
  'a job delegating via `uses:` is not treated as an offender',
  withFixture(
    {
      'test.yml': `name: fixture
on: [push]

jobs:
  call:
    uses: ./.github/workflows/other.yml
`,
      'other.yml': workflow(`runs-on: ${APPROVED}`),
    },
    run,
  ).code,
  0,
);

check(
  'a duplicated `runs-on` is CANNOT CHECK rather than picking one',
  one(`runs-on: ${APPROVED}
    runs-on: ubuntu-latest`).code,
  2,
);

check(
  'a workflow with no `jobs:` block is CANNOT CHECK',
  withFixture({ 'test.yml': 'name: fixture\non: [push]\n' }, run).code,
  2,
);

check(
  'an empty `jobs:` block is CANNOT CHECK',
  withFixture({ 'test.yml': 'name: fixture\non: [push]\n\njobs:\n' }, run).code,
  2,
);

check(
  'a directory with no workflow files is CANNOT CHECK, not a vacuous pass',
  withFixture({}, run).code,
  2,
);

check(
  'a missing workflows directory is CANNOT CHECK, not a pass',
  run(join(tmpdir(), 'check-runners-does-not-exist')).code,
  2,
);

// An unterminated flow sequence must not be read as an approved list.
check(
  'a multi-line flow sequence is not silently accepted',
  one(`runs-on: [self-hosted,
      Linux]`).code,
  2,
);

// Precedence: an unreadable job invalidates the whole verdict, so exit 2 wins
// even when real violations were also found — but both are still printed, so
// the reader gets everything in one pass.
const mixed = withFixture(
  {
    'a.yml': `name: a
on: [push]

jobs:
  broken:
    steps:
      - run: echo no-runner
  hosted:
    runs-on: ubuntu-latest
    steps:
      - run: echo hosted
`,
  },
  run,
);
check('CANNOT CHECK outranks a violation', mixed.code, 2);
checkIncludes('the unreadable job is reported', mixed.err, "job 'broken'");
checkIncludes('the violation is still reported alongside it', mixed.err, "job 'hosted'");

// ---------------------------------------------------------------------------
// The guard must be green on the real repository it ships in.
// ---------------------------------------------------------------------------

const realRepo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const real = run(realRepo);
check('the real repository passes its own guard', real.code, 0);
checkIncludes('the real run reports the jobs it actually checked', real.out, 'check-runners: OK');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
