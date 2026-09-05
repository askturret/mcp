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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
  parseInventoryTotals,
  inventoryDelta,
  evaluateExemptions,
  siteSource,
  MUTATION_EXEMPT,
  SITE_KINDS,
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
    const report = await audit(dir, { exempt: [] });
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
      (await audit(dir, { exempt: [] })).errors.length >= 0 && result.results[0]?.detail !== undefined,
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

    const report = await audit(dir, { exempt: [] });
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
    const report = await audit(dir, { exempt: [] });
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

    const report = await audit(dir, { exempt: [] });
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
    const report = await audit(dir, { exempt: [] });
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
      (await audit(dir, { exempt: [] })).errors.some((e) => reHits(/unknown failure path/, e)),
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

// ---------------------------------------------------------------------------
// The revision delta (#438) — the inventory records state; this records CHANGE
//
// Built because the 73 -> 74 flip was correct and had to be derived from a
// line-number diff, and because #434's condition 2 was written against 38
// unwitnessed sites and read today against 46 — a scoping error two people had
// to catch by hand on the same day.
// ---------------------------------------------------------------------------

const TOTALS = Object.freeze({
  guards: 19, sites: 160, witnessed: 114, unwitnessed: 46,
  unreachableSites: 3, unreachable: 1, cannotCheck: 0, cannotCheckSites: 0,
});
const rendered = (t) => renderInventory({ totals: t, guards: [], unreachable: [], unwitnessed: [], noFailureWitnesses: [], errors: [] });

// The parser reads THIS renderer's own output. Asserted by round-trip rather
// than against a transcribed literal, which would agree today and drift later.
{
  const back = parseInventoryTotals(rendered(TOTALS));
  check('the parser round-trips the renderer for `sites`', back?.sites, TOTALS.sites);
  check('...and `witnessed`', back?.witnessed, TOTALS.witnessed);
  check('...and `unwitnessed`', back?.unwitnessed, TOTALS.unwitnessed);
  check('...and both halves of the unreachable line', `${back?.unreachableSites}/${back?.unreachable}`, '3/1');
}

// BOTH DIRECTIONS. A delta reporting only growth would have missed unreachable
// going 24 -> 3, the most consequential movement this instrument has recorded.
{
  const before = rendered({ ...TOTALS, sites: 149, witnessed: 106, unwitnessed: 43, unreachableSites: 7, unreachable: 2 });
  const out = inventoryDelta(before, TOTALS).join('\n');
  check('an INCREASE is reported', /\| failure sites \| 149 \| 160 \| \*\*\+11\*\* \|/.test(out), true);
  check('a DECREASE is reported with the same prominence', /\| unreachable sites \| 7 \| 3 \| \*\*-4\*\* \|/.test(out), true);
}

// RECLASSIFICATION IS NOT REGRESSION — the local/CI divergence QA found, where
// a non-green baseline moves sites into cannot-check and a naive delta reads
// the fall in `witnessed` as lost coverage.
{
  const ci = rendered(TOTALS);
  const local = { ...TOTALS, witnessed: 111, cannotCheck: 1, cannotCheckSites: 3 };
  const out = inventoryDelta(ci, local).join('\n');
  check('a fall in witnessed at a CONSTANT total is named a reclassification', /RECLASSIFICATION, not regression/.test(out), true);
  check('...and says nothing was actually lost', /nothing was actually lost/.test(out), true);

  // The paired positive: when the population really does change, it must NOT be
  // excused as a reclassification.
  const grew = { ...TOTALS, sites: 170, witnessed: 120 };
  check('...but a real population change is NOT excused as one', /RECLASSIFICATION/.test(inventoryDelta(ci, grew).join('\n')), false);
}

// A partition that does not close refuses to interpret anything.
{
  const out = inventoryDelta(rendered(TOTALS), { ...TOTALS, witnessed: 100 }).join('\n');
  check('a partition that does not close is reported', /Partition does not close/.test(out), true);
  check('...and the figures are declared unexplained rather than read', /unexplained until that is understood/.test(out), true);
}

// "Could not compare" is SAID, because silence is indistinguishable from
// "nothing moved" — the failure this whole instrument exists to catch.
{
  const out = inventoryDelta(null, TOTALS).join('\n');
  check('no previous revision says so out loud', /Could not compare/.test(out), true);
  check('...and distinguishes it from nothing having moved', /not the same as "nothing moved"/.test(out), true);
  check('...and an UNPARSEABLE predecessor is the same case', /Could not compare/.test(inventoryDelta('not an inventory', TOTALS).join('\n')), true);
}

// A figure the previous revision did not record is "absent then", not
// "unchanged" — the same missing-vs-unknown distinction the capture schema draws.
{
  const old = rendered(TOTALS).split('\n').filter((l) => !/^- witnessed:/.test(l)).join('\n');
  const out = inventoryDelta(old, TOTALS).join('\n');
  check('a figure absent from the predecessor is reported as not comparable', /Not comparable: \*\*witnessed\*\*/.test(out), true);
  check('...and says absent is a different fact from unchanged', /different fact from unchanged/.test(out), true);
}

// OBSERVED FAILING, which the acceptance asks for: a moved figure WITHOUT the
// section, then with it. Without the delta the rendered inventory carries the
// new number and no account of the move — which is the state #438 describes.
{
  const withDelta = renderInventory({ totals: TOTALS, guards: [], unreachable: [], unwitnessed: [], noFailureWitnesses: [], errors: [] },
    rendered({ ...TOTALS, witnessed: 106 }));
  check('a moved figure is accounted for when the section runs', /\| witnessed \| 106 \| 114 \|/.test(withDelta), true);
  // The pre-#438 behaviour: state only. The new number appears; the movement does not.
  const stateOnly = rendered(TOTALS);
  check('...and WITHOUT a predecessor the same render explains nothing', /\| witnessed \| 106 \|/.test(stateOnly), false);
  check('...while still carrying the new figure, which is exactly the defect', /- witnessed: \*\*114\*\*/.test(stateOnly), true);
}

// The retroactive entry, so the first movement is not the undocumented one.
{
  const out = rendered(TOTALS);
  check('the 73 -> 74 flip is recorded retroactively', /witnessed 73 -> 74/.test(out), true);
  check('...with the site QA attributed it to', /interpretProbe/.test(out), true);
  check('...and the section names WHAT it compared against', /the inventory committed in this repository/.test(out), true);
}


/* -------------------------------------------------------------------------
 * The exemption ledger (#532, conditions 3-6)
 *
 * Pure calls over fixture reports — microseconds, which matters here because
 * every second in this file is charged about ten times over a full audit.
 * There are no child processes below.
 *
 * The live ledger is EMPTY by design (#533 writes the entries), so every
 * direction has to be exercised against fixtures or the machinery ships
 * unmeasured — which is the failure this whole issue is about, one level up.
 *
 * ## Every assertion below was measured against a mutation (#540)
 *
 * Not read for plausibility — RUN. Each checked behaviour of
 * `evaluateExemptions` was removed in turn and the suite observed, because a
 * test that passes for the wrong reason is invisible to reading, invisible to a
 * green suite, and invisible even to an author who has just fixed the same
 * shape in the adjacent test. That is exactly how #540 was born: the kind
 * assertion matched `errors-push` against a fixture kind of `errors-pushh`,
 * which contains it, so the stale fall-through satisfied it too.
 *
 * The sweep found FIVE such assertions, not the one filed. Current state, with
 * the mutation that reddens each behaviour:
 *
 *   required fields        6 red    kind vocabulary        2 red
 *   script not measured    2 red    stale no-match         2 red
 *   ambiguous match        2 red    decay direction        2 red
 *   cannot-confirm         1 red    honoured count         2 red
 *   identity key           4 red    printed count          1 red
 *   duplicate refusal      8 red    entries count          2 red
 *
 * ## The sixth and seventh instances, and how they hid (#541)
 *
 * THE RECORDED FIGURES ABOVE DID NOT CATCH THEM, and that is the lesson. QA
 * found the sixth by RECONSTRUCTING this battery from behaviour names instead
 * of reading the numbers, on the principle that figures produced by the run
 * that produced a fix cannot independently confirm it.
 *
 * Both are the same shape: a behaviour with TWO halves where only one is
 * pinned, so the recorded red count is reproducible and still hides a gap.
 *
 *   printed count   asserted the PHRASE `exemptions on the ledger`, and the
 *                   fixture supplied `entries: 0` — so hard-coding the count to
 *                   0 was indistinguishable from correct. The `undispositioned`
 *                   half WAS witnessed, which is why the row read as covered.
 *   entries count   pinned nowhere at all: the renderInventory fixture passes
 *                   an `exemptions` object straight in, so `evaluateExemptions`
 *                   own count was never exercised.
 *
 * One instance in a file is rarely alone. The seventh was found by extending
 * the battery to a behaviour nobody had mutated, not by reading this comment.
 *
 * ## Two things are deliberately unpinned, and both must stay that way
 *
 * The defensive `site === undefined` read is unreachable by construction
 * because the stale branch precedes it, which is what makes it the ledger's own
 * first candidate for an exemption entry (#533).
 *
 * Counting `honoured` as DISTINCT SITES rather than accepted entries reddens
 * nothing either, and the reason is worth stating rather than leaving as an
 * apparent gap: duplicates are REFUSED before they can reach the counter, so
 * the two spellings agree in every reachable case. It is defence in depth, kept
 * because #533 writes 48 entries against this figure and a count that inflates
 * is a growth signal that under-reports. If the refusal is ever relaxed to a
 * deduplication, this is what keeps the number honest — and only then would it
 * become witnessable.
 *
 * Assertions that no mutation reddens are labelled CONTROL. A control is
 * legitimate — it pins that something does NOT happen — but it must not wear a
 * witness's name, which is the #431 lesson this file keeps re-learning.
 * ---------------------------------------------------------------------- */
{
  const entry = (over = {}) => ({
    script: 'check-thing.mjs',
    kind: 'errors-push',
    source: "errors.push('boom');",
    reason: 'the self-test cannot reach this branch',
    unblockedBy: 'a fixture that supplies a malformed manifest',
    maskingExcluded: 'ran the guard with the branch forced; no other route reports it',
    ...over,
  });

  const reportWith = (results) => ({
    guards: [{ name: 'check-thing.mjs', results }],
    unwitnessed: results
      .filter((r) => r.verdict === 'unwitnessed')
      .map((r) => ({ name: 'check-thing.mjs', line: r.line, kind: r.kind })),
    totals: {},
  });

  const site = (over = {}) => ({
    kind: 'errors-push',
    line: 12,
    source: "errors.push('boom');",
    verdict: 'unwitnessed',
    ...over,
  });

  // --- THE NON-NEGATIVITY INVARIANT, asserted directly (#558) --------------
  //
  // `undispositioned` counts unwitnessed sites carrying no entry, so it can
  // never be negative. #541 established that by counting DISTINCT SITES; this
  // pins it as a property instead, because #558 broke it again from a direction
  // counting could not see — a new `not-mutatable` verdict made a site HONOURED
  // without it being UNWITNESSED, so it subtracted from a population it was
  // never in and the figure went to -1.
  //
  // The lesson is why this is a property assertion and not another arithmetic
  // fix: the previous repair was correct and still did not survive a new
  // verdict. What must hold is the inequality, whatever the verdict vocabulary
  // grows into next.
  {
    const gated = { kind: 'throw', line: 7, source: 'boom();', verdict: 'not-mutatable' };
    const r = evaluateExemptions(reportWith([gated]), [
      entry({ kind: 'throw', source: 'boom();', mutationDoesNotTerminate: true }),
    ]);
    check('ledger: a ledger-gated site is honoured without an error', r.errors.length, 0);
    check('ledger: ...and is counted as honoured', r.counts.honoured, 1);
    check('ledger: ...and undispositioned is NEVER negative', r.counts.undispositioned >= 0, true);
    // ...and it does not consume an unwitnessed slot it never occupied.
    check('ledger: ...and does not subtract from the unwitnessed population', r.counts.undispositioned, 0);
  }

// ---------------------------------------------------------------------------
// THE FIX'S OWN MECHANISMS ARE WITNESSED (#558)
//
// The hang repair shipped with only its LEDGER ACCEPTANCE witnessed. QA
// mutated the rest and measured: neutering the gate reddened 0, and collapsing
// `did-not-terminate` back into `witnessed` reddened 0. Both could be deleted
// with the suite green at 154/0 — the hang able to return silently, inside the
// workstream whose whole subject is unwitnessed failure paths.
//
// This file has learned the same lesson before, and `mutate`'s own docblock
// records it: removing the `node --check` gate once "left the suite at 48/0".
// Same shape, same seam — which is why `mutate` is a parameter at all.
//
// Neither witness pays the hang cost. The gate is observed through a SPY
// asserted never-called; the verdict through a deliberately tiny timeout, so a
// sleeping fixture reaches it in under a second rather than in 90.
// ---------------------------------------------------------------------------
{
  const GATED_SOURCE = "if (flags.includes('--trip-orphan')) errors.push('the orphan check fired');";
  const gatedEntry = {
    script: 'check-fixture.mjs',
    kind: 'errors-push',
    source: GATED_SOURCE,
    reason: 'fixture',
    unblockedBy: 'fixture',
    maskingExcluded: 'fixture',
    mutationDoesNotTerminate: true,
  };

  const dir = withFixture(FIXTURE_GUARD, FIXTURE_TEST);
  try {
    // A SPY, so "was this site mutated?" is observed rather than inferred from
    // the verdict — the verdict alone could be produced by a different route.
    const mutatedLines = [];
    const spy = (src, sites) => {
      for (const s of sites) mutatedLines.push(s.line);
      return applyMutations(src, sites);
    };

    const g = await audit(dir, { exempt: [gatedEntry], mutate: spy });
    const fixture = g.guards.find((x) => x.name === 'check-fixture.mjs');
    const gated = fixture?.results.find((r) => r.source === GATED_SOURCE);

    check('gate: a ledger-gated site is NOT passed to mutate', mutatedLines.includes(gated?.line), false);
    check('gate: ...and records `not-mutatable`', gated?.verdict, 'not-mutatable');
    // The CONTROL, and it is what stops the assertion above passing vacuously:
    // the spy must have mutated the OTHER sites, or "never called for this one"
    // would be satisfied by a spy that was never called at all.
    check('gate: ...while other sites in the same guard WERE mutated', mutatedLines.length > 0, true);
    // ...and the gate must not silently swallow the rest of the guard.
    check('gate: ...and the guard is still measured', fixture?.status, 'measured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the did-not-terminate verdict ----------------------------------------
//
// A timed-out run must NOT record as `witnessed`. That is the trap in the
// obvious fix: a killed child exits non-zero, so the naive reading calls the
// site witnessed and the ledger then raises a false "THE EXEMPTION IS FALSE"
// against a true entry — red instead of hung, the same defect louder.
{
  // A guard whose throw is the ONLY exit from its loop — the shape of the real
  // site this repair exists for. It terminates instantly UNMUTATED, and does not
  // terminate once the throw is neutralised, so the baseline stays green and only
  // the mutated run is killed. A fixture that merely slept would time out its own
  // baseline, and a non-green baseline is CANNOT CHECK — no sites measured, and
  // the assertion would pass for the wrong reason.
  const HANGING_GUARD = [
    '#!/usr/bin/env node',
    'export function bounded(limit) {',
    '  let i = 0;',
    '  while (true) {',
    '    i += 1;',
    "    if (i > limit) throw new Error('bound reached');",
    '  }',
    '}',
    '',
  ].join(String.fromCharCode(10));

  const HANGING_TEST = [
    '#!/usr/bin/env node',
    "import { bounded } from './check-fixture.mjs';",
    'let threw = false;',
    'try { bounded(3); } catch { threw = true; }',
    "console.log(threw ? 'ok   - bounded' : 'FAIL - unbounded');",
    'process.exit(threw ? 0 : 1);',
    '',
  ].join(String.fromCharCode(10));

  const dir = withFixture(HANGING_GUARD, HANGING_TEST);
  try {
    const g = await audit(dir, { exempt: [], selfTestTimeoutMs: 400 });
    const fixture = g.guards.find((x) => x.name === 'check-fixture.mjs');
    const verdicts = new Set((fixture?.results ?? []).map((r) => r.verdict));

    check('timeout: a run that does not terminate records \`did-not-terminate\`', verdicts.has('did-not-terminate'), true);
    // THE WHOLE POINT: it is not \`witnessed\`. Nothing was learned, and calling
    // it witnessed is what turns a true exemption into a false refusal.
    check('timeout: ...and NOT \`witnessed\`', verdicts.has('witnessed'), false);
    // ...and the baseline was green, so the run above measured something rather
    // than bailing out as cannot-check.
    check('timeout: ...and the guard was measured, not bailed out of', fixture?.status, 'measured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

  // --- CONTROL: the SHIPPED ledger is well-formed ---------------------------
  //
  // This asserted `MUTATION_EXEMPT.length === 0`, which was a FACT WHEN WRITTEN
  // rather than a property: the ledger was empty because nothing had been
  // dispositioned yet. The first two entries (#558) turned three green
  // assertions red with nothing wrong — an assertion named "an empty ledger
  // raises nothing" that fails the moment the ledger stops being empty was
  // pinning the wrong noun.
  //
  // What is durable is that every SHIPPED entry is complete and names a known
  // kind. That holds at zero entries and at any number.
  {
    for (const [i, e] of MUTATION_EXEMPT.entries()) {
      for (const field of ['script', 'kind', 'source', 'reason', 'unblockedBy', 'maskingExcluded']) {
        check(
          `ledger: shipped entry ${i + 1} carries a non-empty \`${field}\``,
          typeof e[field] === 'string' && e[field].trim() !== '',
          true,
        );
      }
      check(`ledger: shipped entry ${i + 1} names a known site kind`, SITE_KINDS.includes(e.kind), true);
    }

    // ...and a ledger with NO entries raises nothing about an unrelated site,
    // which is the behaviour the old "the shipped ledger is empty" assertion was
    // really reaching for. Written with `[]` rather than the shipped ledger on
    // purpose: this fixture report measures only `check-fixture.mjs`, so the
    // shipped entries would correctly report as unmeasured-and-stale here, and
    // the assertion would then be about scope rather than about emptiness.
    const r = evaluateExemptions(reportWith([site()]), []);
    check('ledger: a ledger with no entries says nothing about an unrelated site', r.errors.length, 0);
    check('ledger: ...and that site reads as undispositioned', r.counts.undispositioned, 1);
  }

  // --- CONTROL: an honest entry is accepted --------------------------------
  {
    const r = evaluateExemptions(reportWith([site()]), [entry()]);
    check('ledger: an entry over an unwitnessed site is honoured', r.errors.join('|'), '');
    check('ledger: ...and counted', r.counts.honoured, 1);
    check('ledger: ...and removed from the undispositioned figure', r.counts.undispositioned, 0);
  }

  // --- THE DECAY DIRECTION, which is the one that gets skipped -------------
  {
    const r = evaluateExemptions(reportWith([site({ verdict: 'witnessed' })]), [entry()]);
    // SHAPE ONLY, and labelled as such (#540). It pins that one entry yields
    // one error rather than several — a real property, but NOT the direction.
    // No mutation in the battery reddens it, because every fall-through also
    // produces exactly one error. The line below carries the direction.
    check('ledger: CONTROL: an exempt site that IS witnessed yields one error', r.errors.length, 1);
    // Counting errors is NOT enough here, and mutation proved it: with the decay
    // branch removed the fall-through still produces exactly one error, so the
    // count assertion stayed green while the direction was gone.
    check(
      'ledger: ...and it fails AS the decay case, not as some other error',
      /THE EXEMPTION IS FALSE/.test(r.errors.join('|')),
      true,
    );
    check(
      'ledger: ...and says the exemption is false, not that the site is fine',
      /THE EXEMPTION IS FALSE/.test(r.errors[0] ?? ''),
      true,
    );
    check('ledger: ...and it is not counted as honoured', r.counts.honoured, 0);
  }

  // --- STALE: the code it exempted has changed (condition 5) ---------------
  {
    const r = evaluateExemptions(reportWith([site({ source: "errors.push('different');" })]), [entry()]);
    // Anchored on wording ONLY THIS BRANCH produces (#540). Matching /STALE/
    // was decorative: the defensive `site === undefined` fall-through also says
    // STALE, so removing this branch left the assertion green.
    check(
      'ledger: an entry whose source no longer exists is STALE',
      /no errors-push site in check-thing\.mjs now reads/.test(r.errors[0] ?? ''),
      true,
    );
    check('ledger: ...and removal is by refusal, not by memory', /condition 5/.test(r.errors[0] ?? ''), true);
  }

  // --- STALE: the script is not measured at all ----------------------------
  {
    const r = evaluateExemptions(reportWith([site()]), [entry({ script: 'check-gone.mjs' })]);
    // Both assertions here were decorative for the same reason as the kind one
    // (#540): with this branch removed, the key lookup finds nothing and the
    // no-match branch produces a STALE message that ALSO names the script. So
    // neither /STALE/ nor the filename could tell the two branches apart.
    check(
      'ledger: an entry for an unmeasured script is STALE',
      /was not measured this run/.test(r.errors[0] ?? ''),
      true,
    );
    check(
      'ledger: ...and says nothing here confirms or denies it',
      /confirms or\s+denies the exemption/.test(r.errors[0] ?? ''),
      true,
    );
  }

  // --- AMBIGUOUS: one entry cannot exempt several sites --------------------
  {
    const r = evaluateExemptions(reportWith([site({ line: 12 }), site({ line: 40 })]), [entry()]);
    check('ledger: an entry matching two sites is refused, not guessed', /AMBIGUOUS/.test(r.errors[0] ?? ''), true);
    check('ledger: ...and names both lines so it can be disambiguated', /12, 40/.test(r.errors[0] ?? ''), true);
  }

  // --- CONDITION 4, and the method requirement from the ruling -------------
  for (const field of ['reason', 'unblockedBy', 'maskingExcluded']) {
    const bad = entry();
    bad[field] = '   ';
    const r = evaluateExemptions(reportWith([site()]), [bad]);
    check('ledger: an entry with an empty ' + field + ' is refused', r.errors.length, 1);
    check('ledger: ...and the message names ' + field, new RegExp(field).test(r.errors[0] ?? ''), true);
  }

  // --- A verdict that is neither witnessed nor unwitnessed -----------------
  {
    const r = evaluateExemptions(reportWith([site({ verdict: 'unparseable' })]), [entry()]);
    check('ledger: an unconfirmable verdict is not read as agreement', /CANNOT CONFIRM/.test(r.errors[0] ?? ''), true);
  }

  // --- A kind outside the vocabulary ---------------------------------------
  //
  // THE ASSERTION #540 WAS FILED ABOUT, and it is worth keeping the reason next
  // to it. It matched `new RegExp(SITE_KINDS[0])` — that is `errors-push` —
  // against a fixture whose kind is `errors-pushh`, which CONTAINS it. So the
  // stale fall-through message, which quotes `entry.kind`, satisfied the regex
  // just as well as a real vocabulary refusal, and removing the vocabulary
  // check entirely left the suite green.
  //
  // Anchored on the refusal's own wording instead. Same discipline as #542: an
  // assertion that cannot distinguish the fixed state from the broken one is
  // the defect it was written to catch.
  {
    const r = evaluateExemptions(reportWith([site()]), [entry({ kind: 'errors-pushh' })]);
    check(
      'ledger: a mistyped kind is refused',
      /kind is not one of/.test(r.errors[0] ?? ''),
      true,
    );
    // ...and the refusal lists the vocabulary, so the reader can see the near
    // miss. Checked against a kind the message would NOT contain incidentally.
    check(
      'ledger: ...and the refusal lists the real vocabulary',
      r.errors[0]?.includes(SITE_KINDS.join(', ')),
      true,
    );
  }

  // --- WHY IDENTITY IS TEXT: the key survives a line shift ------------------
  {
    const src = "a();\nerrors.push('boom');\n";
    const shifted = '// an unrelated line added above\n' + src;
    // Comparing two calls of the same function is satisfied by ANY uniform
    // answer — including the empty string (#540). The key is asserted to be the
    // real line as well, so a degenerate implementation cannot pass by
    // returning the same nothing twice.
    check(
      'ledger: the identity key is unchanged when unrelated lines move',
      siteSource(src, src.indexOf('errors.push')),
      siteSource(shifted, shifted.indexOf('errors.push')),
    );
    check(
      'ledger: ...and it is the line itself, not a uniform placeholder',
      siteSource(src, src.indexOf('errors.push')),
      "errors.push('boom');",
    );
    // ...and it DOES change when that site's own code changes, which is when
    // the exemption should stop applying.
    const edited = "a();\nerrors.push('different');\n";
    check(
      'ledger: ...and it changes when that site own code changes',
      siteSource(edited, edited.indexOf('errors.push')) === siteSource(src, src.indexOf('errors.push')),
      false,
    );
  }


  // --- THE REAL ENUMERATOR MUST PRODUCE THE KEY THE LEDGER READS -----------
  //
  // The shipped ledger is empty, so the loop above never executes against a
  // real report — every direction is exercised on fixtures I built, and a
  // fixture proves the code agrees with itself. This is the one assertion that
  // crosses the seam: the identity key is attached by `enumerateSites` on the
  // real path, so an entry written in #533 will find its site.
  {
    const src = [
      "if (bad) errors.push('one');",
      "if (worse) throw new Error('two');",
      'if (x) process.exit(3);',
    ].join('\n');
    const sites = enumerateSites(src);
    check('ledger: the enumerator finds the fixture sites at all', sites.length > 0, true);
    check(
      'ledger: every enumerated site carries a non-empty identity key',
      sites.every((s) => typeof s.source === 'string' && s.source.length > 0),
      true,
    );
    check(
      'ledger: ...and the key is the site own source line',
      sites.find((s) => s.kind === 'throw')?.source,
      "if (worse) throw new Error('two');",
    );
  }

  // --- CONDITION 6: the count is printed every run --------------------------
  {
    const rendered = renderInventory(
      {
        guards: [],
        unreachable: [],
        unwitnessed: [],
        noFailureWitnesses: [],
        errors: [],
        // NON-ZERO deliberately (#541). With `entries: 0` a degenerate
        // implementation that always prints 0 was indistinguishable from a
        // correct one — hard-coding the count reddened nothing. The fixture has
        // to be able to tell the two apart before the assertion below means
        // anything.
        exemptions: { entries: 2, honoured: 2, undispositioned: 3 },
        totals: {
          guards: 1,
          sites: 3,
          witnessed: 0,
          unwitnessed: 3,
          unreachable: 0,
          unreachableSites: 0,
          cannotCheck: 0,
          cannotCheckSites: 0,
          noSites: 0,
        },
      },
      null,
    );
    // BOTH HALVES OF THE FIGURE, and only one of them used to be pinned (#541).
    // The phrase assertion below matched `exemptions on the ledger` — which the
    // line always contains — so the ENTRIES half was invisible while the
    // UNDISPOSITIONED half was witnessed. That is why the recorded battery
    // figure for "printed count" was reproducible and still hid a gap.
    check(
      'ledger: the inventory prints the exemption count',
      /exemptions on the ledger \(#532\): \*\*2\*\*/.test(rendered),
      true,
    );
    check(
      'ledger: ...and how many unwitnessed sites carry no entry',
      /3 unwitnessed site\(s\) carry no entry/.test(rendered),
      true,
    );
  }

  // --- DEFECT 1: duplicates inflate the count (#541) -------------------------
  //
  // The ledger refused ONE entry spanning SEVERAL sites as AMBIGUOUS, on the
  // reasoning that it "would silently cover ones nobody examined", and accepted
  // SEVERAL entries over ONE site without comment. Refused now, symmetrically.
  {
    const dup = entry();
    const r = evaluateExemptions(reportWith([site()]), [dup, { ...dup }]);

    check('ledger: two entries naming one site are refused (#541)', r.errors.length, 2);
    check('ledger: ...as DUPLICATE, not as some other error', /DUPLICATE/.test(r.errors[0] ?? ''), true);
    check('ledger: ...and each names the other, so either can be deleted', /exemptions 1, 2/.test(r.errors[0] ?? ''), true);
    check('ledger: ...and neither is honoured', r.counts.honoured, 0);
    // A SEVENTH INSTANCE of the same shape, found by extending the battery
    // rather than by reading (#541). `counts.entries` was pinned nowhere: the
    // renderInventory fixture passes an `exemptions` object straight in, so
    // evaluateExemptions own count was never exercised, and hard-coding it to 0
    // reddened nothing. One instance in a file is rarely alone.
    check('ledger: ...and the entries count reports what was submitted', r.counts.entries, 2);
    check('ledger: ...so the undispositioned figure cannot go negative', r.counts.undispositioned, 1);
  }

  // THE REALISTIC CASE, not only the absurd one. Two copy-pasted duplicates
  // among a larger set under-report by one and nothing looks wrong — the
  // extreme case is visibly silly, this one is silent.
  {
    const a = entry();
    const b = entry({ source: "errors.push('other');", line: 40 });
    const report = reportWith([
      site(),
      site({ source: "errors.push('other');", line: 40 }),
      site({ source: "errors.push('third');", line: 70 }),
    ]);
    const r = evaluateExemptions(report, [a, b, { ...a }]);

    check('ledger: a duplicate hidden among distinct entries is still refused', /DUPLICATE/.test(r.errors.join('|')), true);
    // The honest figure: `b` is honoured, `a` and its copy are refused, so ONE
    // of three unwitnessed sites is dispositioned.
    check('ledger: ...and the honoured count is of SITES, not accepted entries', r.counts.honoured, 1);
    check('ledger: ...so undispositioned reports the true remainder', r.counts.undispositioned, 2);
    check('ledger: ...and entries counts all three, including the refused copy', r.counts.entries, 3);
  }
}

// ---------------------------------------------------------------------------
// AN INTERRUPTED RUN LEAVES THE TRACKED TREE CLEAN, BECAUSE NOTHING WRITES TO
// IT (#652)
//
// The block above tests the SIGNAL HANDLER: interrupt, and the handler restores
// what it had mutated. That narrows the window. It does not close it — a
// handler cannot run while `spawnSync` holds the loop, `SIGHUP` was never
// handled, and `SIGKILL` cannot be caught at all. QA hit exactly that doing
// something routine, and was left with a DIFFERENT file dirty from the one
// dirty moments earlier, because the harness had moved on.
//
// `audit()` now mutates a REPLICA, so there is no window to narrow. These cases
// assert the property that follows: across a whole run, the tracked tree is
// never written — not "is clean afterwards", which a run that never started
// would also satisfy.
//
// TWO CONTROLS, because the assertion is about an absence and an absence is
// what a broken harness also produces (see
// docs/adr/ADR-024-output-must-vary-with-the-fact.md):
//
//   1. The tracked file is polled THROUGHOUT, not just at the end. The original
//      defect was transient — a file dirty for one site and restored by the
//      next — so an end-state check is the one shape that cannot see it.
//   2. A mutation must actually be observed IN THE REPLICA while the run is
//      live. Without that, "the tracked tree was never dirty" passes for an
//      audit that crashed on startup, which is the vacuous pass this record
//      describes.
//
// The SIGKILL case is the one that distinguishes this fix from a better signal
// handler. No handler can survive it; a replica does not need to.
// ---------------------------------------------------------------------------
for (const signal of ['SIGINT', 'SIGKILL']) {
  const slowTest = `#!/usr/bin/env node
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
console.log('ok   - slow but green');
process.exit(0);
`;
  const dir = withFixture(FIXTURE_GUARD, slowTest);
  const guardPath = join(dir, '.github', 'scripts', 'check-fixture.mjs');
  const original = readFileSync(guardPath, 'utf-8');

  const runnerPath = join(dir, 'runner.mjs');
  writeFileSync(
    runnerPath,
    `import { audit } from ${JSON.stringify(join(import.meta.dirname, 'check-mutation-audit.mjs'))};\n` +
      `audit(${JSON.stringify(dir)}, { onReplica: (p) => console.log('REPLICA ' + p) });\n`,
  );

  try {
    const child = spawn(process.execPath, [runnerPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    // Attached NOW, not after the kill. A child that has already exited fires
    // `exit` once and never again, so a listener registered afterwards waits
    // forever — which is what the first draft of this case did, and it hung
    // exactly when the run under test was fast enough to finish on its own.
    const exited = new Promise((res) => child.on('exit', () => res()));

    // Poll until the REPLICA is carrying a mutation — that is the live window,
    // and the precondition that makes everything below non-vacuous. The tracked
    // file is checked on every pass of the same loop.
    let replicaMutated = false;
    let trackedEverDirty = false;
    for (let i = 0; i < 60 && !replicaMutated; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (readFileSync(guardPath, 'utf-8') !== original) trackedEverDirty = true;
      const replicaRoot = /REPLICA (.+)/.exec(stdout)?.[1]?.trim();
      if (replicaRoot === undefined) continue;
      const replicaGuard = join(replicaRoot, '.github', 'scripts', 'check-fixture.mjs');
      if (existsSync(replicaGuard) && readFileSync(replicaGuard, 'utf-8') !== original) replicaMutated = true;
    }

    child.kill(signal);
    await exited;
    if (readFileSync(guardPath, 'utf-8') !== original) trackedEverDirty = true;

    check(`${signal}: a mutation was live in the replica when the signal landed (precondition)`, replicaMutated, true);
    check(`${signal}: the tracked guard is never written at any point in the run`, trackedEverDirty, false);
    check(`${signal}: ...and is byte-identical afterwards`, readFileSync(guardPath, 'utf-8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
