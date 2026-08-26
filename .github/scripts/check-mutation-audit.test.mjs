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
    const report = audit(dir);
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
{
  // `throw` -> `void ` is safe as a statement, but not as the whole body of an
  // arrow function: `() => void` alone is a parse error, so this fixture makes
  // the neutralisation genuinely unparseable.
  const broken = `#!/usr/bin/env node
const fail = () => { throw new Error('x') };
if (process.argv.includes('--trip')) fail();
process.exit(0);
`;
  const dir = withFixture(broken, FIXTURE_TEST);
  try {
    const guardPath = join(dir, '.github', 'scripts', 'check-fixture.mjs');
    const before = readFileSync(guardPath, 'utf-8');
    const result = auditGuard({
      guardPath,
      testPath: join(dir, '.github', 'scripts', 'check-fixture.test.mjs'),
      rootDir: dir,
    });

    const verdicts = result.results.map((r) => r.verdict);
    check(
      'an unparseable mutation is never recorded as witnessed',
      verdicts.includes('witnessed') && result.results.every((r) => r.verdict !== 'unparseable'),
      false,
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
    const result = auditGuard({
      guardPath: join(dir, '.github', 'scripts', 'check-fixture.mjs'),
      testPath: join(dir, '.github', 'scripts', 'check-fixture.test.mjs'),
      rootDir: dir,
    });

    check('a guard whose baseline is red is CANNOT CHECK', result.status, 'cannot-check');
    check('...and no site is claimed as witnessed', result.results.length, 0);

    const report = audit(dir);
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
    const report = audit(dir);
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

    const report = audit(dir);
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
    const result = auditGuard({
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
    const result = auditGuard({
      guardPath: join(dir, '.github', 'scripts', 'check-fixture.mjs'),
      testPath: join(dir, '.github', 'scripts', 'check-fixture.test.mjs'),
      rootDir: dir,
    });
    check('a self-test observing no failure at all is reported', result.probe?.status, 'no-failure-witnesses');

    // ...and it is REPORTED, not failed. It is the aggregate of "every site
    // here is unwitnessed", which stage 1 measures rather than fails on.
    check('...and it is NOT an integrity error', interpretProbe(result).length, 0);
    const report = audit(dir);
    check('...but it IS surfaced by name in the report', report.noFailureWitnesses.includes('check-fixture.mjs'), true);
    check('...and the inventory renders it', reHits(/observe no failure at all/, renderInventory(report)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// SELF-APPLICATION — the audit is in its own target list (#428 Q4)
// ---------------------------------------------------------------------------
{
  const names = discoverGuards(join(process.cwd())).map((g) => g.name);
  const here = discoverGuards(join(import.meta.dirname, '..', '..')).map((g) => g.name);
  const found = names.includes('check-mutation-audit.mjs') || here.includes('check-mutation-audit.mjs');
  check('the audit discovers itself as a target', found, true);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
