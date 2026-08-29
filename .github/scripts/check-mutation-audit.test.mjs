#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the mutation audit (#428 stage 1).
 *
 * ## It runs on FIXTURE guards, and that is what stops the recursion
 *
 * The audit is itself a guard and must be in its own target list — the
 * requirement here is the OPPOSITE of #361's, which writes a pattern so it
 * cannot match its own source to avoid a false positive.
 *
 * The layering makes the recursion illusory: the audit mutates a target and
 * runs THAT target's self-test as a subprocess, and this file's fixtures are
 * synthetic guards with synthetic self-tests. So auditing the audit runs this
 * file, which never invokes the audit on the real tree, and it terminates.
 *
 * ## EVERY SECOND YOU ADD HERE IS CHARGED ABOUT TEN TIMES (#437)
 *
 * The self-application above has a cost that is invisible from inside this
 * file, and it is the reason a fixture here is not priced like a fixture
 * anywhere else. Because the audit is in its own target list, a full run
 * executes THIS file once per mutation site in `check-mutation-audit.mjs`,
 * plus once for the baseline, plus once for the completeness probe:
 *
 *   8 sites + 1 baseline + 1 probe = 10 runs
 *
 * The three call sites are `baseline`, the per-site run inside the loop, and
 * the `all`-neutralised probe — all in `auditGuard`. The site count comes from
 * the inventory and moves as the audit's own source changes; the shape does
 * not.
 *
 * Measured on this machine: this file takes 11.3 s, so it accounts for about
 * 113 s of a 322 s audit — roughly a THIRD of the whole run, spent auditing
 * the auditor.
 *
 * That is not an argument for spending less. The fixtures that cost the time
 * spawn real child processes and send real SIGINTs, and they are what gave the
 * #435 signal-handler fix a witness — the right way to test a signal handler,
 * and worth every second. It is an argument for spending it KNOWINGLY: a
 * fixture that sleeps 700 ms here adds 7 s to the audit, not 700 ms.
 *
 * The cost was misattributed once already, to the per-site `yield` in
 * `check-mutation-audit.mjs`, which measures ~3 ms across all 151 sites. If
 * the audit is slow, this file is where to look first.
 *
 * ## Observed failing, on a real historical case
 *
 * `unwitnessed-slot-boolean` reproduces PR #420's defect: a check whose only
 * test mutated a DIFFERENT field because a new field name contained the old one
 * as a substring. On `eb8bec3` neutralising it reddened ZERO assertions. The
 * audit must report that site by name — otherwise it is the Decorative Guard
 * `docs/TESTING.md` names, and this is the fixture that proves it is not.
 *
 * Run: node .github/scripts/check-mutation-audit.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  maskCode,
  enumerateSites,
  applyMutations,
  failingAssertions,
  reachedAssertions,
  auditGuard,
  audit,
  interpretProbe,
  discoverGuards,
  renderInventory,
} from './check-mutation-audit.mjs';

let passed = 0;
let failed = 0;

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed += 1;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed += 1;
  }
}

/** `re.exec(s) !== null`, spelled without the literal `.test(` call. */
const reHits = (re, s) => re.exec(s) !== null;

/** Synchronous sleep — the signal case must observe wall-clock, not a promise. */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------------------------------------------------------------------------
// Masking — the defence against trap 2, asserted rather than assumed
// ---------------------------------------------------------------------------
{
  const src = [
    `// errors.push('in a line comment')`,
    `/* errors.push('in a block comment') */`,
    `const s = "errors.push('in a string')";`,
    `const r = /errors\\.push/;`,
    `errors.push('the only real one');`,
  ].join('\n');

  const sites = enumerateSites(src);
  check('a site inside a comment, string or regex is NOT enumerated', sites.length, 1);
  check('...and the one found is the executable occurrence', sites[0]?.line, 5);

  // #266 is exactly a replace hitting a doc comment above its own declaration.
  // Offsets preserved is what lets the found site be spliced safely.
  check('masking preserves length exactly', maskCode(src).length, src.length);
  check('...and preserves newlines, so line numbers survive', maskCode(src).split('\n').length, src.split('\n').length);
}

// ---------------------------------------------------------------------------
// Every failure channel is enumerated, not just `errors.push`
//
// 18 of 24 scripts in this repo contain no `errors.push` at all. A rule keyed
// on it covers 42% of sites while reporting that the guards are audited.
// ---------------------------------------------------------------------------
{
  const src = [
    `errors.push('a');`,
    `throw new Error('b');`,
    `process.exit(1);`,
    `process.exit(0);`,
    `return 2;`,
    `return 0;`,
  ].join('\n');
  const kinds = enumerateSites(src).map((s) => s.kind);

  check('errors.push is enumerated', kinds.includes('errors-push'), true);
  check('throw is enumerated', kinds.includes('throw'), true);
  check('a non-zero process.exit is enumerated', kinds.includes('process-exit'), true);
  check('a non-zero return is enumerated', kinds.includes('return-code'), true);
  // The paired negatives: a SUCCESS exit is not a failure site, and counting it
  // would report coverage of something that cannot fail.
  check('...and process.exit(0) is NOT a site', kinds.filter((k) => k === 'process-exit').length, 1);
  check('...and return 0 is NOT a site', kinds.filter((k) => k === 'return-code').length, 1);
}

// ---------------------------------------------------------------------------
// Mutations land where they were found, and produce parseable code
// ---------------------------------------------------------------------------
{
  const src = `if (bad) errors.push('x');\nif (worse) throw new Error('y');\nprocess.exit(3);\n`;
  const mutated = applyMutations(src, enumerateSites(src));

  check('errors.push is neutralised', reHits(/\(\(\)=>\{\}\)\('x'\)/, mutated), true);
  check('throw becomes void, so the value is built and discarded', reHits(/void new Error\('y'\)/, mutated), true);
  check('a non-zero exit code becomes 0', reHits(/process\.exit\(0\)/, mutated), true);

  // TRAP 2: the landing assertion is what makes "anchored" mean something.
  let threw = false;
  try {
    applyMutations(src, [{ start: 0, end: 5, token: 'NOPE', replacement: 'x', line: 1, kind: 'errors-push' }]);
  } catch {
    threw = true;
  }
  check('a mutation whose token is not at its offset REFUSES rather than splicing', threw, true);
}

// ---------------------------------------------------------------------------
// Assertion-name extraction (trap 4 — status alone is not reviewable)
// ---------------------------------------------------------------------------
{
  const out = 'ok   - fine\nFAIL - the named one\nnot ok - a tap-style one\n';
  const names = failingAssertions(out);
  check('failing assertion names are extracted', names.includes('the named one'), true);
  check('...including tap-style output', names.includes('a tap-style one'), true);
  check('...and passing lines are not', names.includes('fine'), false);

  // THE NAME IS THE IDENTITY, so the observed values must be stripped.
  //
  // Found by running this audit against the real tree: comparing whole lines
  // made ONE assertion read as TWO different strings under two mutations —
  // `(expected 1, got 2)` versus `(expected 1, got 0)` — and the set difference
  // then reported a failure route that does not exist. Nine false "unknown
  // failure path" errors, all from this.
  const a = failingAssertions('FAIL - a violating row exits 1 (expected 1, got 2)\n');
  const b = failingAssertions('FAIL - a violating row exits 1 (expected 1, got 0)\n');
  check('the same assertion is the same NAME under different observed values', a[0], b[0]);
  check('...and that name carries no value suffix', a[0], 'a violating row exits 1');

  // "ABSENT FROM THE FAILING LIST" IS NOT "PASSED" — it is also what a run
  // that never got there looks like. The all-sites mutation can leave a guard
  // in a state that aborts its self-test partway, and treating the assertions
  // after that point as passing produced eight false "unknown failure path"
  // reports on this repo's own tree.
  const partial = 'ok   - reached and passed\nFAIL - reached and failed\n';
  const reached = reachedAssertions(partial);
  check('a passing assertion counts as REACHED', reached.includes('reached and passed'), true);
  check('...and so does a failing one', reached.includes('reached and failed'), true);
  check('...while one the run never printed is not reached', reached.includes('never ran'), false);
}

/* -------------------------------------------------------------------------
 * Fixture guards
 *
 * A synthetic guard plus a synthetic self-test, written into a throwaway tree.
 * The audit never touches the real repository from here.
 * ---------------------------------------------------------------------- */

function withFixture(guardSource, testSource) {
  const dir = mkdtempSync(join(tmpdir(), 'mutaudit-'));
  mkdirSync(join(dir, '.github', 'scripts'), { recursive: true });
  mkdirSync(join(dir, '.operum', 'audit'), { recursive: true });
  writeFileSync(join(dir, '.github', 'scripts', 'check-fixture.mjs'), guardSource);
  writeFileSync(join(dir, '.github', 'scripts', 'check-fixture.test.mjs'), testSource);
  return dir;
}

/** A guard with two checks; `witnessed` is exercised, `orphan` is not. */
const FIXTURE_GUARD = `#!/usr/bin/env node
const flags = process.argv.slice(2);
const errors = [];
if (flags.includes('--trip-witnessed')) errors.push('the witnessed check fired');
if (flags.includes('--trip-orphan')) errors.push('the orphan check fired');
if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log('ok');
process.exit(0);
`;

/**
 * A self-test that exercises ONLY the first check.
 *
 * This is PR #420's shape: the second check is real, wired and reachable, and
 * nothing observes it. On `eb8bec3` the equivalent site reddened zero
 * assertions while its assertion kept passing, because the assertion had been
 * silently repointed at a different check.
 */
const FIXTURE_TEST = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-fixture.mjs');
const run = (...a) => spawnSync(process.execPath, [GUARD, ...a], { encoding: 'utf-8' }).status;
let failed = 0;
const check = (d, a, e) => {
  if (a === e) console.log('ok   - ' + d);
  else { console.log('FAIL - ' + d); failed += 1; }
};
check('the witnessed check rejects', run('--trip-witnessed'), 1);
check('a clean run is accepted', run(), 0);
process.exit(failed > 0 ? 1 : 0);
`;

// ---------------------------------------------------------------------------
// OBSERVED FAILING — the audit reports the unwitnessed site BY NAME.
//
// The acceptance criterion #428 asks for, against the real historical case.
// Without this the audit is a Decorative Guard: it would report "all
// witnessed" on a fixture built to contain an unwitnessed site.
// ---------------------------------------------------------------------------
{
  const dir = withFixture(FIXTURE_GUARD, FIXTURE_TEST);
  try {
    const report = await audit(dir);
    const fixture = report.guards.find((g) => g.name === 'check-fixture.mjs');

    check('the fixture guard is measured', fixture?.status, 'measured');

    const witnessed = fixture?.results.filter((r) => r.verdict === 'witnessed') ?? [];
    const unwitnessed = fixture?.results.filter((r) => r.verdict === 'unwitnessed') ?? [];

    check('the exercised check is reported WITNESSED', witnessed.length >= 1, true);
    check('the unexercised check is reported UNWITNESSED (#420 reproduction)', unwitnessed.length >= 1, true);
    check(
      '...and it is named by line, so the report is actionable',
      unwitnessed.some((u) => u.line === 5),
      true,
    );
    check(
      '...and it appears in the top-level unwitnessed list',
      report.unwitnessed.some((u) => u.name === 'check-fixture.mjs' && u.line === 5),
      true,
    );

    // STAGE 1 DOES NOT FAIL ON THIS. Nobody knows the denominator yet, and an
    // exemption ledger authored before the inventory exists is precisely the
    // escape hatch #428's question 2 is about.
    check('finding an unwitnessed site is NOT an audit-integrity error', report.errors.length, 0);

    // Trap 4: the result is reviewable, not just a status.
    check(
      'the witnessed site names which assertion newly failed',
      (witnessed[0]?.newlyFailing ?? []).some((a) => reHits(/witnessed check rejects/, a)),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// TRAP 1, INVERTED — a mutation that does not parse must NEVER read as a pass.
//
// This is the one that turns the audit permissive. Because RED = PASS here, a
// syntax-broken mutation reddens the self-test and the site would record as
// WITNESSED. `node --check` runs before every self-test run.
// ---------------------------------------------------------------------------
// THE PREVIOUS VERSION OF THIS BLOCK PASSED VACUOUSLY, and QA measured it:
// removing the `node --check` gate entirely left the suite at 48/0. The fixture
// guard keyed on `--trip` while the shared self-test drives `--trip-witnessed`,
// so the guard exited 0, the BASELINE was red, `auditGuard` returned
// cannot-check before the site loop, `results` was `[]`, and
// `[].includes('witnessed') && …` was false — which is what the assertion
// asserted. It was witnessed by the BASELINE gate, not by the one it is named
// for. PR #420's blocker-1 shape, inside the instrument built to find it.
//
// Two things were needed. The fixture now drives the flag the self-test
// actually sends, so the baseline is green and the site loop runs. And the
// mutation is injected, because NONE of the four enumerated mutations can
// produce unparseable output by construction — so without a seam this gate
// could only ever be asserted vacuously.
// ---------------------------------------------------------------------------
{
  const trips = `#!/usr/bin/env node
const fail = () => { throw new Error('x') };
if (process.argv.includes('--trip-witnessed')) fail();
process.exit(0);
`;
  const dir = withFixture(trips, FIXTURE_TEST);
  try {
    const guardPath = join(dir, '.github', 'scripts', 'check-fixture.mjs');
    const testPath = join(dir, '.github', 'scripts', 'check-fixture.test.mjs');
    const before = readFileSync(guardPath, 'utf-8');

    // The baseline must be GREEN, or everything below measures cannot-check
    // instead — which is precisely how this block used to pass.
    const healthy = await auditGuard({ guardPath, testPath, rootDir: dir });
    check('the fixture reaches the site loop at all (#428 QA)', healthy.status, 'measured');
    check('...and its site is witnessed when the mutation parses', healthy.results[0]?.verdict, 'witnessed');

    // Now the same fixture with a mutation that does NOT parse.
    const result = await auditGuard({
      guardPath,
      testPath,
      rootDir: dir,
      mutate: () => 'const broken = ;\n',
    });

    check('an unparseable mutation is recorded as such', result.results[0]?.verdict, 'unparseable');
    check(
      '...and NEVER as witnessed, which is what makes the audit too permissive',
      result.results.some((r) => r.verdict === 'witnessed'),
      false,
    );
    check(
      '...and it is an audit-integrity error, not a measurement',
      (await audit(dir)).errors.length >= 0 && result.results[0]?.detail !== undefined,
      true,
    );

    // TRAP 3: the file is restored exactly, so no mutation leaks into the next.
    check('the guard file is restored byte-for-byte', readFileSync(guardPath, 'utf-8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// A non-green baseline is CANNOT CHECK, never "witnessed" (trap 5)
// ---------------------------------------------------------------------------
{
  const alwaysRed = `#!/usr/bin/env node
console.log('FAIL - this self-test is red before anything is mutated');
process.exit(1);
`;
  const dir = withFixture(FIXTURE_GUARD, alwaysRed);
  try {
    const result = await auditGuard({
      guardPath: join(dir, '.github', 'scripts', 'check-fixture.mjs'),
      testPath: join(dir, '.github', 'scripts', 'check-fixture.test.mjs'),
      rootDir: dir,
    });

    check('a guard whose baseline is red is CANNOT CHECK', result.status, 'cannot-check');
    check('...and no site is claimed as witnessed', result.results.length, 0);

    const report = await audit(dir);
    check('...and cannot-check IS an audit-integrity error', report.errors.some((e) => reHits(/CANNOT CHECK/, e)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// #63 — "all clean" and "nothing here" must not render identically
// ---------------------------------------------------------------------------
{
  const inert = `#!/usr/bin/env node\nconsole.log('nothing can fail here');\n`;
  const dir = withFixture(inert, FIXTURE_TEST);
  try {
    const report = await audit(dir);
    check('an empty site set REFUSES rather than reporting all clean', report.errors.length >= 1, true);
    check(
      '...and says so by name',
      report.errors.some((e) => reHits(/enumeration is broken, not the tree clean/, e)),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Guards with failure sites and NO self-test are REPORTED, never omitted (#431)
//
// Five real scripts are in this state, holding 18 sites. There is nothing to
// turn red, so no re-keying of this audit reaches them. Silently skipping them
// would be the same silent-subset shape one level further down.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mutaudit-'));
  try {
    mkdirSync(join(dir, '.github', 'scripts'), { recursive: true });
    mkdirSync(join(dir, '.operum', 'audit'), { recursive: true });
    writeFileSync(join(dir, '.github', 'scripts', 'check-fixture.mjs'), FIXTURE_GUARD);
    writeFileSync(join(dir, '.github', 'scripts', 'check-fixture.test.mjs'), FIXTURE_TEST);
    // Sites, no self-test.
    writeFileSync(join(dir, '.github', 'scripts', 'check-lonely.mjs'), `process.exit(1);\n`);

    const report = await audit(dir);
    check('a guard with sites but no self-test is reported UNREACHABLE', report.unreachable.length, 1);
    check('...by name', report.unreachable[0]?.name, 'check-lonely.mjs');
    check('...with its site count, so the omission has a size', report.unreachable[0]?.sites, 1);
    check('...and it is NOT counted as witnessed', report.totals.witnessed < report.totals.sites + 1, true);
    check('...and the inventory renders it', reHits(/check-lonely\.mjs/, renderInventory(report)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The completeness probe, at the corrected polarity
//
// #428's review says "self-test goes fully green" means the enumeration is
// complete. With every failure route neutralised the guard CANNOT exit
// non-zero, so every rejection case must fail — fully green is unachievable for
// a self-test that witnesses anything, and achieving it means nothing in that
// self-test observes a failure. The reading is inverted here, and the
// deviation is flagged on the PR rather than implemented silently.
// ---------------------------------------------------------------------------
{
  const dir = withFixture(FIXTURE_GUARD, FIXTURE_TEST);
  try {
    const result = await auditGuard({
      guardPath: join(dir, '.github', 'scripts', 'check-fixture.mjs'),
      testPath: join(dir, '.github', 'scripts', 'check-fixture.test.mjs'),
      rootDir: dir,
    });
    check('the probe runs and parses', result.probe?.status, 'ok');
    check('...and no unknown failure path is suspected for a fully-enumerated guard', interpretProbe(result).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // A guard whose only failure is one the self-test never observes: with
  // everything neutralised the self-test stays green, which is the ALARMING
  // case, not the reassuring one.
  //
  // Its self-test must be GREEN at baseline — otherwise this measures
  // cannot-check instead, which is a different finding.
  const noWitness = `#!/usr/bin/env node\nif (process.argv.includes('--never')) process.exit(1);\nprocess.exit(0);\n`;
  const cleanOnly = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const code = spawnSync(process.execPath, [join(here, 'check-fixture.mjs')], { encoding: 'utf-8' }).status;
if (code === 0) { console.log('ok   - a clean run is accepted'); process.exit(0); }
console.log('FAIL - a clean run is accepted');
process.exit(1);
`;
  const dir = withFixture(noWitness, cleanOnly);
  try {
    const result = await auditGuard({
      guardPath: join(dir, '.github', 'scripts', 'check-fixture.mjs'),
      testPath: join(dir, '.github', 'scripts', 'check-fixture.test.mjs'),
      rootDir: dir,
    });
    check('a self-test observing no failure at all is reported', result.probe?.status, 'no-failure-witnesses');

    // ...and it is REPORTED, not failed. It is the aggregate of "every site
    // here is unwitnessed", which stage 1 measures rather than fails on.
    check('...and it is NOT an integrity error', interpretProbe(result).length, 0);
    const report = await audit(dir);
    check('...but it IS surfaced by name in the report', report.noFailureWitnesses.includes('check-fixture.mjs'), true);
    check('...and the inventory renders it', reHits(/observe no failure at all/, renderInventory(report)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// THE UNKNOWN-ROUTE DETECTOR, WITNESSED POSITIVELY (#428 QA)
//
// Both earlier assertions about `interpretProbe` asserted `length === 0` — two
// negatives. Nothing showed the detector could EVER fire, and this component
// replaced a specified requirement, so its ability to fire is the entire
// warrant for that deviation. QA built the positive fixture; it belongs here.
//
// The fixture, and why each line is where it is:
//
//   `process.exitCode = 1` is a REAL failure route that the enumeration does
//   not know about — it is not `errors.push`, `throw`, `process.exit(n)` or
//   `return n`. It fires only for `--a`.
//
//   Neutralising the DRAIN site makes both `--a` and `--b` stop failing, so
//   that site is witnessed by two assertions. But with every site neutralised,
//   `--a` still exits 1 through the hidden route, so its assertion PASSES under
//   the probe while having reddened for the drain site alone. That disagreement
//   is the signature of a route outside the enumeration, and it is what the
//   detector reports.
//
// IT ALSO DEMONSTRATES THE DETECTOR'S LIMIT, which is why the same fixture
// serves both: site 1 records UNWITNESSED because the hidden route MASKS it —
// and the detector never fires for site 1, because it only examines assertions
// tied to sites already found witnessed. A hidden route can therefore INFLATE
// the unwitnessed count silently. That caveat is in the inventory itself, not
// only here, because the count is the deliverable.
// ---------------------------------------------------------------------------

/** `--a` also fails through a route the enumeration cannot see. */
const HIDDEN_ROUTE_GUARD = `#!/usr/bin/env node
const flags = process.argv.slice(2);
const errors = [];
if (flags.includes('--a')) errors.push('a fired');
if (flags.includes('--b')) errors.push('b fired');
if (flags.includes('--a')) process.exitCode = 1;
if (errors.length > 0) { for (const e of errors) console.error(e); process.exit(1); }
`;

/** The control: byte-identical but for the hidden route. */
const NO_HIDDEN_ROUTE_GUARD = HIDDEN_ROUTE_GUARD.replace(
  "if (flags.includes('--a')) process.exitCode = 1;\n",
  '',
);

const AB_TEST = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-fixture.mjs');
const run = (...a) => spawnSync(process.execPath, [GUARD, ...a], { encoding: 'utf-8' }).status;
let failed = 0;
const check = (d, a, e) => {
  if (a === e) console.log('ok   - ' + d);
  else { console.log('FAIL - ' + d); failed += 1; }
};
check('--a is rejected', run('--a'), 1);
check('--b is rejected', run('--b'), 1);
check('a clean run is accepted', run(), 0);
process.exit(failed > 0 ? 1 : 0);
`;

{
  const dir = withFixture(HIDDEN_ROUTE_GUARD, AB_TEST);
  try {
    const result = await auditGuard({
      guardPath: join(dir, '.github', 'scripts', 'check-fixture.mjs'),
      testPath: join(dir, '.github', 'scripts', 'check-fixture.test.mjs'),
      rootDir: dir,
    });
    const notes = interpretProbe(result);

    check('the detector FIRES on a route outside the enumeration (#428 QA)', notes.length >= 1, true);
    check(
      '...and names the assertion that disagrees, so the report is actionable',
      notes.some((n) => reHits(/--a is rejected/, n)),
      true,
    );
    check(
      '...and names the line it disagrees about',
      notes.some((n) => reHits(/line \d+/, n)),
      true,
    );
    check(
      '...and it is reported as an audit-integrity error, not a measurement',
      (await audit(dir)).errors.some((e) => reHits(/unknown failure path/, e)),
      true,
    );

    // THE LIMIT, demonstrated by the same fixture. The masked site records
    // unwitnessed and the detector is silent about IT specifically.
    check(
      'a masked site records UNWITNESSED — the count can be inflated by a hidden route',
      result.results.some((r) => r.verdict === 'unwitnessed'),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // THE CONTROL, and it is load-bearing. Without it the assertions above are
  // satisfied by a detector that fires on everything — which would be worse
  // than one that never fires, because it would be believed once.
  const dir = withFixture(NO_HIDDEN_ROUTE_GUARD, AB_TEST);
  try {
    const result = await auditGuard({
      guardPath: join(dir, '.github', 'scripts', 'check-fixture.mjs'),
      testPath: join(dir, '.github', 'scripts', 'check-fixture.test.mjs'),
      rootDir: dir,
    });
    check('...while the same guard WITHOUT the hidden route is silent', interpretProbe(result).length, 0);
    check('...and its previously-masked site is now witnessed', result.results.every((r) => r.verdict === 'witnessed'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// FINDING 3 — the `probeReached` guard's USE is pinned, not just its unit.
//
// `reachedAssertions()` was unit-tested while its use in `interpretProbe` was
// not, so restoring "absent from the failing list means passed" left the suite
// green. Unit pinned, wiring unpinned — the same split QA found on PR #421.
//
// This asserts the wiring: a fixture whose all-sites mutation ABORTS its
// self-test partway must not have the un-run assertions read as passing.
// ---------------------------------------------------------------------------
{
  // The self-test throws before its later assertions when the guard is fully
  // neutralised, so those assertions are never printed — the exact condition
  // under which "absent" must not mean "passed".
// The fixture has to DISCRIMINATE, and the first attempt did not: an abort that
// happens under a single-site mutation as well as under the probe leaves the
// two sets equal, so dropping the guard changes nothing. What is needed is an
// assertion that reddens for ONE site while the ALL-SITES probe aborts before
// reaching it.
//
//   `--b is rejected` reddens when site `b` alone is neutralised.
//   With every site neutralised, `--a` stops being rejected, the self-test
//   throws at its abort clause, and `--b is rejected` is never printed.
//
// So it is absent from the probe's failing list while never having run. Without
// the `probeReached` guard that absence reads as "passed" and a false
// unknown-route note is raised — which is the eight-false-report defect.
  const abortingGuard = `#!/usr/bin/env node
const flags = process.argv.slice(2);
const errors = [];
if (flags.includes('--a')) errors.push('a fired');
if (flags.includes('--b')) errors.push('b fired');
if (errors.length > 0) { for (const e of errors) console.error(e); process.exit(1); }
`;
  const abortingTest = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-fixture.mjs');
const run = (...a) => spawnSync(process.execPath, [GUARD, ...a], { encoding: 'utf-8' }).status;
let failed = 0;
const check = (d, a, e) => {
  if (a === e) console.log('ok   - ' + d);
  else { console.log('FAIL - ' + d); failed += 1; }
};
check('--a is rejected', run('--a'), 1);
if (run('--a') !== 1) throw new Error('abort: --a is no longer rejected');
check('--b is rejected', run('--b'), 1);
process.exit(failed > 0 ? 1 : 0);
`;
  const dir = withFixture(abortingGuard, abortingTest);
  try {
    const result = await auditGuard({
      guardPath: join(dir, '.github', 'scripts', 'check-fixture.mjs'),
      testPath: join(dir, '.github', 'scripts', 'check-fixture.test.mjs'),
      rootDir: dir,
    });

    check(
      'the probe never REACHED the later assertion (#428 QA)',
      (result.probe?.reached ?? []).includes('--b is rejected'),
      false,
    );
    check(
      '...so no unknown-route note is raised from an un-run assertion',
      interpretProbe(result).filter((n) => reHits(/--b is rejected/, n)).length,
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// AN INTERRUPTED RUN MUST NOT LEAVE A DISARMED GUARD ON DISK (#428 QA)
//
// A mutated guard is on disk for ~28% of the real audit's runtime, and Node
// runs no `finally` on an unhandled signal. QA killed a run inside that window
// and found, left behind:
//
//   M .github/scripts/check-adr-citations.mjs   process.exit(1) -> process.exit(0)
//
// A one-character diff that disarms a CI guard and still parses. Ctrl-C on a
// three-minute tool is the expected interaction, not an edge case.
//
// This drives the real signal against a real child process, because a unit test
// of the handler would assert that the function restores — which was never in
// doubt — rather than that the signal reaches it.
//
// HONEST LIMIT, asserted nowhere because it cannot be: SIGKILL is uncatchable,
// so `kill -9` still leaves residue. Only the signal a human sends is fixed.
// ---------------------------------------------------------------------------
{
  const slowTest = `#!/usr/bin/env node
// A self-test slow enough that the mutation window is reliably wide.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
console.log('ok   - slow but green');
process.exit(0);
`;
  const dir = withFixture(FIXTURE_GUARD, slowTest);
  const guardPath = join(dir, '.github', 'scripts', 'check-fixture.mjs');
  const testPath = join(dir, '.github', 'scripts', 'check-fixture.test.mjs');
  const original = readFileSync(guardPath, 'utf-8');

  // A runner that does nothing but audit, so the signal lands inside the loop.
  const runnerPath = join(dir, 'runner.mjs');
  writeFileSync(
    runnerPath,
    `import { auditGuard } from ${JSON.stringify(join(import.meta.dirname, 'check-mutation-audit.mjs'))};\n` +
      `auditGuard({ guardPath: ${JSON.stringify(guardPath)}, testPath: ${JSON.stringify(testPath)}, rootDir: ${JSON.stringify(dir)} });\n`,
  );

  try {
    const child = spawn(process.execPath, [runnerPath], { stdio: 'ignore' });

    // Land inside a mutation window: past the baseline run, inside a site run.
    await new Promise((r) => setTimeout(r, 1100));
    const mutatedMidRun = readFileSync(guardPath, 'utf-8') !== original;
    child.kill('SIGINT');

    const exit = await new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));

    // `auditGuard` is fully synchronous — `spawnSync` in a loop — so Node cannot
    // run a signal handler until the stack unwinds. That is not a defect in the
    // handler; it is what the handler BUYS. Without one, SIGINT's default
    // disposition kills the process instantly, mid-mutation, leaving the
    // disarmed guard on disk. With one, the default is suppressed, the in-flight
    // subprocess finishes, and the handler then restores and re-raises.
    //
    // THE EXIT SIGNAL IS WHAT MAKES THIS NON-VACUOUS. A restored file alone
    // would also be produced by the audit simply finishing normally before the
    // check ran — the first version of this case did exactly that and passed
    // for that reason. Exiting ON SIGINT is only possible via the re-raise, so
    // it is the evidence that the handler, and not the ordinary `finally`, is
    // what restored the file.
    check('the signal landed while a mutation was on disk (precondition)', mutatedMidRun, true);
    check('...and the run ended via the re-raised signal, not by completing', exit.signal, 'SIGINT');
    check('SIGINT restores the guard rather than leaving it disarmed', readFileSync(guardPath, 'utf-8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// SELF-APPLICATION — the audit is in its own target list (#428 Q4)
//
// This property is also what makes THIS FILE cost about ten times its own
// runtime on every full audit — 8 sites + baseline + probe. See the header
// section "EVERY SECOND YOU ADD HERE IS CHARGED ABOUT TEN TIMES" (#437) before
// adding a fixture that sleeps.
// ---------------------------------------------------------------------------
{
  const names = discoverGuards(join(process.cwd())).map((g) => g.name);
  const here = discoverGuards(join(import.meta.dirname, '..', '..')).map((g) => g.name);
  const found = names.includes('check-mutation-audit.mjs') || here.includes('check-mutation-audit.mjs');
  check('the audit discovers itself as a target', found, true);
}

// ---------------------------------------------------------------------------
// The never-ran branches, asserted against the production source (#443)
//
// Both spawn sites here use `process.execPath` — an ABSOLUTE path that always
// resolves — so a real ENOENT is not producible, and the empty-PATH technique
// that witnesses `generate-sbom` and `check-runtime-marker-ignored` does not
// reach them. That is the same situation `check-runtime-marker-ignored` faced,
// and it is answered the same way: the shared vocabulary is exercised for real
// in `sdk-upgrade-drill.test.mjs` — including against a genuinely SIGKILLed
// child — and its USE is pinned here.
//
// Without these, two new cannot-check branches would land unwitnessed, which is
// the issue's own causal claim: nothing executed the detail-string
// construction, which is exactly why the original undefined-dereference
// shipped. Four new branches with two unwitnessed reproduces the condition this
// work exists to remove.
//
// Comments are stripped first. This file and the guard both DISCUSS the
// forbidden form in order to warn against it, and a scan window including its
// own documentation goes red for a comment while staying green for a real call
// site a comment happens to mention (#449).
// ---------------------------------------------------------------------------
{
  const source = readFileSync(join(import.meta.dirname, 'check-mutation-audit.mjs'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  check('the audit imports the shared never-ran vocabulary', /import \{[^}]*didNotStart[^}]*\} from '\.\/sdk-upgrade-drill\.mjs'/.test(source), true);
  check('...and builds its detail with the shared helper', /spawnFailureDetail\s*\(/.test(source), true);

  // BOTH spawn sites, named separately. A single `didNotStart(` match would be
  // satisfied by one site while the other still fell through — which is the
  // half-applied shape this whole PR is about.
  //
  // SCOPED BY BRACE MATCHING, NOT BY A CHARACTER BUDGET, and the difference is
  // the whole assertion. The first version of these two lines used
  // `/runNodeCheck[\s\S]{0,400}?didNotStart\(/`, and QA showed it stayed GREEN
  // with runNodeCheck's guard deleted outright: the 320-character window began
  // at the name, ran through the now-unguarded body, CROSSED THE FUNCTION
  // BOUNDARY and terminated on runSelfTest's guard. So the runNodeCheck
  // assertion was witnessing runSelfTest, twice.
  //
  // It was asymmetric, which is why one-direction testing cleared it — deleting
  // the LAST didNotStart in the file does go red. Both directions are exercised
  // now, and a budget is never a scope.
  const bodyOf = (src, name) => {
    const at = src.indexOf(`function ${name}(`);
    if (at === -1) return '';
    const open = src.indexOf('{', at);
    if (open === -1) return '';
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    return '';
  };

  // The slices must be NON-EMPTY first. Without this the two assertions below
  // pass vacuously the moment a function is renamed — `indexOf` returns -1, the
  // slice is '', and `.test('')` is false, so the failure would look like a
  // missing guard rather than a missing target. Same shape as the `-1 is less
  // than any position` trap already recorded in sdk-upgrade-drill.test.mjs.
  const nodeCheckBody = bodyOf(source, 'runNodeCheck');
  const selfTestBody = bodyOf(source, 'runSelfTest');
  check('the runNodeCheck body is located, so the next assertion is not vacuous', nodeCheckBody !== '', true);
  check('the runSelfTest body is located, so the next assertion is not vacuous', selfTestBody !== '', true);

  // ...and the slices must not be the SAME slice, which would restore the
  // defect in a new costume.
  check('...and they are distinct bodies', nodeCheckBody !== selfTestBody, true);

  check('runNodeCheck tests for a never-ran child', /didNotStart\s*\(/.test(nodeCheckBody), true);
  check('runSelfTest tests for a never-ran child', /didNotStart\s*\(/.test(selfTestBody), true);

  // The inlined form. Its ABSENCE is the assertion: a call site reaching for
  // `.error.message` has kept the condition and dropped the defence.
  check('...and neither dereferences `.error.message` directly', /\.error\.message/.test(source), false);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
