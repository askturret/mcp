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

// For properties that are not an exit code and not a substring — a partition
// holding over a population whose size is nobody's business. `detail` carries
// the actual numbers, so a red says which way it broke rather than just "false".
function checkTrue(desc, condition, detail) {
  if (condition) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc}${detail ? ` (${detail})` : ''}`);
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

// Its paired positive, and the reason it is not optional (#354). Every other
// shape here is asserted in BOTH directions; the bare scalar — the one the
// header calls load-bearing — had only the failing half.
//
// A negative alone does not distinguish "understands bare scalars and judges
// them correctly" from "rejects every bare scalar". Established by mutation
// rather than by reading: with the guard altered to treat EVERY scalar as a
// violation — which would reject legitimate config — the suite stayed green.
// This line is what goes red on that.
check('bare string `self-hosted` PASSES — the paired positive', one('runs-on: self-hosted').code, 0);

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
// Per-job CANNOT-CHECK paths (#354)
//
// The top-level refusals above are all pinned; these seven per-job ones were
// not. Behaviour today is correct — every one of them already refuses — so this
// is coverage rather than a defect. It matters because nothing would catch a
// refactor quietly turning one of these refusals into a pass, which is the #349
// shape: a fail-closed branch with no test is what gets "simplified" into
// fail-open by someone who cannot see what it protects.
//
// EVERY case asserts the SPECIFIC message, not merely exit 2. That is not
// decoration. While building these, a fixture intended for the "content inside
// `jobs:` before any job name" branch did exit 2 — via a DIFFERENT refusal that
// is already asserted elsewhere. On exit code alone it would have looked pinned
// while testing nothing new. An assertion that cannot fail on the thing it
// names is decorative.
// ---------------------------------------------------------------------------

{
  const r = withFixture(
    {
      'test.yml': `name: f
on: [push]

jobs:
  - not-a-job-name
`,
    },
    run,
  );
  check('a non-key entry in the `jobs:` block is CANNOT CHECK', r.code, 2);
  checkIncludes('...and says the entry was unrecognised', r.err, 'unrecognised entry in the `jobs:` block');
}

{
  const r = withFixture(
    {
      'test.yml': `name: f
on: [push]

jobs:
    build:
      runs-on: ${APPROVED}
      steps:
        - run: echo hi
  stray: value
`,
    },
    run,
  );
  check('a line shallower than the job keys but not top-level is CANNOT CHECK', r.code, 2);
  checkIncludes('...and says it is indented less than the job keys', r.err, 'indented less than the job keys');
}

{
  // A job name with nothing under it at all. The guard must not read "no body"
  // as "no violation".
  const r = withFixture(
    {
      'test.yml': `name: f
on: [push]

jobs:
  build:
  other:
    runs-on: ${APPROVED}
`,
    },
    run,
  );
  check('an empty job body is CANNOT CHECK', r.code, 2);
  checkIncludes('...and says the body was empty', r.err, 'the job body is empty');
}

{
  const r = one(`runs-on:
    steps:
      - run: echo hi`);
  check('a `runs-on:` with no value at all is CANNOT CHECK', r.code, 2);
  checkIncludes('...and says the value was empty', r.err, '`runs-on` has an empty value');
}

{
  const r = one(`runs-on:
      flavour: large`);
  check('an unrecognised `runs-on` mapping key is CANNOT CHECK', r.code, 2);
  checkIncludes('...and quotes the key it did not recognise', r.err, 'unrecognised `runs-on` mapping key');
}

{
  // `labels:` with no sequence beneath it. Distinct from `group:` alone, which
  // is asserted above — here labels is PRESENT but unreadable, and a parser that
  // treated an unreadable value as "no labels" would fall through to the group
  // branch and report the wrong reason.
  const r = one(`runs-on:
      labels:
      group: g`);
  check('`runs-on.labels` with no readable value is CANNOT CHECK', r.code, 2);
  checkIncludes('...and says the labels were unreadable', r.err, '`runs-on.labels` has no readable value');
}

// NOT asserted, deliberately, and recorded so the gap is not mistaken for an
// oversight: the `content inside jobs: before any job name` refusal is
// UNREACHABLE through this walk. `jobIndent` is assigned from the FIRST
// non-skippable line in the block, so that line always satisfies
// `indent === jobIndent` and either sets `current` or trips the unrecognised-
// entry refusal above. No later line can therefore find `current === null`.
// Three shapes were tried — a deeper first line, a comment then a deeper line,
// a blank then a deeper line — and all three hit the unrecognised-entry branch
// instead. It is defensive code, and a fixture claiming to reach it would be
// asserting a different branch under its name.

// ---------------------------------------------------------------------------
// THE NARROW PER-JOB CARVE-OUT (#595).
//
// The whole risk of this feature is that it stops being narrow. A carve-out
// that accidentally permits any hosted job is #280 reopened SILENTLY — the
// guard still exits 0, still prints OK, and nothing says the blast radius
// changed. So the negatives below matter more than the positive: each pins one
// axis the carve-out must NOT generalise along.
//
// A carve-out only ever observed PERMITTING has not been shown to be capable of
// REFUSING, which is the property that keeps #280 shut.
// ---------------------------------------------------------------------------

/** The real carve-out's coordinates. Each case below varies exactly one. */
const CARVED_FILE = 'supply-chain.yml';
const CARVED_JOB = 'publish';

const carved = (files) => withFixture(files, run);

// The positive: the exact job, in the exact file, on the exact label.
check(
  'the carved-out job on its exact label PASSES',
  carved({ [CARVED_FILE]: workflow('runs-on: ubuntu-latest', CARVED_JOB) }).code,
  0,
);

// Axis 1 — JOB NAME. Another job in the same file gets nothing.
check(
  'a DIFFERENT job in the carved-out file still FAILS',
  carved({ [CARVED_FILE]: workflow('runs-on: ubuntu-latest', 'build') }).code,
  1,
);

// Axis 2 — FILE. A new workflow file is exactly how #280 says a hosted runner
// comes back, so a filename-blind carve-out would be the dangerous shape.
check(
  'the carved-out job NAME in a different file still FAILS',
  carved({ 'test.yml': workflow('runs-on: ubuntu-latest', CARVED_JOB) }).code,
  1,
);

// Axis 3 — LABEL VALUE. A different hosted runner is not the reviewed job.
check(
  'the carved-out job on a DIFFERENT hosted label still FAILS',
  carved({ [CARVED_FILE]: workflow('runs-on: ubuntu-24.04', CARVED_JOB) }).code,
  1,
);

// Axis 4 — LABEL SET. Gaining a label makes it a different job from the one
// reviewed, so the exemption lapses rather than stretching to cover it.
check(
  'the carved-out job with an EXTRA label still FAILS',
  carved({ [CARVED_FILE]: workflow('runs-on: [ubuntu-latest, gpu]', CARVED_JOB) }).code,
  1,
);

// Casing is presentation, not identity — the same set still passes.
check(
  'the carved-out label set is compared case-insensitively',
  carved({ [CARVED_FILE]: workflow('runs-on: Ubuntu-Latest', CARVED_JOB) }).code,
  0,
);

// Two hosted jobs where only one is carved out. A carve-out that passed the
// FILE rather than the JOB would go green here, which is the #280 reopening in
// its most plausible form.
check(
  'a carved-out job does NOT license a second hosted job beside it',
  carved({
    [CARVED_FILE]: `name: fixture
on: [push]

jobs:
  ${CARVED_JOB}:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
  other:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`,
  }).code,
  1,
);

// The carve-out must be VISIBLE on a green run. An exemption nobody sees is one
// nobody re-examines when the Actions budget is next under pressure.
{
  const r = carved({ [CARVED_FILE]: workflow('runs-on: ubuntu-latest', CARVED_JOB) });
  checkIncludes('a green run names the carve-out in effect', r.out, 'named per-job carve-out(s) in effect');
  checkIncludes('...and says WHY it exists', r.out, 'provenance');
  checkIncludes('...and reports the two populations apart', r.out, 'on the approved self-hosted pool');
}

// The refusal must point at the carve-out rather than at APPROVED_LABELS, and
// must describe the guard's TWO locks accurately.
//
// This message is where someone reads which lever to reach for, so an
// overstatement lands here worst. Telling a reader APPROVED_LABELS is THE lock
// invites them to relax REQUIRED_LABEL as cosmetic — and REQUIRED_LABEL is the
// lock actually holding the line. Established by experiment: widening
// APPROVED_LABELS with the carve-out removed still exits 1, on the
// omits-'self-hosted' branch. A confidently wrong signpost is worse than none.
{
  const r = carved({ 'test.yml': workflow('runs-on: ubuntu-latest', CARVED_JOB) });
  checkIncludes('a hosted refusal names HOSTED_JOB_CARVE_OUTS', r.err, 'HOSTED_JOB_CARVE_OUTS');
  checkIncludes(
    '...and says widening APPROVED_LABELS does NOT by itself permit hosted jobs',
    r.err,
    'does not by itself let anything run hosted',
  );
  checkIncludes('...and names REQUIRED_LABEL as the lock still holding', r.err, 'REQUIRED_LABEL still demands');
}

// ---------------------------------------------------------------------------
// The guard must be green on the real repository it ships in.
// ---------------------------------------------------------------------------

const realRepo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const real = run(realRepo);
check('the real repository passes its own guard', real.code, 0);
checkIncludes('the real run reports the jobs it actually checked', real.out, 'check-runners: OK');

// Pins the real blast radius: EXACTLY ONE job is exempt today. If a second is
// ever added, this line goes red and the addition has to be argued for rather
// than absorbed — which is the whole point of keeping the carve-out narrow.
//
// This literal STAYS. Here the number IS the property: the carve-out set is
// deliberately narrow, and the correct response to a red is to argue the
// addition, not to bump the count. Contrast the self-hosted population below.
// ADR-024 draws exactly this line — "is the number the property, or a
// by-product of it?" — and rules that pinned counts are not automatically
// defects.
checkIncludes(
  'exactly one job in the real repository is on a hosted carve-out',
  real.out,
  '1 on a named per-job hosted carve-out',
);

// ...and the rest remain self-hosted. Asserted as a PARTITION, never as a tally.
//
// This line used to pin '23 on the approved self-hosted pool'. That number is a
// BY-PRODUCT: the self-hosted population grows whenever any job is added
// anywhere in the repository, so the literal reddened on changes that had
// nothing to do with runners, and the only available response was to bump it —
// which guarantees it reddens again and makes the bump reflexive. ADR-024 names
// that the tally trap and cites this exact line as its example. It went red for
// the third job this branch adds to reliability-nightly.yml; bumping 23 -> 24
// would have reproduced the defect with a later expiry date.
//
// What must hold at ANY count is the property the assertion's name already
// claims: the two populations are exhaustive and disjoint over the jobs the
// guard actually checked. Every job is either on the approved pool or on a
// NAMED carve-out, with nothing falling between them.
const summary = real.out.split('\n').find((l) => l.startsWith('check-runners: OK'));
checkTrue('the real run prints a summary line to read the populations off', summary !== undefined);

const countIn = (re) => {
  const m = re.exec(summary ?? '');
  return m ? Number(m[1]) : null;
};
const jobsChecked = countIn(/OK — (\d+) job\(s\) checked/);
const selfHosted = countIn(/(\d+) on the approved self-hosted pool/);
const carveOuts = countIn(/(\d+) on a named per-job hosted carve-out/) ?? 0;
const populations = `checked ${jobsChecked}, pool ${selfHosted}, carve-outs ${carveOuts}`;

checkTrue(
  '...and the rest remain self-hosted: the two populations partition the jobs checked',
  jobsChecked !== null && selfHosted !== null && selfHosted + carveOuts === jobsChecked,
  populations,
);

// A partition is satisfied trivially by 0 + 0 === 0, which is exactly what a
// guard that discovered nothing would print. Absence of a result must not read
// as a pass (ADR-024), so the population has to be non-empty for the assertion
// above to mean anything.
checkTrue(
  '...over a non-empty population, so a guard that scanned nothing cannot pass here',
  jobsChecked !== null && jobsChecked > carveOuts,
  populations,
);

// The carve-out tally must be backed by the same number of NAMED entries. A
// count that cannot be traced back to a name is the exemption going quiet,
// which is the one thing the carve-out reporting exists to prevent.
const namedCarveOuts = real.out.split('\n').filter((l) => l.startsWith('  - ')).length;
checkTrue(
  'every carve-out counted in the summary is also named on the run',
  namedCarveOuts === carveOuts,
  `named ${namedCarveOuts}, counted ${carveOuts}`,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
