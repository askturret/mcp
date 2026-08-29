#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the repository's CI guards — the two #79 test-integrity guards and
 * the #26 network-access guard.
 *
 * The guards exist because things silently stopped running. A guard that
 * silently stops working is the same failure, one level up — so each one is
 * exercised here against fixtures reproducing every root cause it claims to
 * catch, plus the near-misses that would make it cry wolf.
 *
 * ## What this file is for, stated because it has now been decided twice (#381)
 *
 * It holds TWO kinds of assertion, and the distinction decides what belongs:
 *
 *   1. Functional tests of the guards named above, which have no sibling
 *      `*.test.mjs` of their own.
 *   2. META-assertions about the guard SET as a collection — properties true of
 *      every guard rather than of one. #361's "no self-test spawns a bare
 *      `node`" is one; #381's wiring check at the end of this file is another.
 *
 * What does NOT belong is functional tests of some OTHER individual guard.
 * Those go in that guard's own `*.test.mjs`, wired as its own step — hiding
 * them here would leave nobody able to find them, which is why #324's
 * assertions were refused a home in this file even though that was the cheaper
 * lane.
 *
 * The header previously named only role 1, while role 2 had existed since #361.
 * Both are written down so the next person reads the charter rather than
 * inferring it from whatever happens to be here.
 *
 * Run: node .github/scripts/check-guards.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = join(here, 'check-placeholder-tests.mjs');
const EXECUTION = join(here, 'check-test-execution.mjs');
const NETWORK = join(here, 'check-network-imports.mjs');
const NUL = join(here, 'check-nul-bytes.mjs');
const CARDINALITY = join(here, 'check-metric-cardinality.mjs');

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

function runGuard(script, dir, ...extraArgs) {
  const r = spawnSync(process.execPath, [script, dir, ...extraArgs], { encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A throwaway directory holding one test file. */
function withTestFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  writeFileSync(join(dir, 'sample.test.ts'), contents);
  return dir;
}

const tmpDirs = [];
const scratch = (contents) => {
  const d = withTestFile(contents);
  tmpDirs.push(d);
  return d;
};

// ---------------------------------------------------------------------------
// check-placeholder-tests.mjs
// ---------------------------------------------------------------------------

check(
  'placeholder: flags expect(true).toBe(true)',
  runGuard(PLACEHOLDER, scratch(`
    it('does nothing', () => {
      expect(true).toBe(true);
    });
  `)).code,
  1,
);

check(
  'placeholder: flags a test body with no assertion at all',
  runGuard(PLACEHOLDER, scratch(`
    it('runs some code', async () => {
      const result = await doTheThing();
      console.log(result);
    });
  `)).code,
  1,
);

check(
  'placeholder: flags it.only, which disables every other test',
  runGuard(PLACEHOLDER, scratch(`
    it.only('focused', () => {
      expect(1 + 1).toBe(2);
    });
  `)).code,
  1,
);

check(
  'placeholder: flags expect(1).toBe(1)',
  runGuard(PLACEHOLDER, scratch(`
    it('tautology with numbers', () => {
      expect(1).toBe(1);
    });
  `)).code,
  1,
);

check(
  'placeholder: accepts a real assertion',
  runGuard(PLACEHOLDER, scratch(`
    it('checks something real', () => {
      expect(add(2, 2)).toBe(4);
    });
  `)).code,
  0,
);

// The guard must not flag its own documentation, or anyone else's.
check(
  'placeholder: does NOT flag a tautology quoted inside a comment',
  runGuard(PLACEHOLDER, scratch(`
    it('checks something real', () => {
      // This used to be expect(true).toBe(true), which asserted nothing.
      expect(add(2, 2)).toBe(4);
    });
  `)).code,
  0,
);

check(
  'placeholder: does NOT flag a tautology inside a string literal',
  runGuard(PLACEHOLDER, scratch(`
    it('reports bad patterns', () => {
      expect(lint(source)).toContain('expect(true).toBe(true)');
    });
  `)).code,
  0,
);

check(
  'placeholder: does NOT flag a block comment mentioning it.only',
  runGuard(PLACEHOLDER, scratch(`
    /* Never commit it.only( — it disables the rest of the file. */
    it('is fine', () => {
      expect(compute()).toEqual([1, 2]);
    });
  `)).code,
  0,
);

check(
  'placeholder: .skip warns but does not fail',
  runGuard(PLACEHOLDER, scratch(`
    it.skip('temporarily disabled', () => {
      expect(add(1, 1)).toBe(2);
    });
  `)).code,
  0,
);

{
  const dir = scratch(`
    it('weakly asserts', () => {
      expect(thing()).toBeDefined();
    });
  `);
  const r = runGuard(PLACEHOLDER, dir);
  check('placeholder: weak-assertion-only warns but does not fail', r.code, 0);
  check(
    'placeholder: ...and says so in the output',
    r.out.includes('only weak assertions') ? 'reported' : r.out,
    'reported',
  );
}

// ---------------------------------------------------------------------------
// #328: a declaration is not a method call.
//
// `\b(it|test)(` matched the boundary between `.` and `t`, so `regex.test(...)`
// parsed as a test declaration with an assertion-free body. Both directions are
// asserted here: the false positive must be gone, and the guard must NOT have
// gone blind to a genuinely empty body in the process.
// ---------------------------------------------------------------------------

// NOTE ON THIS FIXTURE: the trailing helper is load-bearing, not filler.
// `extractBody` takes the NEXT `{` after a match, so without a following block
// the buggy guard found no body and bailed out — the test then passed under
// the OLD code and proved nothing. That is how it reproduced on #326: the
// `.test(` calls were followed by another braced block, which the guard
// adopted as their "body" and correctly found to contain no assertion.
check(
  'placeholder: does NOT flag regex.test() inside a real test (#328)',
  runGuard(PLACEHOLDER, scratch(`
    it('matches the pattern', () => {
      const re = /^abc/;
      expect(re.test('abcdef')).toBe(true);
    });

    function helper() {
      return 1;
    }
  `)).code,
  0,
);

check(
  'placeholder: STILL flags an assertion-free body that calls regex.test (#328)',
  runGuard(PLACEHOLDER, scratch(`
    it('checks nothing', () => {
      const re = /^abc/;
      re.test('abcdef');
    });
  `)).code,
  1,
);

check(
  'placeholder: does NOT flag a .test.only() method chain (#328)',
  runGuard(PLACEHOLDER, scratch(`
    it('drives a helper', () => {
      const matcher = buildMatcher();
      matcher.test.only('a');
      expect(matcher.calls).toBe(1);
    });
  `)).code,
  0,
);

// The counterpart to the three above: excluding dot-prefixed forms must not
// weaken .only detection, whose dot comes AFTER the keyword. A careless
// "reject anything involving a dot" fix passes the tests above and breaks
// these two — which is the whole reason they are here.
check(
  'placeholder: STILL flags test.only (#328 regression guard)',
  runGuard(PLACEHOLDER, scratch(`
    test.only('focused', () => {
      expect(add(1, 1)).toBe(2);
    });
  `)).code,
  1,
);

check(
  'placeholder: STILL flags describe.only (#328 regression guard)',
  runGuard(PLACEHOLDER, scratch(`
    describe.only('focused suite', () => {
      it('inner', () => {
        expect(add(1, 1)).toBe(2);
      });
    });
  `)).code,
  1,
);

check(
  'placeholder: does NOT flag an identifier ending in a declaration keyword (#328)',
  runGuard(PLACEHOLDER, scratch(`
    it('tolerates dollar-suffixed helpers', () => {
      my$test('x', () => {
        return 1;
      });
      expect(sent()).toBe(true);
    });
  `)).code,
  0,
);

// ---------------------------------------------------------------------------
// check-test-execution.mjs
// ---------------------------------------------------------------------------

/** Build a throwaway npm workspace with one package. */
function scratchWorkspace(pkgOverrides) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-ws-'));
  tmpDirs.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }, null, 2),
  );
  const pkgDir = join(dir, 'packages', 'thing');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'thing', version: '1.0.0', private: true, ...pkgOverrides }, null, 2),
  );
  return dir;
}

/**
 * A workspace whose fake runner reports exactly the suites named in `reported`,
 * while `onDisk` test files exist. That gap is the whole subject of #339.
 *
 * The runner is a `node -e` stand-in rather than real jest because the property
 * under test is what the guard does with a runner's OUTPUT — using real jest
 * would test jest's reporter instead, and could not express the fail-closed
 * case at all (a run with no PASS lines).
 */
function scratchPerFile({ onDisk, reported, tests = 1, pkgOverrides = {} }) {
  const lines = reported.map((f) => `console.error('PASS ${f}')`).join(';');
  const dir = scratchWorkspace({
    scripts: { test: `node -e "${lines}${lines ? ';' : ''}console.error('Tests: ${tests} passed, ${tests} total')"` },
    ...pkgOverrides,
  });
  for (const rel of onDisk) {
    const full = join(dir, 'packages', 'thing', rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '// fixture\n');
  }
  return dir;
}

check(
  'execution: fails a "test": "exit 0" no-op script',
  runGuard(EXECUTION, scratchWorkspace({ scripts: { test: 'exit 0' } })).code,
  1,
);

check(
  'execution: fails a package with no test script at all',
  runGuard(EXECUTION, scratchWorkspace({ scripts: {} })).code,
  1,
);

check(
  'execution: fails when the runner reports zero tests',
  runGuard(
    EXECUTION,
    scratchWorkspace({
      scripts: { test: 'node -e "console.error(\'Tests: 0 total\')"' },
    }),
  ).code,
  1,
);

check(
  'execution: fails when the test command errors',
  runGuard(
    EXECUTION,
    scratchWorkspace({ scripts: { test: 'node -e "process.exit(1)"' } }),
  ).code,
  1,
);

check(
  'execution: fails closed when no test count can be parsed',
  runGuard(
    EXECUTION,
    scratchWorkspace({ scripts: { test: 'node -e "console.log(\'all good!\')"' } }),
  ).code,
  1,
);

check(
  'execution: passes when tests actually run',
  runGuard(
    EXECUTION,
    scratchWorkspace({
      scripts: { test: 'node -e "console.error(\'Tests: 3 passed, 3 total\')"' },
    }),
  ).code,
  0,
);

// ---------------------------------------------------------------------------
// The execution guard survives a hostile PATH (#429)
//
// This environment has shipped a SPACE-separated PATH. Lookup splits on `:`, so
// the whole string is one nonexistent directory, `spawnSync('npm', …)` returns
// `status: null` with `error: ENOENT`, and `run.status !== 0` read that as the
// package's tests failing.
//
// WHAT THAT COST, and the second half is the worse half:
//
//   6 assertions failed        every case expecting exit 0
//   ~10 assertions PASSED      every case expecting exit 1 — vacuously, because
//                              the guard was failing everything for the wrong
//                              reason
//
// So the broken environment produced six false alarms AND ten false
// reassurances, and the six are what three agents spent time on. It is #361's
// argument reaching a place #361 did not: whoever sees it is already debugging
// a guard, and the red confirms the theory they walked in with.
//
// The fix is a PATH the child can resolve through, NOT `process.execPath` —
// `npm` is a genuine external tool with no in-process equivalent, which #361's
// own scope note is explicit about. This assertion is what stops it regrowing,
// because under a normal PATH the fix is invisible: every case above passes
// with or without it.
// ---------------------------------------------------------------------------
{
  const dir = scratchWorkspace({
    scripts: { test: 'node -e "console.error(\'Tests: 3 passed, 3 total\')"' },
  });
  // ONLY THE DELIMITER IS WRONG — that is what makes this the observed
  // condition rather than a general "bad PATH" test, and it is NOT the same as
  // unsetting PATH, which falls back to a system default and can succeed by
  // accident.
  //
  // The directories are the ones seen in the wild. `/opt/homebrew/bin` does not
  // exist on the Linux runner and does not need to — nothing here depends on
  // any of them resolving. An earlier version of this comment claimed they were
  // all real, which was true where it was written and false in CI. A loose
  // claim inside a fixture about hostile environments is the wrong place to be
  // approximate.
  const hostile = spawnSync(process.execPath, [EXECUTION, dir], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: '/opt/homebrew/bin /usr/bin /bin' },
  });
  const hostileOut = `${hostile.stdout ?? ''}${hostile.stderr ?? ''}`;

  check('execution: passes with a SPACE-separated PATH (#429)', hostile.status, 0);
  // POSITIVELY assert the package was measured, rather than merely that the
  // failure message is absent. The negative form passed with the fix removed —
  // the guard then exits 2 and prints CANNOT CHECK, so "do not execute any
  // tests" is absent for the wrong reason, and the pair had only one reddening
  // half. This half now reddens too.
  check(
    'execution: ...and the package is actually MEASURED, not reported unmeasurable',
    /1 running tests/.exec(hostileOut) !== null,
    true,
  );
}

// ---------------------------------------------------------------------------
// The CANNOT-CHECK backstop, pinned — and it is what catches its own defect
// (#429 QA, generalised as #443)
//
// The backstop shipped with NO assertion, so nothing executed its detail
// string, and the detail string was wrong:
//
//   if (run.status === null || run.error !== undefined) { … run.error.code … }
//
// `status === null` does NOT imply `error` is set. Measured, all three shapes:
//
//   command not found   status null   error ENOENT       signal null
//   KILLED BY SIGNAL    status null   error UNDEFINED    signal SIGKILL  <- throws
//   timeout kill        status null   error ETIMEDOUT    signal SIGTERM
//
// An uncaught throw there exits 1 — this guard's "packages do not execute any
// tests" code — so an npm child killed by the OOM killer produced a FALSE
// TEST-COVERAGE ALARM. #429's own symptom inside the fix for #429.
//
// `kill -9 $PPID` in the package's test script kills npm itself, which is the
// middle row exactly, reached through the real npm path. It needs only `sh` and
// `kill`, both of which the guard's own CHILD_PATH guarantees.
// ---------------------------------------------------------------------------
{
  const dir = scratchWorkspace({ scripts: { test: 'kill -9 $PPID' } });
  const killed = spawnSync(process.execPath, [EXECUTION, dir], { encoding: 'utf-8' });
  const out = `${killed.stdout ?? ''}${killed.stderr ?? ''}`;

  check('execution: a signal-killed npm is CANNOT CHECK, not a failing package (#429)', killed.status, 2);
  check(
    'execution: ...and says COULD NOT BE CHECKED rather than blaming test coverage',
    /COULD NOT BE CHECKED/.exec(out) !== null,
    true,
  );
  check(
    'execution: ...and does NOT report it as a package that runs no tests',
    /do not execute any tests/.exec(out) !== null,
    false,
  );
  // The assertion that would have caught the shipped defect: it forces the
  // detail string to be BUILT for the shape where `error` is undefined.
  check(
    'execution: ...and names the signal, which is the string that used to throw',
    /killed by SIG/.exec(out) !== null,
    true,
  );
}

check(
  'execution: honours an explicit testsNotRequired declaration',
  runGuard(
    EXECUTION,
    scratchWorkspace({ askturret: { testsNotRequired: 'no source of its own' } }),
  ).code,
  0,
);

check(
  'execution: rejects an empty testsNotRequired reason',
  runGuard(EXECUTION, scratchWorkspace({ askturret: { testsNotRequired: '' } })).code,
  1,
);

// ---------------------------------------------------------------------------
// #339: per-FILE execution.
//
// The package-level checks above ask "did this package run any tests". They are
// right, and they are silent on a file that contributes none — #216 found one
// such file, #313 found two more, and all three were found by a human reading a
// config rather than by CI.
//
// Keyed on the SHARED SYMPTOM ("this file contributed no tests to the run")
// rather than on either known cause, because #313's files had BOTH a config
// exclusion and a dead self-invocation block, and a check keyed on either alone
// would have passed them.
// ---------------------------------------------------------------------------

check(
  'per-file: PASSES when every test file on disk appears in the run',
  runGuard(
    EXECUTION,
    scratchPerFile({ onDisk: ['src/a.test.ts', 'src/b.test.ts'], reported: ['src/a.test.ts', 'src/b.test.ts'] }),
  ).code,
  0,
);

{
  const r = runGuard(
    EXECUTION,
    scratchPerFile({ onDisk: ['src/a.test.ts', 'src/b.test.ts'], reported: ['src/a.test.ts'] }),
  );
  check('per-file: FAILS when a test file on disk never ran (#339)', r.code, 1);
  check('per-file: ...and names the file that did not run', r.out.includes('src/b.test.ts'), true);
  check(
    'per-file: ...and does not accuse the file that DID run',
    /contributed no tests[^\n]*src\/a\.test\.ts/.test(r.out),
    false,
  );
}

check(
  'per-file: FAILS CLOSED when no per-suite lines can be parsed (#339)',
  // A runner that reports a count but no suites is indistinguishable from one
  // that skipped every file. "I could not tell" must not become "it passed".
  runGuard(EXECUTION, scratchPerFile({ onDisk: ['src/a.test.ts'], reported: [] })).code,
  1,
);

{
  // The OTHER way the reporter coupling can break, and the likelier one (#344).
  //
  // A jest upgrade is far more likely to change how a path is RENDERED than to
  // stop emitting the line at all. That mode was already loud, but only
  // INCIDENTALLY — every file reads as never-run, via the generic path — so
  // nothing pinned it. Both modes being loud is what turned "reporter-coupled"
  // from a soundness objection into a maintenance cost, and that argument is
  // why the extend-over-sibling design was endorsed. It deserves an assertion
  // holding it up rather than a paragraph.
  const r = runGuard(
    EXECUTION,
    scratchPerFile({
      onDisk: ['src/a.test.ts'],
      reported: ['/abs/build/packages/thing/src/a.test.ts'],
    }),
  );
  check('per-file: FAILS CLOSED when the reported path FORMAT changes (#344)', r.code, 1);
  check(
    'per-file: ...and names the file rather than failing silently',
    r.out.includes('src/a.test.ts'),
    true,
  );
}

check(
  'per-file: catches a file whose tests are ALL skipped (#344)',
  // #339 documented this class as NOT covered. It is — verified against this
  // repo's real jest: a fully-skipped file emits NO per-suite line, so it lands
  // in the same bucket as an excluded one, while a partly-skipped file still
  // emits its line and correctly passes. Nothing special-cases `.skip`; the
  // keyed symptom ("contributed no tests") covers it.
  //
  // This assertion pins the GUARD'S REACTION to the symptom, which the #339
  // assertion above already pinned — the two are mechanically identical, and no
  // mutation distinguishes them (#346). What produces the symptom is jest, and
  // that is pinned separately below.
  runGuard(
    EXECUTION,
    scratchPerFile({ onDisk: ['src/a.test.ts', 'src/quiet.test.ts'], reported: ['src/a.test.ts'] }),
  ).code,
  1,
);

// ---------------------------------------------------------------------------
// The jest behaviour the corrected docstring RESTS on (#346)
//
// Everything above simulates the symptom with a fixed `reported` list. That
// pins how the guard reacts and says nothing about whether jest still produces
// the symptom — and the docstring's claim is about JEST, not about the guard:
//
//   "every test in a file skipped -> jest emits no per-suite line at all"
//
// If a jest upgrade began emitting `PASS` for fully-skipped suites, the guard
// would pass those files again and the docstring would be silently wrong again
// — the exact defect #344 was filed to fix — and no fixture-based assertion
// here would fire, because they all supply the symptom themselves.
//
// So this runs REAL jest over a two-file fixture. It is the only check in this
// file that does; the cost is one jest invocation over two trivial files.
// ---------------------------------------------------------------------------

{
  const dir = mkdtempSync(join(tmpdir(), 'guard-jest-skip-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });

  // The control file. Load-bearing, not scenery — see below.
  writeFileSync(join(dir, 'src', 'running.test.js'), "test('runs', () => { expect(1).toBe(1); });\n");
  writeFileSync(
    join(dir, 'src', 'skipped.test.js'),
    "test.skip('a', () => { expect(1).toBe(1); });\ntest.skip('b', () => { expect(2).toBe(2); });\n",
  );
  writeFileSync(join(dir, 'jest.config.js'), "module.exports = { testEnvironment: 'node', rootDir: '.' };\n");

  const jestBin = join(here, '..', '..', 'node_modules', 'jest', 'bin', 'jest.js');
  const r = spawnSync(process.execPath, [jestBin, '--config', join(dir, 'jest.config.js'), '--ci'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  // THE GUARD'S OWN REGEX, READ FROM ITS SOURCE — not a second description of
  // it (#393).
  //
  // This block exists to pin jest AS THE GUARD'S PARSER SEES IT. It used to do
  // that through a second, independently-drifting description:
  //
  //   guard parses   /^\s*(?:PASS|FAIL)\s+(\S+)/gm
  //   this test used (?:PASS|FAIL)[^\n]*<name>\.test\.js
  //
  // The feared drift does not currently exist — both use the same PASS|FAIL
  // alphabet, checked rather than assumed — but the risk is ASYMMETRIC. The
  // looser form is safe for the NEGATIVE, which fails loudly if it over-matches,
  // and unsafe for the CONTROL POSITIVE, which the whole block depends on: it
  // could be satisfied by a line the guard's parser would reject, reporting
  // "jest ran" on output the guard cannot read. A copy that agrees with the
  // original today is the Transcribed Oracle shape, not an exception to it.
  //
  // WHY NOT EXPORT `parseExecutedFiles` AND IMPORT IT — the obvious fix, and it
  // is not available at this scope. `check-test-execution.mjs` has NO exports
  // and NO entry guard: importing it RUNS THE WHOLE GUARD. Measured, not
  // assumed — an `await import(...)` of it walks all 16 workspace packages and
  // prints the report, and would `process.exit(1)` on a repo where the guard
  // fails, killing this self-test with the wrong error. Adding an entry guard
  // to a wired script is a larger change than the two findings this addresses.
  //
  // Reading the literal out of the source needs neither, and removes the second
  // description rather than making it currently-equal.
  // Keyed on the regex's CONTENT, not on the call that uses it. Keying on
  // `output.matchAll(...)` also works and breaks on a refactor that merely
  // lifts the literal into a named const — a legitimate edit that would fail
  // this self-test for no reason. Content-keying survives that, and is
  // unambiguous here: exactly ONE regex literal in the guard mentions both
  // PASS and FAIL, asserted below rather than assumed.
  const guardSource = readFileSync(EXECUTION, 'utf-8');
  const perSuiteAll = [...guardSource.matchAll(/\/((?:[^/\\\n]|\\.)+)\/([gimsuy]*)/g)].filter(
    (m) => m[1].includes('PASS') && m[1].includes('FAIL'),
  );

  // Fail loudly if the extraction stops working, and fail loudly if it becomes
  // ambiguous. A silent miss makes every assertion below vacuous, which is the
  // failure this block is about; a silent SECOND match would bind the test to
  // whichever literal happened to come first.
  check('jest: exactly one per-suite regex was located in the guard\'s source (#393)', perSuiteAll.length, 1);

  const perSuite = perSuiteAll[0] ?? null;

  const executedFiles = (text) =>
    perSuite === null
      ? null
      : new Set([...text.matchAll(new RegExp(perSuite[1], perSuite[2]))].map((m) => m[1].split('\\').join('/')));

  // Positive control on the extraction itself: the regex we just read must
  // recognise a real jest per-suite line. Without this, a regex that compiles
  // and matches nothing would make `suiteLine` uniformly false — and the
  // negative assertion below would pass for exactly the wrong reason.
  check(
    'jest: ...and it recognises a real per-suite line, so the extraction is not vacuous',
    executedFiles('  PASS src/sample.test.js\n')?.has('src/sample.test.js') === true,
    true,
  );

  const suiteLine = (name) => [...(executedFiles(out) ?? [])].some((f) => f.endsWith(`${name}.test.js`));

  // THE PAIRED POSITIVE, and it is the load-bearing half of this pair.
  //
  // "no per-suite line for the skipped file" is satisfied by jest never running
  // at all — a missing install, a bad config, a renamed CLI flag, a crash all
  // produce it, and nothing-ran is indistinguishable from ran-and-stayed-quiet
  // from the outside. Asserting the RUNNING file DID get a line is what makes
  // the negative below mean something, and it is why this check fails loudly
  // rather than passing vacuously when jest cannot run.
  check('jest: the control file DID emit a per-suite line, so jest actually ran (#346)', suiteLine('running'), true);

  // The property the docstring rests on.
  check('jest: a fully-skipped file emits NO per-suite line (#346)', suiteLine('skipped'), false);

  // NOT REDUNDANCY. This closes a SECOND vacuity path that neither assertion
  // above can see, and it was labelled "belt to the braces" until #393 — which
  // is the label a later tidy-up deletes after checking the other two still
  // pass. They will still pass. That is the point.
  //
  // The path: the skipped file is NEVER COLLECTED rather than skipped — a
  // `testPathIgnorePatterns` entry, a `testMatch` that misses it, a rename.
  // Walk all three assertions against it, with jest running perfectly:
  //
  //   control "running emitted a line"   TRUE  -> passes (jest really did run)
  //   "skipped emitted no line"          TRUE  -> passes VACUOUSLY
  //   summary reports a suite skipped    FALSE -> FAILS, alone
  //
  // The paired positive is blind to this BY CONSTRUCTION: it proves jest RAN,
  // never that jest SAW the second file. So the negative can pass for the wrong
  // reason while everything looks healthy, and only this assertion notices.
  //
  // The block below is that path as a FIXTURE rather than as this paragraph.
  check('jest: ...and reports it as SKIPPED rather than never collected', /Test Suites:[^\n]*\bskipped\b/.test(out), true);

  // ---------------------------------------------------------------------
  // The never-collected path, run for real (#393).
  //
  // Same two files, same jest, one config change: the second file is excluded
  // from collection. Nothing is skipped, so jest's summary says nothing about
  // skipped suites — and the two assertions above cannot tell that from the
  // genuine skip they are written for.
  //
  // WHAT THIS DOES AND DOES NOT DO, because the difference matters and the
  // issue asked for the stronger thing: it demonstrates MECHANICALLY that the
  // first two assertions are blind here and the third is not, so the "belt to
  // the braces" reading is contradicted by a fixture rather than by a comment.
  // It CANNOT make deleting the third assertion go red — no assertion can
  // observe its own absence, and a source-scan asserting "this file still
  // contains that line" would be a Decorative Guard checking a string in the
  // file that contains it. The defence is that the necessity is now
  // demonstrated next to it, not that removal is blocked.
  // ---------------------------------------------------------------------
  writeFileSync(
    join(dir, 'jest.ignored.config.js'),
    "module.exports = { testEnvironment: 'node', rootDir: '.', testPathIgnorePatterns: ['/node_modules/', 'skipped\\\\.test\\\\.js'] };\n",
  );
  const rIgnored = spawnSync(
    process.execPath,
    [jestBin, '--config', join(dir, 'jest.ignored.config.js'), '--ci'],
    { cwd: dir, encoding: 'utf-8' },
  );
  const outIgnored = `${rIgnored.stdout ?? ''}${rIgnored.stderr ?? ''}`;
  const ignoredHas = (name) =>
    [...(executedFiles(outIgnored) ?? [])].some((f) => f.endsWith(`${name}.test.js`));

  check('jest/never-collected: the control STILL passes — jest ran perfectly (#393)', ignoredHas('running'), true);
  check(
    'jest/never-collected: ...and the no-per-suite-line negative passes VACUOUSLY',
    ignoredHas('skipped'),
    false,
  );
  check(
    'jest/never-collected: ...while the SUMMARY assertion fails — the only one that notices (#393)',
    /Test Suites:[^\n]*\bskipped\b/.test(outIgnored),
    false,
  );
}

check(
  'per-file: a written exemption is honoured',
  runGuard(
    EXECUTION,
    scratchPerFile({
      onDisk: ['src/a.test.ts', 'src/b.test.ts'],
      reported: ['src/a.test.ts'],
      pkgOverrides: { askturret: { testFilesNotExecuted: { 'src/b.test.ts': 'fixture, not a suite' } } },
    }),
  ).code,
  0,
);

check(
  'per-file: an exemption with no reason is rejected',
  runGuard(
    EXECUTION,
    scratchPerFile({
      onDisk: ['src/a.test.ts', 'src/b.test.ts'],
      reported: ['src/a.test.ts'],
      pkgOverrides: { askturret: { testFilesNotExecuted: { 'src/b.test.ts': '' } } },
    }),
  ).code,
  1,
);

check(
  'per-file: a STALE exemption naming a file that does run is rejected',
  // Otherwise an exemption outlives its reason and quietly re-opens the hole.
  runGuard(
    EXECUTION,
    scratchPerFile({
      onDisk: ['src/a.test.ts'],
      reported: ['src/a.test.ts'],
      pkgOverrides: { askturret: { testFilesNotExecuted: { 'src/a.test.ts': 'no longer true' } } },
    }),
  ).code,
  1,
);

check(
  'per-file: a STALE exemption naming a file that no longer exists is rejected',
  runGuard(
    EXECUTION,
    scratchPerFile({
      onDisk: ['src/a.test.ts'],
      reported: ['src/a.test.ts'],
      pkgOverrides: { askturret: { testFilesNotExecuted: { 'src/gone.test.ts': 'deleted long ago' } } },
    }),
  ).code,
  1,
);

{
  // "This package has nothing to test" and "this package ships test files"
  // cannot both be true — the declaration would exempt those files from ever
  // running, which is precisely the silence being guarded against.
  const dir = scratchWorkspace({ askturret: { testsNotRequired: 'nothing to test here' } });
  mkdirSync(join(dir, 'packages', 'thing', 'src'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'thing', 'src', 'orphan.test.ts'), '// fixture\n');
  const r = runGuard(EXECUTION, dir);
  check('per-file: FAILS a testsNotRequired package that still ships test files', r.code, 1);
  check('per-file: ...and names the stranded file', r.out.includes('src/orphan.test.ts'), true);
}

check(
  'per-file: a package with NO test files is unaffected by the new check',
  // The check must not invent a requirement the package-level rules never had.
  runGuard(EXECUTION, scratchPerFile({ onDisk: [], reported: ['src/ghost.test.ts'] })).code,
  0,
);

// ---------------------------------------------------------------------------
// check-network-imports.mjs (#26)
//
// The telemetry policy's first clause — no outbound call unless the adopter
// configured one — is only as strong as this guard. Each case below is a way
// the guard could fail open (miss real egress) or cry wolf (flag something
// inert). Both make it worthless, for opposite reasons.
// ---------------------------------------------------------------------------

/** A throwaway directory with no packages/ tree at all. */
function scratchEmpty() {
  const dir = mkdtempSync(join(tmpdir(), 'netguard-empty-'));
  tmpDirs.push(dir);
  return dir;
}

/** A throwaway repo root holding one packages/<pkg>/src file. */
function scratchPackage(relPath, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'netguard-'));
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  tmpDirs.push(dir);
  return dir;
}

check(
  'network: flags a bare fetch() in a non-allowlisted file',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `export async function phoneHome() {
         await fetch('https://telemetry.example.com/collect');
       }`,
    ),
  ).code,
  1,
);

check(
  'network: flags a runtime import of undici outside the allowlist',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `import { request } from 'undici';
       export const go = () => request('https://example.com');`,
    ),
  ).code,
  1,
);

check(
  'network: flags node:-prefixed builtins too',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `import https from 'node:https';
       export const go = () => https.get('https://example.com');`,
    ),
  ).code,
  1,
);

// The mechanism this codebase actually uses is the global fetch, so an
// allowlisted file must still be able to use it or the guard is unshippable.
check(
  'network: allows fetch() inside an allowlisted executor file',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/executor/via-http.ts',
      `export async function call(url) {
         return fetch(url);
       }`,
    ),
  ).code,
  0,
);

check(
  'network: allows a network import inside an allowlisted transport file',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/transports/src/http/index.ts',
      `import http from 'node:http';
       export const serve = () => http.createServer();`,
    ),
  ).code,
  0,
);

// The gateway entry was `packages/gateway/src/` — a whole directory — until it
// was narrowed to the one file that needs it (#181). Both halves of that
// narrowing are pinned, because either alone can pass for the wrong reason: the
// listener must still be ALLOWED, and a sibling must now be CAUGHT.
check(
  'network: allows the inbound listener import in the allowlisted gateway server.ts',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/gateway/src/server.ts',
      `import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
       export const serve = () => createServer();`,
    ),
  ).code,
  0,
);

// The demonstration from #181, kept as a test: an outbound `node:https` call in
// `src/version.ts`, sitting beside the listener that is legitimately
// allowlisted. Under the directory entry this exited 0 and printed "No network
// access outside the allowlist" — the guard's own success message, over a file
// calling an arbitrary host. Restoring `packages/gateway/src/` reddens both
// assertions below.
{
  const dir = mkdtempSync(join(tmpdir(), 'netguard-gateway-'));
  mkdirSync(join(dir, 'packages', 'gateway', 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'packages', 'gateway', 'src', 'server.ts'),
    `import { createServer } from 'node:http';
     export const serve = () => createServer();`,
  );
  writeFileSync(
    join(dir, 'packages', 'gateway', 'src', 'version.ts'),
    `import { request } from 'node:https';
     export function phoneHome() { return request('https://example.com/collect'); }`,
  );
  tmpDirs.push(dir);

  const r = runGuard(NETWORK, dir);

  check(
    'network: flags an outbound call in a gateway file beside the allowlisted listener',
    r.code,
    1,
  );

  // Exit 1 on its own would ALSO be the result if the narrowing had broken the
  // legitimate case and flagged `server.ts` instead — the opposite failure, with
  // an identical exit code. Only the attribution separates them, so that is what
  // gets asserted rather than the summary.
  check(
    'network: attributes the violation to version.ts and leaves server.ts allowlisted',
    /packages\/gateway\/src\/version\.ts:\d+ — imports 'node:https'/.test(r.out) &&
      !/server\.ts:\d+ — /.test(r.out)
      ? 'version.ts only'
      : `wrong attribution:\n${r.out}`,
    'version.ts only',
  );
}

// A type-only import is erased before anything runs. Failing it would train
// people to route around the guard rather than fix real problems.
check(
  'network: does NOT flag a type-only import of http',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `import type { Server } from 'http';
       export type Held = Server;`,
    ),
  ).code,
  0,
);

// ...but a value binding smuggled in alongside a type binding is a real import.
// This is the exact shape that appears in this repo's own test files.
check(
  'network: DOES flag a mixed value+type import of http',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `import { createServer, type Server } from 'http';
       export const s = createServer();`,
    ),
  ).code,
  1,
);

// packages/explorer emits browser JavaScript inside a template literal, and
// that browser code calls fetch against the adopter's own server. It is not
// egress from the Node process. Flagging it is how a guard earns a reputation
// for crying wolf and gets switched off.
check(
  'network: does NOT flag fetch inside a template literal',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/explorer/src/html.ts',
      'export const page = `<script>fetch("/api/tools");</script>`;',
    ),
  ).code,
  0,
);

check(
  'network: does NOT flag a comment mentioning node-fetch',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `// We deliberately avoid node-fetch here; see docs/telemetry-policy.md.
       export const compile = () => 1;`,
    ),
  ).code,
  0,
);

// A method named fetch on an object is not the global one.
check(
  'network: does NOT flag a property call like client.fetch()',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `export const run = (client) => client.fetch('thing');`,
    ),
  ).code,
  0,
);

// A greedy cross-statement match (`[\s\S]*?` between `export` and `from`)
// reported a real import TWICE during development: once correctly, and once
// mis-attributed to an unrelated `export` line far above it.
//
// This fixture needs all three of its parts or it proves nothing:
//   1. an `export` on line 1 for the greedy match to start from,
//   2. a `;` before the import, which is what bounds the fixed regex,
//   3. a REAL `from '...'` clause for the greedy match to run onto.
//
// The first version of this test omitted (3). With no import anywhere, both
// the buggy and the fixed regex matched nothing and returned zero violations
// identically — so the suite stayed green with the bug reinstated. That is the
// #79 "test that cannot fail" class, caught in QA on PR #115.
//
// Exit code alone still cannot tell the two apart: both report at least one
// violation and exit 1. The count and the line number are the discriminators,
// so those are what get asserted.
{
  const r = runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `export interface Compiler { run(): void }
export const ok = true;

import { request } from 'undici';
export const go = () => request('https://example.com');
`,
    ),
  );
  const undiciHits = (r.out.match(/imports 'undici'/g) ?? []).length;

  check('network: still flags the undici import in this fixture', r.code, 1);

  // Greedy regex: 2 (line 1 spurious + line 4 real). Bounded: 1.
  check('network: reports the import once, not once per earlier export', undiciHits, 1);

  // The spurious hit lands on line 1, the `export interface` line.
  check(
    'network: does not mis-attribute the import to an earlier export line',
    /pass\.ts:1 — imports 'undici'/.test(r.out) ? 'mis-attributed to line 1' : 'attributed correctly',
    'attributed correctly',
  );
}

// Test files never ship to an adopter. Skipping them is deliberate; asserting
// it here means the decision is recorded rather than assumed.
check(
  'network: skips test files',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/__tests__/wiring.test.ts',
      `import { createServer } from 'http';
       it('serves', () => { createServer(); });`,
    ),
  ).code,
  0,
);

// Reporting success on a scan that examined nothing is the failure mode that
// would make every other assertion here meaningless.
check(
  'network: fails closed when there is no packages/ directory',
  runGuard(NETWORK, scratchEmpty()).code,
  1,
);

// ---------------------------------------------------------------------------
// check-nul-bytes.mjs (#119)
//
// The guard exists because nothing else in CI reads source at the byte level.
// Its own tests therefore have to write real bytes, not strings that look like
// them — asserting on '\\0' in a template literal would test the wrong thing.
// ---------------------------------------------------------------------------

/** A throwaway repo root holding one file written from explicit bytes. */
function scratchBytes(relPath, buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'nulguard-'));
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, buffer);
  tmpDirs.push(dir);
  return dir;
}

check(
  'nul: flags a NUL byte in a TypeScript file',
  runGuard(
    NUL,
    scratchBytes(
      'packages/core/src/thing.ts',
      Buffer.concat([Buffer.from("export const a = 'x"), Buffer.from([0x00]), Buffer.from("y';\n")]),
    ),
  ).code,
  1,
);

check(
  'nul: flags a NUL byte in JSON',
  runGuard(
    NUL,
    scratchBytes(
      'packages/core/config.json',
      Buffer.concat([Buffer.from('{"a":"b'), Buffer.from([0x00]), Buffer.from('c"}\n')]),
    ),
  ).code,
  1,
);

check(
  'nul: accepts a clean file',
  runGuard(NUL, scratchBytes('packages/core/src/thing.ts', Buffer.from("export const a = 'xy';\n")))
    .code,
  0,
);

// The literal two-character sequence backslash-zero is ordinary source and must
// not be confused with the byte it denotes.
check(
  'nul: does NOT flag an escaped \\0 written as source text',
  runGuard(
    NUL,
    scratchBytes('packages/core/src/thing.ts', Buffer.from("export const sep = '\\0';\n")),
  ).code,
  0,
);

// Multi-byte UTF-8 is not corruption; a guard that flagged it would be turned
// off within a day.
check(
  'nul: does NOT flag non-ASCII UTF-8',
  runGuard(
    NUL,
    scratchBytes('packages/core/src/thing.ts', Buffer.from("// §5.5 — em dash, ok\n", 'utf-8')),
  ).code,
  0,
);

check(
  'nul: fails closed when the scan finds no files',
  runGuard(NUL, mkdtempSync(join(tmpdir(), 'nulguard-empty-'))).code,
  1,
);

{
  const r = runGuard(
    NUL,
    scratchBytes(
      'packages/core/src/thing.ts',
      Buffer.concat([Buffer.from('const a = 1;\nconst b = '), Buffer.from([0x00]), Buffer.from('2;\n')]),
    ),
  );
  check('nul: reports the offending line number', r.out.includes('thing.ts:2') ? 'located' : r.out, 'located');
}

// ---------------------------------------------------------------------------
// check-nul-bytes.mjs — scan coverage (#121)
//
// Two coverage gaps, both found during #119's QA rather than by the guard
// itself. They are not bugs in what it checks; they are places it never looked.
// ---------------------------------------------------------------------------

const NUL_BYTES = (before, after) =>
  Buffer.concat([Buffer.from(before), Buffer.from([0x00]), Buffer.from(after)]);

/**
 * A throwaway repo root with every REQUIRED scan root present.
 *
 * Each required root gets a real file, so a fixture never trips the
 * empty-scan check or the missing-root check by accident — leaving whatever the
 * test is actually about as the only reason it can fail.
 */
function scratchRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nulroots-'));
  for (const root of ['packages', 'examples', 'docs', '.github']) {
    mkdirSync(join(dir, root), { recursive: true });
    writeFileSync(join(dir, root, 'placeholder.md'), `# ${root}\n`);
  }
  for (const [relPath, contents] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  tmpDirs.push(dir);
  return dir;
}

// The headline gap: Tester demonstrated that a NUL in a root-level file exited
// 0 while the same bytes under packages/ exited 1.
check(
  'nul: flags a NUL byte in a root-level package.json',
  runGuard(NUL, scratchRepo({ 'package.json': NUL_BYTES('{"name":"a', 'b"}\n') })).code,
  1,
);

check(
  'nul: flags a NUL byte in a root-level README.md',
  runGuard(NUL, scratchRepo({ 'README.md': NUL_BYTES('# Title\nbody ', ' more\n') })).code,
  1,
);

check(
  'nul: accepts clean root-level files',
  runGuard(
    NUL,
    scratchRepo({ 'package.json': '{"name":"a"}\n', 'tsconfig.json': '{}\n', 'README.md': '# ok\n' }),
  ).code,
  0,
);

// The root scan is a GLOB, not a scan root. If it recursed, it would walk
// node_modules — SKIP_DIRS only prunes by name, and an unlisted directory is
// deliberately out of scope. This is the assertion that would go red if someone
// "simplified" it into `walk(repoRoot)`.
check(
  'nul: does NOT recurse from the root into undeclared directories',
  runGuard(NUL, scratchRepo({ 'unlisted/deep/thing.ts': NUL_BYTES('const a = ', '1;\n') })).code,
  0,
);

// A missing REQUIRED root is visible by default, but not fatal — pointing the
// guard at a fixture is a legitimate thing to do.
{
  const r = runGuard(NUL, scratchBytes('README.md', Buffer.from('# only a root file\n')));
  check('nul: warns about a missing required root by default', r.code, 0);
  check(
    'nul: names the missing root in the warning',
    r.out.includes('packages/') && r.out.includes('REQUIRED') ? 'named' : r.out,
    'named',
  );
}

// ...and fatal under --require-roots, which is how CI runs it. This is the
// assertion that stops a renamed `packages/` from silently halving coverage
// while the guard still reports success.
{
  const r = runGuard(
    NUL,
    scratchBytes('README.md', Buffer.from('# only a root file\n')),
    '--require-roots',
  );
  check('nul: FAILS on a missing required root under --require-roots', r.code, 1);
  check(
    'nul: explains which required roots went missing',
    r.out.includes('required scan root(s) missing') ? 'explained' : r.out,
    'explained',
  );
}

// `scripts` is declared but does not exist in this repository. Declared roots
// marked optional must never fail, or CI could not run with --require-roots at
// all — which is the whole point of keeping the declaration.
{
  const r = runGuard(NUL, scratchRepo({ 'README.md': '# ok\n' }), '--require-roots');
  check('nul: a missing OPTIONAL root does not fail under --require-roots', r.code, 0);
  check(
    'nul: still reports the optional root as absent',
    r.out.includes('scripts/') ? 'reported' : r.out,
    'reported',
  );
}

// ---------------------------------------------------------------------------
// check-metric-cardinality.mjs (#39, §9.2)
//
// An unbounded metric label creates one time series per distinct value. This
// guard's own failure mode is the usual denylist trap: too narrow and it
// misses the spelling people actually write, too broad and it blocks correct
// labels until someone switches it off. Both directions are tested.
// ---------------------------------------------------------------------------

/** A throwaway package-shaped tree holding one source file. */
function scratchSource(relPath, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'cardguard-'));
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  tmpDirs.push(dir);
  return dir;
}

check(
  'cardinality: passes on the documented label sets',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      // `registry_hash` stood here as an example of an ALLOWED label until #136
      // denied the whole `hash` family: truncating a hash bounds a label's
      // width, never its value set. Replaced with `executor_type`, which is
      // bounded by the executor registry and is genuinely allowed.
      `export const D = [
         { name: METRIC.a, kind: 'counter', labels: ['method', 'outcome'] },
         { name: METRIC.b, kind: 'gauge', labels: ['tool', 'executor_type'] },
       ];\n`,
    ),
  ).code,
  0,
);

check(
  "cardinality: fails on a declared user_id label (the issue's stated case)",
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'counter', labels: ['method', 'user_id'] }];\n`,
    ),
  ).code,
  1,
);

check(
  'cardinality: fails on snake_case request_id, not just camelCase requestId',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'counter', labels: ['request_id'] }];\n`,
    ),
  ).code,
  1,
);

check(
  'cardinality: fails on a denied label passed at a CALL SITE, not just declared',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/dispatcher/index.ts',
      `metrics.add(METRIC.requestsTotal, 1, { method: 'tools/call', tenant: t });\n`,
    ),
  ).code,
  1,
);

check(
  'cardinality: does NOT fire on the ordinary declared labels `outcome` / `error_code`',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'counter', labels: ['outcome', 'error_code'] }];\n`,
    ),
  ).code,
  0,
);

// The case the assertion above was NAMED for but never exercised. Its old title
// claimed `outcome` "contains the denied term sub" — it does not — so it
// asserted a true result for a false reason, and would not have caught the
// guard being loosened to substring matching (#39 QA).
//
// `target` really does contain `arg`, and `subject` really does contain `sub`.
check(
  'cardinality: does NOT fire on labels containing a denied term as a mere SUBSTRING',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'counter', labels: ['target', 'subject'] }];\n`,
    ),
  ).code,
  0,
);

check(
  'cardinality: does NOT fire on executor_type, bulkhead, breaker, phase, decision',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'histogram', labels: ['executor_type', 'bulkhead', 'breaker', 'phase', 'decision'] }];\n`,
    ),
  ).code,
  0,
);

{
  const r = runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'counter', labels: ['tenantName'] }];\n`,
    ),
  );
  check(
    'cardinality: names the offending label and the term it matched',
    r.out.includes('tenantName') && r.out.includes('tenant') ? 'named' : r.out,
    'named',
  );
}

// ---------------------------------------------------------------------------
// The root `typecheck` script must be able to fail (#134)
//
// This file is about guards that stop working silently, and #134 was that same
// shape one level up: `typecheck` ran `tsc --noEmit`, which does not traverse
// project references. The root tsconfig has `files: []`, so the script checked
// NOTHING — it exited 0 on a tree containing a real type error, while reading,
// in PR after PR, as evidence that types were sound.
//
// Asserted on the SCRIPT STRING rather than by running tsc, deliberately: a
// full build takes minutes and this suite is meant to be fast. What can
// realistically regress is someone restoring `--noEmit` to make the script
// quicker, and that is exactly what these two catch.
//
// Note that `tsc -b --noEmit` is NOT an available compromise: TypeScript
// rejects it here with `TS6310: Referenced project may not disable emit`,
// because a project others reference must emit the .d.ts they check against.
// Build mode is the only invocation that checks this repository at all.
{
  const rootPkg = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf-8'));
  const typecheck = rootPkg.scripts?.typecheck ?? '';

  check(
    'scripts: root typecheck uses build mode, so it can actually fail',
    /(^|\s)(-b|--build)(\s|$)/.test(typecheck) ? 'build-mode' : `NOT build mode: "${typecheck}"`,
    'build-mode',
  );
  check(
    'scripts: root typecheck does not use --noEmit, which checks nothing here',
    typecheck.includes('--noEmit') ? `uses --noEmit: "${typecheck}"` : 'no --noEmit',
    'no --noEmit',
  );
}

// ---------------------------------------------------------------------------
// Guard self-tests resolve their own interpreter (#361)
//
// A self-test that spawns a bare `node` resolves the interpreter through PATH.
// Off PATH every spawn fails to START, so the suite reports a wall of red that
// is an ENVIRONMENTAL failure wearing the costume of a code defect. Measured
// before #361 fixed it: this suite 4 passed / 81 failed, check-adr-citations
// 0 / 10 — the latter total, and so indistinguishable from a broken guard.
//
// Placement is what makes it serious rather than merely noisy. THIS suite is
// what someone runs when they are already debugging a guard. They arrive
// holding the hypothesis "a guard is broken", and 81 red assertions confirm the
// wrong theory they walked in with.
//
// `process.execPath` is the interpreter already running this file: exact, and
// it cannot drift. Enforced here rather than left to preference because the
// wrong form was the MAJORITY — only 2 of 16 self-tests used execPath before
// #361 — and a dominant wrong pattern regrows unless something refuses it.
//
// Scope is deliberately narrow, and the boundary is a real distinction rather
// than a convenience:
//
//   - `git` and `npm` are genuine EXTERNAL tools with no in-process equivalent,
//     so spawning them by name is correct and stays allowed. `node` was never
//     in that category — the interpreter is already known, so resolving it
//     through PATH bought nothing and cost the failure above.
//   - PRODUCTION scripts are out of scope. sdk-upgrade-drill.mjs spawns a bare
//     `node` and is triaged separately (#361), because a production script
//     resolving the wrong interpreter fails in a live path rather than a test
//     run, and its fix may not be a plain substitution.
//
// The scan window is the sibling *.test.mjs files, NOT this assertion's own
// source — the pattern below is written so it cannot match itself, which is the
// Decorative Guard antipattern in docs/TESTING.md. Verified by reverting one
// call site and watching this go red while the rest of the suite stayed green.
// ---------------------------------------------------------------------------

{
  const BARE_NODE = /(?:spawnSync|spawn|execFileSync|execFile|execSync)\(\s*(['"])node\1/;
  const offenders = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs'))
    .filter((f) => BARE_NODE.test(readFileSync(join(here, f), 'utf-8')))
    .sort();

  check(
    'no guard self-test spawns a bare `node` — use process.execPath (#361)',
    offenders.join(', ') || 'none',
    'none',
  );
}

// ---------------------------------------------------------------------------
// Every guard script is NAMED BY A WORKFLOW STEP (#381)
//
// Guards assert things about the repository. Until now nothing asserted that a
// guard RUNS. A contributor could add `check-something.mjs`, write its
// self-test, watch the self-test pass, and ship a guard that never executes —
// protection withdrawn silently, and the moment it would have mattered is
// exactly the moment nobody is looking at it.
//
// #339 does not reach this. Its subject is `*.test.*` files compared against
// what jest reports executing; a script under `.github/scripts/` is not a jest
// test file and is not in that set at all.
//
// ## The subject is WORKFLOW steps, and only those
//
// This file invokes several guards itself, so "named by a workflow step" and
// "invoked by a self-test" are different properties. Only the first is being
// asserted. The scan window is workflow YAML and nothing else, so the
// conflation is structurally impossible rather than merely avoided — and there
// is a fixture below proving it, because "structurally impossible" is the kind
// of claim that stops being true during a refactor.
//
// ## Comments do not count as wiring
//
// Comments are stripped, and the line must also carry the invocation verb
// `node`. A guard named only in a comment is not wired, however reassuring the
// comment reads. Both a loose and a strict matcher agree on this repository
// today, so that strictness is UNOBSERVABLE here and is pinned by fixture
// rather than claimed from the real tree.
//
// That is TWO mechanisms, and they need TWO fixtures — a point QA had to make
// because the first version shipped one. Stripping `#.*$` removes the path
// ALONG WITH the comment, so the comment fixture reddens on comment-stripping
// alone and can say nothing about the verb. Dropping `/\bnode\b/` left the
// whole suite green. The verb now has its own fixture, naming a guard on a
// `- name:` line that carries no `node`, and it reddens under that mutation and
// no other.
//
// The `(?![\w.-])` boundary has a fixture too, and its real job is the
// direction the self-test fixture cannot reach: `check-b.mjs.bak` named by a
// workflow must not count as wiring for `check-b.mjs`.
//
// Residual, stated rather than left to be found: a mention on a non-`run:` YAML
// line that happens to contain `node` would still count. Closing that needs a
// YAML parser, which this repo's guards deliberately refuse.
// ---------------------------------------------------------------------------

/**
 * Guards that deliberately have no workflow step. An entry is a line in a diff.
 *
 * ## IT IS EMPTY, AND THE MECHANISM IS WHY (#434 condition 1)
 *
 * It held two entries: the mutation audit (#428 stage 1) and its self-test. The
 * audit was an INSTRUMENT rather than a standing control, so it legitimately had
 * no workflow step — that is what this list is for — but its self-test was
 * exempt only as a CONSEQUENCE, and that was a real weakening: the audit's own
 * assertions ran nowhere automated for as long as the entries existed.
 *
 * Both are now wired into `test-integrity`. The weakening ended the way stage 1
 * designed it to: the check below REJECTS A STALE EXEMPTION naming a file that
 * does run, so the moment the workflow step landed this file failed BY NAME
 * until both lines were deleted. The gap could only be ended, not quietly
 * inherited.
 *
 * Worth keeping in view now that the list is empty: an exemption's cost is not
 * the entry, it is the assertions the entry silences. Both of those entries
 * looked bounded and reasonable, and together they took the instrument that
 * measures every other guard's witness coverage entirely out of CI.
 *
 * If you are adding the first new entry: it must be a script that genuinely
 * should never be a step, not one whose wiring is merely inconvenient, and it
 * needs a DATED EXIT naming what would remove it. The two that were here had
 * one; an entry with no exit is how a list like this becomes the escape hatch
 * it was built to avoid.
 */
// EMPTY, and that is the point (#434 condition 1).
//
// Both entries were the mutation audit and its self-test. They are now wired
// into `test-integrity`, so the exemptions went STALE and this file failed by
// name until they were deleted — exactly as stage 1 designed. The gap could
// only be ended, not quietly inherited, and it has been ended.
//
// Keeping the map rather than deleting the mechanism: the stale-check works in
// both directions, so an empty ledger still asserts that nothing claims an
// exemption it no longer needs. If you are adding the first new entry, the
// standard from stage 1 stands — it must be a script that genuinely should
// never be a step, not one whose wiring is merely inconvenient, and it needs a
// dated exit. An entry with no exit is how a list like this becomes the escape
// hatch it was built to avoid.
const WIRING_EXEMPT = Object.freeze({});

function guardWiringReport({ scriptsDir, workflowsDir, exempt = {} }) {
  const fail = (cannotCheck) => ({ cannotCheck, unwired: [], staleExemptions: [], subjects: [], scanned: 0 });

  let workflowFiles;
  try {
    workflowFiles = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return fail(`cannot read ${workflowsDir}`);
  }
  if (workflowFiles.length === 0) return fail(`no workflow files under ${workflowsDir}`);

  const invocationLines = [];
  for (const f of workflowFiles) {
    let text;
    try {
      text = readFileSync(join(workflowsDir, f), 'utf-8');
    } catch {
      return fail(`cannot read ${f}`);
    }
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*$/, '');
      if (/\bnode\b/.test(line)) invocationLines.push(line);
    }
  }
  const invoked = invocationLines.join('\n');

  let scripts;
  try {
    scripts = readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs')).sort();
  } catch {
    return fail(`cannot read ${scriptsDir}`);
  }
  if (scripts.length === 0) return fail(`no guard scripts under ${scriptsDir}`);

  const isWired = (s) =>
    new RegExp(String.raw`\.github/scripts/${s.replace(/\./g, '\\.')}(?![\w.-])`).test(invoked);

  const unwired = scripts.filter((s) => exempt[s] === undefined && !isWired(s));

  // STALE EXEMPTIONS, both directions (#428).
  //
  // Until this existed the wiring exemption only ever SUPPRESSED. An entry
  // naming a script that is wired, or one that no longer exists, passed in
  // silence — verified by probe, not assumed: an entry for `check-guards.mjs`,
  // a file that does not exist at all, left the suite at 109/0.
  //
  // That mattered immediately. #428 stage 1 was approved on the reasoning that
  // its exemption is "self-clearing by construction — the guard rejects a stale
  // exemption naming a file that does run, so #434's wiring cannot land without
  // removing it." That property was TRUE of the per-file exemption mechanism
  // and NOT of this one; the decision rested on it either way. Rather than
  // accept an exemption that could be inherited forever, the property is made
  // real here.
  //
  // Both directions, because they decay differently: a wired-but-exempt entry
  // is a claim that has become false, and a nonexistent-file entry is a claim
  // about nothing. Neither should outlive its reason by being unread.
  const staleExemptions = Object.keys(exempt)
    .sort()
    .filter((s) => !scripts.includes(s) || isWired(s))
    .map((s) => ({
      script: s,
      reason: scripts.includes(s) ? 'is wired by a workflow step, so the exemption is false' : 'names a script that does not exist',
    }));
  // `subjects` is the enumerated set itself, returned rather than left internal
  // so the self-inclusion assertion can be made AGAINST THE CODE UNDER TEST
  // rather than against a second, independent `readdirSync`. A test that
  // re-enumerates the directory asserts "this file exists on disk" — true
  // whenever the test runs at all, and blind to a change in what this function
  // enumerates. QA proved that blindness: excluding `.test.mjs` here left the
  // suite fully green, which is exactly the special case the comment above says
  // this file must not be.
  return { cannotCheck: null, unwired, staleExemptions, subjects: scripts, scanned: scripts.length };
}

/** A fixture repo with the real layout: scripts on disk, workflows referencing them. */
function wiringFixture({ scripts = {}, workflows = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-wiring-'));
  tmpDirs.push(dir);
  const scriptsDir = join(dir, '.github', 'scripts');
  const workflowsDir = join(dir, '.github', 'workflows');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(workflowsDir, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(scriptsDir, name), body);
  for (const [name, body] of Object.entries(workflows)) writeFileSync(join(workflowsDir, name), body);
  return { scriptsDir, workflowsDir };
}

const wfStep = (script) => `jobs:\n  a:\n    steps:\n      - run: node .github/scripts/${script}\n`;

{
  // The real repository. Both halves matter: no unwired guard, AND the scan
  // window is non-empty — "all clean" and "there is nothing here" render
  // identically otherwise, which is the Decorative Guard shape.
  const real = guardWiringReport({
    scriptsDir: here,
    workflowsDir: join(here, '..', 'workflows'),
    exempt: WIRING_EXEMPT,
  });

  check('wiring: the real repository can be checked at all (#381)', real.cannotCheck, null);
  check(
    'wiring: every guard script is named by a workflow step (#381)',
    real.unwired.join(', ') || 'none',
    'none',
  );
  check('wiring: ...and the scan window was non-empty', real.scanned > 0, true);

  // The exemption list must not outlive its reasons (#428). Asserted against
  // the REAL list, so the two entries added for the stage 1 instrument fail the
  // build the moment #434 wires them — which is the property stage 1 was
  // approved on, and which did not exist until this assertion did.
  check(
    'wiring: no exemption in the real list is stale (#428)',
    real.staleExemptions.map((s) => s.script).join(', ') || 'none',
    'none',
  );

  // The recursion. This file is a guard, so it is subject to the gap it closes,
  // and it must sit inside its own subject set rather than be exempt from it.
  //
  // The honest limit, because it cannot be asserted away: unwiring THIS file
  // stops this check running in CI, so it cannot catch its own removal there.
  // What it can do is refuse to be a special case — it is enumerated like every
  // other guard, and a local run of this file after such a removal does report
  // it. Verified by mutation, not assumed.
  check(
    'wiring: this check includes ITSELF in the set it enumerates (#381)',
    real.subjects.includes('check-guards.test.mjs'),
    true,
  );
}

{
  const { scriptsDir, workflowsDir } = wiringFixture({
    scripts: { 'check-wired.mjs': '', 'check-orphan.mjs': '' },
    workflows: { 'test.yml': wfStep('check-wired.mjs') },
  });
  const r = guardWiringReport({ scriptsDir, workflowsDir });

  check('wiring: a guard named by no workflow step is reported (#381)', r.unwired.length, 1);
  check('wiring: ...and it is NAMED, not merely counted', r.unwired[0], 'check-orphan.mjs');
  check('wiring: ...while the wired one is not reported', r.unwired.includes('check-wired.mjs'), false);
}

{
  // The strictness that is unobservable on the real repository.
  const { scriptsDir, workflowsDir } = wiringFixture({
    scripts: { 'check-mentioned.mjs': '' },
    workflows: {
      'test.yml':
        'jobs:\n  a:\n    steps:\n      # node .github/scripts/check-mentioned.mjs — used to run here\n      - run: echo hi\n',
    },
  });
  const r = guardWiringReport({ scriptsDir, workflowsDir });

  check(
    'wiring: a guard named ONLY in a comment is still unwired (#381)',
    r.unwired.join(', '),
    'check-mentioned.mjs',
  );
}

{
  // The other half of the strictness: the INVOCATION VERB. The comment fixture
  // above cannot reach this — stripping `#.*$` takes the path with it, so that
  // fixture reddens on comment-stripping alone and is blind to `/\bnode\b/`.
  // Here the path is named on a line that survives stripping intact and simply
  // is not an invocation.
  const { scriptsDir, workflowsDir } = wiringFixture({
    scripts: { 'check-named.mjs': '' },
    workflows: {
      'test.yml':
        'jobs:\n  a:\n    steps:\n      - name: runs .github/scripts/check-named.mjs eventually\n        run: echo hi\n',
    },
  });
  const r = guardWiringReport({ scriptsDir, workflowsDir });

  check(
    'wiring: a guard named on a line WITHOUT the invocation verb is still unwired (#381)',
    r.unwired.join(', '),
    'check-named.mjs',
  );
}

{
  // The `(?![\w.-])` boundary, in the direction that actually bites. A leftover
  // `check-b.mjs.bak` still named by a workflow step must not be read as wiring
  // for the live `check-b.mjs` — that is protection withdrawn silently, which is
  // this section's whole subject.
  //
  // The self-test fixture below looks like it covers this and does not:
  // `check-orphan.mjs` is not a substring of `check-orphan.test.mjs`, so that
  // case never depends on the lookahead at all.
  const { scriptsDir, workflowsDir } = wiringFixture({
    scripts: { 'check-b.mjs': '' },
    workflows: { 'test.yml': wfStep('check-b.mjs.bak') },
  });
  const r = guardWiringReport({ scriptsDir, workflowsDir });

  check(
    'wiring: a longer path that merely starts with a guard name is not wiring for it (#381)',
    r.unwired.join(', '),
    'check-b.mjs',
  );
}

{
  // The conflation guard. The orphan is invoked by ANOTHER SCRIPT, which is what
  // a self-test does. That must not count as wiring.
  const { scriptsDir, workflowsDir } = wiringFixture({
    scripts: {
      'check-orphan.mjs': '',
      'check-orphan.test.mjs': "spawnSync(process.execPath, ['.github/scripts/check-orphan.mjs']);\n",
    },
    workflows: { 'test.yml': wfStep('check-orphan.test.mjs') },
  });
  const r = guardWiringReport({ scriptsDir, workflowsDir });

  check(
    'wiring: invocation by a SELF-TEST does not count as being wired (#381)',
    r.unwired.join(', '),
    'check-orphan.mjs',
  );
}

{
  const { scriptsDir, workflowsDir } = wiringFixture({
    scripts: { 'check-orphan.mjs': '' },
    workflows: { 'test.yml': 'jobs:\n  a:\n    steps:\n      - run: echo hi\n' },
  });
  const r = guardWiringReport({
    scriptsDir,
    workflowsDir,
    exempt: { 'check-orphan.mjs': 'deliberately not wired, for this test' },
  });

  check('wiring: a written exemption is honoured (#381)', r.unwired.length, 0);
  // ...and honouring it is not the same as never looking at it again.
  check('wiring: ...and a LIVE exemption is not reported stale (#428)', r.staleExemptions.length, 0);
}

// ---------------------------------------------------------------------------
// A stale wiring exemption is REJECTED, both directions (#428).
//
// OBSERVED FAILING BEFORE THIS EXISTED. The wiring exemption only suppressed —
// an entry naming a wired script, or one naming a file absent from the tree,
// passed in silence. Probed rather than assumed: an entry for a nonexistent
// `check-guards.mjs` left the real suite at 109/0.
//
// It is not a hypothetical gap. #428 stage 1's exemption was approved on the
// reasoning that it is "self-clearing by construction", which was true of the
// per-file exemption mechanism and false of this one. These two cases are what
// make the reasoning true.
// ---------------------------------------------------------------------------
{
  const { scriptsDir, workflowsDir } = wiringFixture({
    scripts: { 'check-wired.mjs': '', 'check-orphan.mjs': '' },
    workflows: {
      'test.yml': 'jobs:\n  a:\n    steps:\n      - run: node .github/scripts/check-wired.mjs\n',
    },
  });

  // Direction 1: the exempt script IS wired, so the claim has become false.
  const wiredButExempt = guardWiringReport({
    scriptsDir,
    workflowsDir,
    exempt: { 'check-wired.mjs': 'claims it is deliberately unwired' },
  });
  check('wiring: an exemption for a WIRED script is stale (#428)', wiredButExempt.staleExemptions.length, 1);
  check(
    '...and says WHY it is stale, not merely that it is',
    wiredButExempt.staleExemptions[0]?.reason,
    'is wired by a workflow step, so the exemption is false',
  );

  // Direction 2: the exempt script does not exist, so the claim is about
  // nothing. Decays differently from direction 1 and is reported differently.
  const ghost = guardWiringReport({
    scriptsDir,
    workflowsDir,
    exempt: { 'check-deleted.mjs': 'a script that was removed' },
  });
  check('wiring: an exemption naming a NONEXISTENT script is stale (#428)', ghost.staleExemptions.length, 1);
  check(
    '...and is distinguished from the wired-but-exempt case',
    ghost.staleExemptions[0]?.reason,
    'names a script that does not exist',
  );

  // The paired negative, so the two above are not satisfied by a check that
  // calls every exemption stale.
  const live = guardWiringReport({
    scriptsDir,
    workflowsDir,
    exempt: { 'check-orphan.mjs': 'genuinely unwired, genuinely present' },
  });
  check('...while a genuinely live exemption is NOT stale', live.staleExemptions.length, 0);
  check('...and it still suppresses the unwired report', live.unwired.length, 0);
}

{
  // Fail closed. "I could not tell" is not "it passed" — and note the shape of
  // the bug this prevents: with no workflows readable, EVERY guard looks
  // unwired, but the honest report is that nothing could be determined. The
  // opposite error is the dangerous one and is what is asserted here: returning
  // an empty `unwired` list, which reads exactly like success.
  const missing = guardWiringReport({
    scriptsDir: here,
    workflowsDir: join(tmpdir(), 'guard-wiring-does-not-exist'),
  });
  check(
    'wiring: an unreadable workflow set is CANNOT CHECK, not a pass (#381)',
    missing.cannotCheck !== null,
    true,
  );
  check('wiring: ...and it does not report a clean result alongside that', missing.unwired.length, 0);

  const { scriptsDir, workflowsDir } = wiringFixture({ scripts: { 'check-a.mjs': '' }, workflows: {} });
  const empty = guardWiringReport({ scriptsDir, workflowsDir });
  check('wiring: a workflow directory with NO workflows is CANNOT CHECK', empty.cannotCheck !== null, true);
}

// ---------------------------------------------------------------------------
// SPAWN SAFETY, DERIVED ACROSS EVERY SCRIPT (#509)
//
// #443 swept the child-spawning guards from a hand-written list. The list was
// already stale when that work began — the population moved 8 -> 9 mid-issue,
// because #324 added a script after the issue was filed. The tenth is the one
// nobody notices, so the population is derived here instead.
//
// ## WHY THIS IS NOT A GREP, AND WHY THAT MATTERS MORE THAN THE ENUMERATION
//
// The obvious implementation asks the source whether it "has the didNotStart
// check". I built exactly that during #443 and it was WRONG THREE TIMES OUT OF
// THREE before I read the sites:
//
//   * flagged `spawnFailureDetail`'s own `result?.error?.message` — optional-
//     chained, and safe;
//   * flagged a dereference that `if (result.error)` guarded on the same line;
//   * reported `check-workspace-artifacts` as having NO condition, when it
//     spells a correct one as `typeof res.status !== 'number'`.
//
// That is #443's own finding running in BOTH directions: a grep reads
// incomplete code as fine AND correct code as missing. I declined to ship it,
// on the reasoning that a guard with a 3-of-3 false-positive rate is one people
// learn to skim. So this asserts BEHAVIOUR instead: run the script with a PATH
// on which its child cannot be found, and see what it does. An idiom this
// author never thought of passes, because the script behaves correctly — which
// is the property, rather than a spelling of it.
//
// ## THE PROBE MUST PROVE IT REACHED THE SPAWN
//
// Found by running it: an empty-PATH probe passed `check-path-filters` at exit
// 0 having tested nothing, because that script only diffs when a PR payload is
// present and locally there is none. A probe that cannot reach the branch it
// claims to test is the same empty pass as a validator run before committing
// (#514) — the third instance of that shape in one day.
//
// So a script counts as WITNESSED only when its output shows the spawn actually
// failed. Anything else is NOT REACHED and must be declared below, never
// silently passed.
//
// ## WHAT THIS DOES NOT COVER — the ENOENT row only, on real scripts
//
// The assertion names below read stronger than the coverage is, so the bound
// belongs here rather than in a completion report nobody reads twice.
//
// An unresolvable PATH produces exactly ONE of the two `status === null` rows:
// the child never STARTS, and `error` is set. The other row — killed by a
// signal, `error` UNDEFINED — is the one #443 finding 2 is actually about, and
// NO PATH MANIPULATION PRODUCES IT. It is reachable only in the fixtures below,
// where a child SIGKILLs itself.
//
// Two consequences, both of which were reported as stronger than they are:
//
//   1. **This does not replace the per-file source assertions from #443.** Those
//      remain the only thing pinning the signal row on the real scripts.
//   2. **A tenth spawning script is ENUMERATED here, but its keying is not
//      verified.** The derivation finds it, and an unprobeable one must be
//      declared or `undeclared` fails — but if the probe DOES reach it, all that
//      is exercised is the ENOENT row, where the finding-2 defect is harmless.
//      QA demonstrated this end-to-end: a fixture script carrying the defect,
//      once wired, passes this suite 147/0.
//
// The earlier claim that #381's wiring guard catches such a script is true and
// beside the point: it catches an UNWIRED script, and #381 requires wiring
// anyway. That is a missing STEP being detected, not a missing keying — so once
// the author does the thing they were going to do, nothing here objects.
// ---------------------------------------------------------------------------

/** Scripts that spawn a child, derived rather than listed. */
export function spawningScripts(scriptsDir) {
  const strip = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

  const out = [];
  for (const f of readdirSync(scriptsDir).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')).sort()) {
    const code = strip(readFileSync(join(scriptsDir, f), 'utf-8'));
    if (!/\b(spawnSync|execFileSync|execSync)\s*\(|\bspawn\s*\(/.test(code)) continue;
    // A bare name resolves through PATH, so an unresolvable PATH reaches the
    // never-started branch. `process.execPath` is absolute and always resolves,
    // so no PATH manipulation can reach it — a real limit, declared below.
    const byName = /\b(?:spawnSync|execFileSync|spawn)\s*\(\s*'[^']+'/.test(code);
    out.push({ name: f, byName });
  }
  return out;
}

/**
 * Scripts the behavioural probe cannot witness, with the reason and what would
 * change it. Bidirectional, like `WIRING_EXEMPT`: a declaration that turns out
 * to be witnessable is STALE and fails, so this cannot quietly outlive its
 * cause.
 *
 * WHAT THE STALENESS CHECK DOES NOT CHECK — read this before adding an entry.
 * It tests two things: that the script still spawns, and that the probe still
 * cannot reach it. It does NOT test whether the stated REASON is true, and it
 * cannot: the reason is a claim about WHY the probe stops, which is exactly what
 * a run that never reaches the spawn produces no evidence about.
 *
 * So a wrong reason survives here indefinitely, in the one artifact carrying
 * this knowledge forward — and it has already happened once. The first
 * `check-test-execution.mjs` entry asserted a manifest-only verdict and proposed
 * a remedy that would not have worked, while the correct explanation sat in a
 * comment one file away. QA caught it by RUNNING the script under the probe's
 * conditions. Do the same before you write an entry: the ledger will not.
 */
const PROBE_UNREACHABLE = Object.freeze({
  'check-mutation-audit.mjs':
    'spawns process.execPath, which is absolute and always resolves — no PATH can make it fail to start. ' +
    'Its keying is pinned by source assertion in its own self-test instead (#443). Witnessable only by ' +
    'injecting a spawn seam.',
  'sdk-upgrade-drill.mjs':
    'spawns process.execPath, same as above. It is the reference implementation of didNotStart, and its ' +
    'classifier is exercised directly — including against a genuinely SIGKILLed child — in its own self-test.',
  'check-path-filters.mjs':
    'only diffs when a PR payload is present, so outside Actions it exits before reaching the spawn. ' +
    'Witnessable by running it with a fixture GITHUB_EVENT_PATH.',
  'check-test-execution.mjs':
    'builds its CHILD\'S PATH itself — CHILD_PATH prepends dirname(process.execPath), which is where npm lives ' +
    '— so an emptied parent PATH never reaches the child and the suites genuinely run. Verified by running it ' +
    'under the probe\'s exact conditions: exit 0 in ~24s, "16 package(s): 12 running tests, 4 declared exempt", ' +
    '874 tests executed. There is no spawn failure to surface, because nothing failed to spawn: that is #429\'s ' +
    'fix working as designed, and the script says so itself at the CANNOT-CHECK backstop ("CHILD_PATH above ' +
    'should make this unreachable for the PATH case"). Witnessable only by injecting a spawn seam — the same ' +
    'class of remedy as the two execPath scripts above, not a reporting change.',
});

/**
 * Run a script with a PATH on which its child cannot be found.
 *
 * NEVER call this on a script that spawns `process.execPath`. That binary is
 * absolute, so an unresolvable PATH does not stop it and the script runs for
 * real — which for `check-mutation-audit.mjs` means a 330-second run that
 * MUTATES GUARD FILES ON DISK. The first version of this block did exactly that
 * through its staleness check, and the suite had to be killed; the audit's own
 * SIGINT handler is what left the tree clean (#435). `byName` from the
 * derivation is the guard, and it is structural rather than a judgement.
 */
function probeSpawnSafety(scriptPath, cwd) {
  const nowhere = mkdtempSync(join(tmpdir(), 'no-bin-'));
  tmpDirs.push(nowhere);
  // process.execPath, NOT `node`: emptying PATH also hides the interpreter, and
  // the run then dies at exit 127 having executed nothing. Found by doing it —
  // seven scripts "passed" in 2ms before I noticed none had started.
  const run = spawnSync(process.execPath, [scriptPath, cwd], {
    cwd,
    encoding: 'utf-8',
    // Bounded, because a script that ignores the missing child can take tens of
    // seconds. A timeout is NOT evidence of safety — it reads as "not reached",
    // which must then be declared like any other unreachable case.
    timeout: 10_000,
    env: { ...process.env, PATH: nowhere },
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  return {
    reached: /ENOENT|COULD NOT RUN|could not be run|could not run/i.test(out),
    exit: run.status,
    crashed: /TypeError|at ModuleJob/.test(out),
  };
}

{
  const scriptsDir = join(here, '..', '..', '.github', 'scripts');
  const repoRoot = join(here, '..', '..');
  const derived = spawningScripts(scriptsDir);

  // A deriver that finds nothing would make every assertion below vacuous.
  check('spawn: the derived population is non-empty', derived.length > 0, true);
  check(
    'spawn: ...and contains a script known to spawn',
    derived.some((d) => d.name === 'generate-sbom.mjs'),
    true,
  );

  // ONE probe per script, and only for the ones a PATH can reach. The results
  // drive both the property assertions and the staleness check, so nothing is
  // executed twice and nothing that spawns `process.execPath` is executed here
  // at all.
  const probed = new Map();
  for (const { name, byName } of derived) {
    if (!byName) continue;
    probed.set(name, probeSpawnSafety(join(scriptsDir, name), repoRoot));
  }

  const witnessed = [];
  const undeclared = [];
  for (const { name, byName } of derived) {
    const declared = Object.prototype.hasOwnProperty.call(PROBE_UNREACHABLE, name);
    const r = probed.get(name);

    if (!byName || r === undefined || !r.reached) {
      // The probe cannot speak for this script. That is allowed, and it must be
      // SAID — an undeclared silence here is a script nobody is checking.
      if (!declared) undeclared.push(name);
      continue;
    }

    witnessed.push(name);
    // THE PROPERTY. A child that cannot start must not crash the guard, and
    // must not be reported as success.
    //
    // The row is named IN THE ASSERTION, not only in the header: an unresolvable
    // PATH reaches the never-started row and no other, so a name reading "when
    // its child cannot start" would claim both rows in the one place a reader
    // meets first — the output.
    check(`spawn: ${name} does not crash when its child cannot start (ENOENT row)`, r.crashed, false);
    check(`spawn: ${name} refuses rather than passing (ENOENT row)`, r.exit !== 0, true);
  }

  check('spawn: every unprobeable script is declared', undeclared.join(',') || 'none', 'none');
  check('spawn: at least one script was actually witnessed', witnessed.length > 0, true);

  // STALE DECLARATIONS FAIL, so the ledger cannot outlive its cause — the same
  // bidirectional rule `WIRING_EXEMPT` uses. A declaration is stale when the
  // script no longer spawns at all, or when the probe now reaches it.
  const stale = Object.keys(PROBE_UNREACHABLE).filter(
    (n) => !derived.some((d) => d.name === n) || probed.get(n)?.reached === true,
  );
  check('spawn: no unreachable declaration is stale', stale.join(',') || 'none', 'none');
}

// BOTH DIRECTIONS, against fixtures — the half that decides whether this is a
// property or a false-positive machine.
{
  const dir = mkdtempSync(join(tmpdir(), 'spawnfix-'));
  tmpDirs.push(dir);

  // #443 FINDING 2, REPRODUCED RATHER THAN IMITATED. It keeps the condition
  // (`status === null`) and drops the defence, reading `.error.message`.
  //
  // The child SIGKILLs ITSELF, because that is the only row where the defect
  // bites: a child that fails to START sets `error`, so the same line is
  // harmless there. My first version of this fixture spawned a missing binary
  // and crashed on a chained call that would have thrown anywhere — an
  // artificial crash standing in for a real one, which would have made the
  // whole both-directions claim decorative.
  writeFileSync(
    join(dir, 'bad.mjs'),
    "import { spawnSync } from 'node:child_process';\n" +
      'const r = spawnSync(process.execPath, ["-e", "process.kill(process.pid,\'SIGKILL\')"]);\n' +
      'if (r.status === null) { console.error(`could not run: ${r.error.message}`); process.exit(2); }\n' +
      'process.exit(0);\n',
  );

  // The same shape WITH the defence — the shared helper's guarded form. It must
  // pass, or the fixture above proves only that crashing code crashes.
  writeFileSync(
    join(dir, 'guarded.mjs'),
    "import { spawnSync } from 'node:child_process';\n" +
      'const r = spawnSync(process.execPath, ["-e", "process.kill(process.pid,\'SIGKILL\')"]);\n' +
      "if (r.status === null) { console.error(`could not run: ${r.error?.message ?? ('killed by signal ' + r.signal)}`); process.exit(2); }\n" +
      'process.exit(0);\n',
  );

  // A DIFFERENT correct idiom — the one my grep called missing. It must pass.
  writeFileSync(
    join(dir, 'other-idiom.mjs'),
    "import { spawnSync } from 'node:child_process';\n" +
      "const r = spawnSync('definitely-not-a-real-binary', []);\n" +
      "if (typeof r.status !== 'number') { console.error('ENOENT: could not run the child'); process.exit(2); }\n" +
      'process.exit(0);\n',
  );

  const bad = probeSpawnSafety(join(dir, 'bad.mjs'), dir);
  const guarded = probeSpawnSafety(join(dir, 'guarded.mjs'), dir);
  const other = probeSpawnSafety(join(dir, 'other-idiom.mjs'), dir);

  // DIRECTION 1 — the defect is caught.
  check('spawn: dropping the defence CRASHES on the signal row', bad.crashed, true);

  // DIRECTION 2 — and correct code is NOT flagged, which is the half that
  // decides whether this is a property or the false-positive machine I declined
  // to ship on #443. Two different correct spellings, neither of which this
  // author would have matched with a pattern.
  check('spawn: the same shape WITH the defence does not crash', guarded.crashed, false);
  check('spawn: ...and still refuses rather than passing', guarded.exit !== 0, true);
  check('spawn: a DIFFERENT correct idiom does not crash', other.crashed, false);
  check('spawn: ...and it refuses rather than passing', other.exit !== 0, true);
  // The one that matters most: the idiom my own grep reported as MISSING a
  // condition is accepted here, because the script behaves correctly.
  check('spawn: ...so `typeof status !== "number"` PASSES, where a grep failed it', !other.crashed && other.exit !== 0, true);

  // And the deriver finds all three fixtures, so the enumeration is not the
  // weak link in the chain above.
  const found = spawningScripts(dir).map((d) => d.name).sort().join(',');
  check('spawn: the deriver finds every fixture', found, 'bad.mjs,guarded.mjs,other-idiom.mjs');
}

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
