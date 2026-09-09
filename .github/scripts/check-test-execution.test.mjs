#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the test-execution guard (#531).
 *
 * ## Why this file did not exist, and why that is the whole point
 *
 * The #431/#443 partition assigned this script to #443 "including writing their
 * self-tests". #443 closed as done via PR #507, which created
 * `generate-sbom.test.mjs` and never touched this one — and this script is not
 * among the four residuals that PR's own "deliberately not done" list names. So
 * it was an OMISSION, not a descope, and the remedy is a witness rather than an
 * exemption entry. Writing an exemption here would launder a delivery gap
 * through the ledger the exemption ledger exists to keep honest.
 *
 * ## NO SEAM REFACTOR WAS NEEDED, and that is a measurement rather than a view
 *
 * The cost note on #531 said this script exports nothing, so a self-test would
 * need a spawn seam injected first. Measured before writing any production
 * change: all three failure sites are reachable through the REAL entry point,
 * because the script is already parameterised by `process.argv[2]`.
 *
 * The third site looked like the exception — it fires only when npm cannot
 * start, and `CHILD_PATH` prepends `dirname(process.execPath)`, where npm lives
 * beside node. That is exactly #349's prior: a site that reads as unwitnessable
 * turning out to be witnessable with a fixture parameter. The parameter here is
 * WHERE THE INTERPRETER LIVES:
 *
 *   /usr/bin/npm and /bin/npm do not exist on this machine, so the only
 *   CHILD_PATH entry that supplies npm is `dirname(process.execPath)`. Run the
 *   guard with a node whose directory holds no npm, and an empty PATH, and npm
 *   is genuinely unresolvable.
 *
 * A SYMLINK will not do — Node resolves `process.execPath` through symlinks, so
 * the real directory comes back. A HARDLINK has no target to resolve, so
 * `execPath` becomes the link's own path. That is the trick, and it is stated
 * because it looks like a workaround and is load-bearing.
 *
 * THE RELOCATION IS A COPY, AND THE CHILD IS GIVEN `DYLD_LIBRARY_PATH`. Both,
 * because either alone is worse than the pair (#674). The ladder is therefore
 * copy -> declare; the declaration is a CANNOT CHECK that says which rung
 * failed, and is never a silent skip, because a case that quietly does not run
 * is the empty pass this repository has spent the week removing.
 *
 * A HARDLINK WAS THE PREVIOUS FIRST RUNG AND HAS BEEN REMOVED. It is not a
 * cheaper copy: the link and the real binary are the SAME INODE, and that is
 * the configuration in which spawning the relocated child poisons the next
 * spawn of the REAL one in this process. Measured cold on this host, 30 trials
 * per variant, each trial a fresh process whose first spawn is the relocated
 * interpreter:
 *
 *   variant             relocated child ran   next REAL spawn poisoned
 *   hardlink + plain           10/30                    0/30
 *   hardlink + DYLD            30/30                    8/30
 *   copy     + plain            0/30                    0/30
 *   copy     + DYLD            30/30                    0/30
 *
 * READ THE SECOND ROW BEFORE REACHING FOR THE ONE-LINE FIX. Adding
 * `DYLD_LIBRARY_PATH` alone repairs this site perfectly and INTRODUCES the
 * poisoning — 0/30 to 8/30. The mechanism is visible in the first row: today
 * the relocated child usually dies, so it never gets far enough to leave
 * anything behind. Make it succeed without changing the inode and it does.
 *
 * Copy alone is not enough either — 0/30, because the library lookup is
 * independent of how the binary arrived. Only the pair gives a site that runs
 * AND leaves the next spawn alone.
 *
 * The cost objection does not survive measurement: the binary is 68,384 bytes
 * (66.8 KB) because the bulk lives in `libnode.*.dylib`, and the copy measured
 * 0.2 ms mean over 20 runs.
 *
 * The library directory is DERIVED, `dirname(dirname(execPath))/lib`, so no
 * version is hardcoded — it resolves to the `lib` beside the `bin` that
 * `execPath` names, and Node has already resolved `execPath` through symlinks,
 * which is the same fact the hardlink note above relies on.
 *
 * ONLY macOS IS MEASURED. `LD_LIBRARY_PATH` is deliberately NOT set: nothing
 * here has measured Linux, the copy rung may behave differently there, and
 * adding an unmeasured knob to a file about unmeasured claims would be the
 * wrong shape. If this site proves flaky on Linux, that is the analogous knob
 * and it wants its own measurement first.
 *
 * ## The control is not decorative
 *
 * Three failure cases could all pass against a guard that fails everything, so
 * the exempt-package case pins that this guard reaches exit 0 on a clean tree.
 * It is cheap deliberately: a package declaring `askturret.testsNotRequired`
 * with no test files never spawns npm, so the control needs no installed
 * dependencies and no test runner.
 *
 * Run: node .github/scripts/check-test-execution.test.mjs
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// #581: the same helpers check-mutation-audit uses for this exact distinction.
// Imported rather than reimplemented — an inlined copy of `didNotStart` that
// dropped `spawnFailureDetail`'s undefined-`error` defence is #443 finding 2,
// and this module is import-safe (its entry point is behind
// `isProcessEntryPoint`), so importing it executes nothing.
import { didNotStart, spawnFailureDetail } from './sdk-upgrade-drill.mjs';

// `fileURLToPath`, NOT `new URL(...).pathname` — the latter percent-encodes, so a
// checkout path containing a space resolves to a file that does not exist. That is
// #110 exactly, and it caught this file while it was being written for the guard
// family whose own docs record it.
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-test-execution.mjs');

let passed = 0;
let failed = 0;
let cannotChecked = 0;
const tmpDirs = [];

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed += 1;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed += 1;
  }
}

/**
 * A case this ENVIRONMENT cannot reach. Announced AND counted (#561).
 *
 * A helper rather than two inline `console.log`s, because the two have to move
 * together: the defect being fixed is a skip that was loud in the body and
 * invisible in the summary, and a second copy of "print, then remember to
 * increment" is how that comes back. Routing every announcement through here
 * makes printing without counting impossible by construction rather than by
 * discipline — the same reason the guard's own fallback list is pinned rather
 * than trusted a few lines below.
 *
 * It does NOT touch `failed`. A skip is not a failure, and the exit code must
 * stay 0: site 494 is unreachable on most Linux images BY DESIGN, so failing
 * here would be a permanent red nobody can clear for a guard working correctly.
 * The mutation audit is the fail-closed layer that records the site unwitnessed.
 */
function cannotCheck(message) {
  console.log(`CANNOT CHECK - ${message}`);
  cannotChecked += 1;
}

/**
 * The summary line, as a pure function so it can be asserted (#561).
 *
 * Extracted for exactly one reason: before this, the printed figures were
 * pinned NOWHERE. That is the shape this repository keeps meeting — #541's
 * `honoured` counter, `main()`'s OK-line count on #533 — and adding a third
 * figure without a witness would have joined that list, on the issue whose
 * whole subject is a summary that hides something.
 *
 * The third category is printed ALWAYS, including as `0 cannot-check`. Omitting
 * it when zero would re-create the ambiguity being removed: a reader could not
 * tell "nothing was skipped" from "this version does not report skips", which is
 * the same glance-level confusion as `8 passed, 0 failed` against the full 12.
 */
function summaryLine(p, f, c) {
  return `${p} passed, ${f} failed, ${c} cannot-check`;
}

/**
 * The VERDICT, as a pure function so it can be asserted (#679).
 *
 * Same move as `summaryLine` above and for the same reason, one level up: that
 * one was extracted because the printed FIGURES were pinned nowhere; this one
 * because the EXIT CODE was. "`cannotChecked` is reported, never gating" was a
 * comment plus the shape of an expression, and the two `summaryLine` tests pin
 * the string this run prints — not the verdict it returns.
 *
 * WHY THAT GAP WAS WORTH CLOSING RATHER THAN NOTING. #434 is a fail-closed flip:
 * making guards refuse rather than tolerate is a planned direction here, so
 * somebody writing `f === 0 && c === 0` is a PREDICTED edit, not a far-fetched
 * one. It would not look like a mistake in review — it looks like tightening a
 * guard, which is the thing we keep asking for. The truth table below is what
 * turns it from an accident into a decision.
 *
 * `c` IS DELIBERATELY UNREAD, and it is a parameter precisely so that the
 * not-reading is expressible as a test — `exitCodeFor(0, 18) === 0` — instead of
 * as prose about an expression. A skip must still exit 0: site 494 is
 * unreachable on most Linux images BY DESIGN, so gating on it would be a
 * permanent red nobody can clear for a guard working correctly. The mutation
 * audit is the fail-closed layer that records such a site unwitnessed.
 */
function exitCodeFor(f, c) {
  void c;
  return f === 0 ? 0 : 1;
}

/** A throwaway repo root: a root package.json plus the given packages. */
function fixture({ workspaces = ['packages/*'], packages = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'test-execution-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces }));
  for (const [name, { pkg, files = {} }] of Object.entries(packages)) {
    const pkgDir = join(dir, 'packages', name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(pkgDir, rel)), { recursive: true });
      writeFileSync(join(pkgDir, rel), body);
    }
  }
  return dir;
}

/**
 * Run the guard against a fixture root, through its real entry point.
 *
 * THREE OUTCOMES, NOT TWO (#581). `spawnSync` reports `status: null` for two
 * entirely different events, and this harness used to return only `status`:
 *
 *   - the process NEVER STARTED       -> `error` is set (ENOENT, EACCES, ...)
 *   - the process ran and was KILLED  -> `error` is undefined, `signal` is set
 *
 * Returning `code: null` for both made a could-not-check present as a result —
 * in the file whose own site exists to draw exactly that distinction (#429). It
 * surfaced as an intermittent `expected 2, got null` whose real cause was a
 * relocated interpreter killed by SIGABRT (`dyld: Library not loaded:
 * @rpath/libnode.141.dylib`), with the empty output making the NEXT assertion
 * fail as a consequence — one failure wearing the signature of two.
 *
 * `didNotStart` and `spawnFailureDetail` are IMPORTED rather than reimplemented.
 * `didNotStart` is `status === null`, so it is true for BOTH rows above, and
 * `spawnFailureDetail` is the reason it exists: a caller that tests the
 * condition and then reads `result.error.message` dereferences `undefined` on a
 * signalled run — #443 finding 2, an inlined copy that kept the condition and
 * dropped its defence. `outcome` is what separates the two rows, which
 * `didNotStart` alone deliberately does not.
 */
function run(dir, { execPath = process.execPath, env = {} } = {}) {
  const r = spawnSync(execPath, [GUARD, dir], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });

  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  // `error` is tested FIRST because it is the only field that identifies a
  // spawn that never happened. Testing `signal` first would misreport an
  // ENOENT as a signal death on any platform that sets both.
  if (r.error) {
    return { code: null, outcome: 'spawn-failed', signal: r.signal ?? null, detail: spawnFailureDetail(r), out };
  }
  if (didNotStart(r)) {
    // No status and no error: the child ran and something killed it. Report the
    // signal by name — an OOM kill is a different operator action from a
    // missing shared library, and collapsing them throws that away.
    return { code: null, outcome: 'killed-by-signal', signal: r.signal ?? null, detail: spawnFailureDetail(r), out };
  }
  return { code: r.status, outcome: 'exited', signal: null, detail: null, out };
}

/**
 * The cannot-check message for a child that produced no exit status.
 *
 * Shared by its callers so the wording cannot drift between sites, and it
 * always carries the head of the child's output: a dyld failure prints its
 * reason there and nowhere else, so a message without it sends the next reader
 * off to reproduce what this run had already observed.
 */
function noStatusDetail(label, r) {
  const head = r.out.trim().split('\n').slice(0, 3).join(' | ') || '(no output)';
  return (
    `${label} — the child produced NO EXIT STATUS (${r.outcome}: ${r.detail}). That is an ` +
    `ENVIRONMENT limitation, not a verdict about the guard, so it is declared rather than ` +
    `asserted against. First output: ${head}`
  );
}

// ---------------------------------------------------------------------------
// CONTROL — the guard reaches exit 0. Without this, every case below could pass
// against a guard that refuses everything.
// ---------------------------------------------------------------------------
{
  const dir = fixture({
    packages: { clean: { pkg: { name: 'clean', askturret: { testsNotRequired: 'a fixture' } } } },
  });
  const r = run(dir);
  check('CONTROL: a declared-exempt package with no test files passes', r.code, 0);
  check('CONTROL: ...and the run says what it examined', /1 package\(s\)/.test(r.out), true);
}

// ---------------------------------------------------------------------------
// THESE RUN BEFORE THE RELOCATION SITE, AND THAT ORDER IS LOAD-BEARING (#581).
//
// Measured while writing them: spawning the RELOCATED interpreter poisons the
// NEXT spawn of the REAL one in this process. Isolated by varying one factor at
// a time — with only PATH changed the following control passes; with only the
// interpreter changed it dies with SIGABRT and a dyld error naming the TEMP
// path, from a child launched at the interpreter's real location:
//
//   only PATH varied:        control / relocated / control  ->  0 / 0 / 0
//   only interpreter varied: control / relocated / control  ->  0 / 0 / SIGABRT
//
// THE HAZARD IS MEASURED GONE, AND THIS COMMENT STAYS ANYWAY (#674).
//
// The relocation was a HARDLINK when the above was measured, so the temp name
// and the real binary were the SAME INODE. #674 changed it to a COPY and gave
// the child `DYLD_LIBRARY_PATH`, and the ordering effect goes to 0/30 on this
// host — see the header table.
//
// It goes away ONLY in the copy variant. Repairing the library lookup alone,
// leaving the hardlink, takes it from 0/30 to 8/30: the effect tracks the
// INODE, not the library path. So the comment is retained with its claim
// updated rather than deleted. The hazard is measured absent on this host in
// this harness, which is not the same as impossible, the comment costs nothing,
// and this file has already been burned once by an author adding a spawning
// case in the wrong place.
//
// So: still do not move these below the site, and still think twice before
// adding a spawning case there — but the reason is now precaution rather than a
// live failure.
//
// THE EPISTEMIC SPLIT IS UNCHANGED. What is MEASURED is the ordering effect and
// its disappearance. That dyld caches loader state per inode, and retains the
// temp directory as the `@rpath` base, remains INFERRED — the hardlink-versus-
// copy comparison at a constant success rate (30/30 both ways) supports the
// inference more directly than anything previously available, and it is still
// not promoted to a read fact.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// run()'s THREE OUTCOMES, WITNESSED DIRECTLY (#581).
//
// The failure that motivated this is a ~5% intermittent driven by dyld state,
// which is no basis for a regression test: a suite that can only observe the
// distinction when a flake happens to fire is a suite that does not observe it.
// These drive the two no-status branches DELIBERATELY instead, and they are
// platform-independent in a way the dyld mechanism is not.
//
// Note what is asserted: that `run()` REPORTS the difference. Whether a
// relocated interpreter can resolve its libraries is a separate question, and
// deliberately not this diff's (#581 acceptance 4).
// ---------------------------------------------------------------------------
{
  // EXITED — the ordinary path. Without it the two below are satisfied by a
  // `run()` that reports every outcome as a failure.
  const dir = fixture({
    packages: { clean: { pkg: { name: 'clean', askturret: { testsNotRequired: 'a fixture' } } } },
  });
  const r = run(dir);
  check('run(): a child that exits normally reports outcome "exited"', r.outcome, 'exited');
  check('run(): ...and carries its status rather than null', r.code, 0);
  check('run(): ...and reports no failure detail', r.detail, null);
}

{
  // SPAWN-FAILED — an interpreter that does not exist. `error` is set, so this
  // must NOT be reported as a signal death.
  const dir = fixture({ packages: {} });
  const r = run(dir, { execPath: join(dir, 'no-such-interpreter') });
  check('run(): a spawn that never happens reports outcome "spawn-failed"', r.outcome, 'spawn-failed');
  check('run(): ...and still yields code null', r.code, null);
  check('run(): ...and names the spawn error rather than "(none reported)"', /ENOENT|EACCES|ENOTDIR/.test(r.detail), true);
}

{
  // KILLED-BY-SIGNAL — the row the old harness could not express, and the one
  // the reported intermittent actually was. A tiny executable that signals
  // itself gives a deterministic signal death with no `error` set.
  //
  // POSIX-only: `kill` and the shebang are both unavailable on Windows, so this
  // DECLARES rather than failing there — the same discipline the ladder below
  // uses, applied to this witness.
  if (process.platform === 'win32') {
    cannotCheck('run(): the killed-by-signal witness needs a POSIX shell and `kill`; not available on win32');
  } else {
    const dir = fixture({ packages: {} });
    const suicide = join(dir, 'self-terminate');
    writeFileSync(suicide, '#!/bin/sh\nkill -TERM $$\n');
    chmodSync(suicide, 0o755);

    const r = run(dir, { execPath: suicide });
    check('run(): a child killed by a signal reports outcome "killed-by-signal"', r.outcome, 'killed-by-signal');
    check('run(): ...and names the signal', r.signal, 'SIGTERM');
    check('run(): ...and says so in the detail rather than "(none reported)"', r.detail, 'killed by signal SIGTERM');
    // THE DISTINCTION ITSELF. Both rows yield `code: null`, so a harness that
    // returned only `status` reported them identically — the whole defect. This
    // pins that they are now separable.
    check('run(): ...and is NOT reported as a failed spawn', r.outcome === 'spawn-failed', false);
    check(
      'run(): the cannot-check message carries the outcome and the signal',
      /killed-by-signal: killed by signal SIGTERM/.test(noStatusDetail('x', r)),
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// SITE 1 (line 148) — an unsupported workspace pattern
// ---------------------------------------------------------------------------
{
  const dir = fixture({ workspaces: ['packages'], packages: {} });
  const r = run(dir);
  check('site: an unsupported workspace pattern exits 2', r.code, 2);
  check('site: ...and names the pattern it could not expand', /unsupported workspace pattern "packages"/.test(r.out), true);
}

// ---------------------------------------------------------------------------
// SITE 3 (line 504) — a package that executes no tests
// ---------------------------------------------------------------------------
{
  const dir = fixture({
    packages: { noop: { pkg: { name: 'noop', scripts: { test: 'exit 0' } } } },
  });
  const r = run(dir);
  check('site: a no-op test script exits 1', r.code, 1);
  check('site: ...and says a green job that ran nothing is worse than a red one', /do not execute any tests/.test(r.out), true);
  // The distinction this guard exists for: this is a COVERAGE failure, and must
  // not be reported as the environment failure below.
  check('site: ...and is NOT reported as unmeasurable', /COULD NOT BE CHECKED/.test(r.out), false);
}

// ---------------------------------------------------------------------------
// SITE 2 (line 494) — npm could not be run
//
// The site the cost note expected to need a seam. Reached by relocating the
// interpreter, per the header.
// ---------------------------------------------------------------------------
{
  const dir = fixture({
    packages: { real: { pkg: { name: 'real', scripts: { test: 'jest' } } } },
  });

  const binDir = mkdtempSync(join(tmpdir(), 'no-npm-bin-'));
  tmpDirs.push(binDir);
  const relocated = join(binDir, 'node');

  let rung = null;
  // null while the site has not run; the run()'s outcome once it has (#581).
  let siteOutcome = null;
  try {
    copyFileSync(process.execPath, relocated);
    rung = 'copy';
  } catch {
    rung = null;
  }

  // THE PRECONDITION THIS CASE RESTS ON, checked across EVERY directory the
  // guard will search (#531 re-QA).
  //
  // This check used to read `existsSync(join(binDir, 'npm'))` under the name
  // "so npm is unresolvable". It inspected ONE of the three directories and
  // claimed all of them. On a Linux runner with an apt/nodesource npm in
  // /usr/bin it passed while its own claim was false, npm started, and the
  // guard correctly took the no-tests branch instead — so the case failed and
  // the failure read as a guard defect. It was not: the name asserted three
  // times more than the check verified, which is the decorative class swept
  // five times on #540 and twice more on #541, here guarding the precondition
  // the whole case rests on.
  //
  // `/usr/bin` and `/bin` are appended UNCONDITIONALLY by the guard — my own
  // #429 PATH repair — so no fixture can remove them. The relocation trick
  // therefore works only where npm is absent from BOTH, which is true on macOS
  // (/opt/homebrew/bin) and false on many Linux images.
  // Deduped: `dirname(relocated)` IS `binDir` here, and a diagnostic that names
  // the same directory twice reads as a defect in the diagnostic.
  const childPathDirs = [...new Set([dirname(relocated), binDir, '/usr/bin', '/bin'])];
  const npmFoundIn = childPathDirs.filter((d) => existsSync(join(d, 'npm')));

  // The list above MIRRORS the guard's CHILD_PATH and cannot import it, because
  // importing a wired production script executes it. So pin the mirror: if the
  // guard's fallbacks ever change, this precondition silently goes wrong again
  // in exactly the way being fixed here.
  const guardSource = readFileSync(GUARD, 'utf-8');
  check(
    'site: the fallback list this fixture mirrors is still the guard\'s own',
    guardSource.includes("[dirname(process.execPath), process.env.PATH ?? '', '/usr/bin', '/bin']"),
    true,
  );

  if (rung === null || !existsSync(relocated)) {
    // CANNOT CHECK, said out loud. A case that quietly does not run is the
    // empty pass this repository has spent the week removing.
    cannotCheck(
      'site: npm-cannot-start is unwitnessed here — the interpreter could not be ' +
        'relocated (the copy failed), so `dirname(process.execPath)` could not be ' +
        'made npm-free. The site is reachable; this ENVIRONMENT could not reach it.',
    );
  } else if (npmFoundIn.length > 0) {
    // THE LADDER'S THIRD RUNG, reached for a second reason. Nothing about the
    // guard is in question and no expectation is weakened: the site is
    // reachable, and this HOST cannot reach it because npm sits in a directory
    // the guard always searches.
    cannotCheck(
      `site: npm-cannot-start is unwitnessed here — npm is present in ` +
        `${npmFoundIn.join(', ')}, which the guard appends to the child PATH unconditionally, so ` +
        `no fixture can make npm unresolvable on this host. The site is reachable; this ` +
        `ENVIRONMENT cannot reach it.`,
    );
  } else {
    check(
      `site: the interpreter relocated via ${rung}, and npm is in none of ${childPathDirs.join(', ')}`,
      npmFoundIn.length,
      0,
    );
    // THE COPIED INTERPRETER CANNOT FIND ITS OWN LIBRARY WITHOUT THIS (#674).
    // Homebrew's node reaches `libnode` through `@rpath`, which resolves
    // relative to the binary — so from a temp directory it finds nothing and
    // dyld kills the child before the guard is ever consulted. Derived, never
    // hardcoded: the `lib` beside the `bin` that `execPath` names.
    //
    // Set only when it exists. Pointing dyld at a directory that is not there
    // buys nothing and would put a bogus path in the child's environment on any
    // layout that does not match this one.
    const libDir = join(dirname(dirname(process.execPath)), 'lib');
    const childEnv = { PATH: binDir };
    if (existsSync(libDir)) childEnv.DYLD_LIBRARY_PATH = libDir;

    const r = run(dir, { execPath: relocated, env: childEnv });
    siteOutcome = r.outcome;

    if (r.outcome !== 'exited') {
      // THE LADDER'S FOURTH RUNG (#581). The interpreter relocated, so the two
      // rungs above did not fire — but the child then produced no exit status.
      // On this host the observed cause is dyld killing it with SIGABRT:
      // Homebrew's node reaches libnode through `@rpath`, which resolves
      // relative to the binary and so finds nothing from a temp directory.
      //
      // Declared rather than asserted, for the reason this site exists at all:
      // the guard was never consulted, so "expected 2, got null" would report a
      // defect in the thing being measured when the measurement never happened.
      // That is the #429 misattribution, committed by the file built to prevent
      // it — and the empty output made the NEXT assertion fail too, so one
      // environmental event wore the signature of two guard defects.
      //
      // It does NOT pass silently: the count is reconciled below, so a host
      // that takes this rung says so in the summary.
      cannotCheck(
        noStatusDetail(
          `site: npm-cannot-start is unwitnessed here — the interpreter relocated via ${rung}, ` +
            'but the relocated child could not run',
          r,
        ),
      );
    } else {
      // LIBRARY RESOLUTION, DEMONSTRATED RATHER THAN ASSUMED (#674).
      //
      // The site above is ONE spawn, and one spawn cannot tell a repair from
      // luck: before this change the relocated child ran 10 times in 30 cold
      // trials, so a single green run had a one-in-three chance of proving
      // nothing. This loop spawns the relocated interpreter directly — no
      // guard, no fixture, just "can it start" — enough times that the old
      // behaviour could not have survived it.
      //
      // SIZED AGAINST A MEASUREMENT, AND THE MEASUREMENT CORRECTED A GUESS.
      //
      // Cold — a fresh process whose first spawn is the relocated binary —
      // measured 67% failure here; the issue reports 72%, the Architect 83%.
      //
      // But THIS SITE IS NOT COLD. Every case above has already spawned the
      // real interpreter, so dyld is warm by the time it runs. Measured against
      // the OLD relocation in exactly that state, 15 suite-equivalent runs:
      //
      //   the single site spawn   passed 15/15   <- no detector at all
      //   a 20-spawn loop         caught 15/15   <- only 1 to 4 of 20 ran
      //
      // So the warm rate is not the ~5% the issue quotes. After the FIRST
      // relocated spawn — which tends to succeed, the real binary's inode being
      // warm — the rest fail nearly always. That is how the site could pass 15
      // times running while the interpreter it spawns was broken, and it is why
      // this is a loop rather than one more single assertion.
      //
      // These spawns are the relocated interpreter, so they sit AFTER the site
      // and are subject to the ordering note above — which is now measured
      // clean for this configuration, and is the property being demonstrated.
      const LIBRARY_TRIALS = 20;
      const started = Array.from({ length: LIBRARY_TRIALS }, () =>
        spawnSync(relocated, ['-e', "process.stdout.write('OK')"], { encoding: 'utf-8', env: { ...process.env, ...childEnv } }),
      ).filter((t) => !t.error && t.status === 0 && t.stdout === 'OK').length;

      check(
        `site: the relocated interpreter resolves its libraries on all ${LIBRARY_TRIALS} spawns (#674)`,
        started,
        LIBRARY_TRIALS,
      );

      // AND THE REAL INTERPRETER STILL WORKS AFTERWARDS. The hazard this change
      // removes is not the site failing — it is the site's spawn breaking the
      // NEXT one. Asserted here rather than left to the ordering comment,
      // because a comment cannot notice a regression.
      const afterReal = spawnSync(process.execPath, ['-e', "process.stdout.write('OK')"], { encoding: 'utf-8' });
      check(
        'site: ...and the REAL interpreter still spawns cleanly afterwards',
        !afterReal.error && afterReal.status === 0 && afterReal.stdout === 'OK',
        true,
      );

      check('site: npm that cannot start exits 2', r.code, 2);
      check('site: ...and says it COULD NOT BE CHECKED', /COULD NOT BE CHECKED/.test(r.out), true);
      // THE DISTINCTION THIS SITE EXISTS FOR (#429): a measurement that could not
      // be taken must not be reported as a defect in the thing being measured.
      check(
        'site: ...and does NOT report it as a package that runs no tests',
        /do not execute any tests/.test(r.out),
        false,
      );
    }
  }

  // THE COUNTER IS RECONCILED AGAINST THE BRANCH ACTUALLY TAKEN (#561).
  //
  // Runs on EVERY host, and is the assertion that makes the new figure a
  // measurement rather than decoration: it recomputes, from the same conditions
  // the branches above test, whether this host skipped — and requires the
  // counter to agree. If `cannotCheck` ever announces without incrementing, the
  // two disagree and this reddens. A skip host expects 1, a full host expects 0,
  // so neither is a hard-coded figure that goes stale on the other.
  //
  // It reconciles the COUNT against the BRANCH; it does not re-implement the
  // counting. That distinction is what keeps it off the Transcribed-Oracle list.
  //
  // #581 ADDS A FOURTH CONDITION, and it differs in kind from the other three:
  // they are all knowable BEFORE the site runs, whereas "the child produced no
  // exit status" is only knowable AFTER. Hence `siteOutcome` — null when the
  // site never ran, and the outcome when it did. This still recomputes from the
  // branch actually taken rather than counting the announcements, so it remains
  // a reconciliation and not a transcription.
  const expectedCannotChecks =
    rung === null ||
    !existsSync(relocated) ||
    npmFoundIn.length > 0 ||
    (siteOutcome !== null && siteOutcome !== 'exited')
      ? 1
      : 0;
  check(
    'summary: the cannot-check figure matches the branch this host actually took',
    cannotChecked,
    expectedCannotChecks,
  );
}

// THE SUMMARY'S OWN SHAPE, pinned on explicit inputs (#561).
//
// Asserted through the same function the real summary is printed with, so these
// cannot drift apart. Two cases rather than one: the first pins that a skip is
// carried into the summary at all, the second that a clean run still names the
// category instead of dropping it — which is the ambiguity being removed, since
// a reader cannot otherwise tell "nothing skipped" from "skips not reported".
check(
  'summary: a skip is carried into the summary as its own category',
  summaryLine(8, 0, 1),
  '8 passed, 0 failed, 1 cannot-check',
);
check(
  'summary: ...and a clean run still names the category rather than dropping it',
  summaryLine(12, 0, 0),
  '12 passed, 0 failed, 0 cannot-check',
);

// ---------------------------------------------------------------------------
// THE VERDICT (#679). The summary tests above pin the STRING this run prints;
// these pin the CODE it returns, which is the property PR #673's discharge of
// #576's full-tree obligation actually rests on.
//
// The realistic inverting edit is `f === 0 && c === 0` — #434's fail-closed
// direction applied here. Every `c` below is non-zero for exactly that reason:
// a truth table whose cannot-check column were always 0 would survive that
// mutation unchanged and pin nothing.
// ---------------------------------------------------------------------------
check('verdict: a clean run exits 0', exitCodeFor(0, 0), 0);
check('verdict: a cannot-check ALONE does not gate', exitCodeFor(0, 1), 0);
check('verdict: ...nor do eighteen of them, the largest run observed', exitCodeFor(0, 18), 0);
check('verdict: a failure gates', exitCodeFor(1, 0), 1);
check('verdict: ...and still gates when cannot-checks are also present', exitCodeFor(1, 5), 1);

// THE BYPASS, which the truth table alone does NOT cover (#761 clause 2).
//
// Asserting `exitCodeFor` proves the FUNCTION is right. It says nothing about
// whether the process consults it — an edit that inlines
// `process.exit(failed === 0 && cannotChecked === 0 ? 0 : 1)` leaves every
// assertion above green while inverting the property they exist to protect.
// So the exit site is read from this file's own source and pinned by shape.
//
// ANCHORED AT LINE START, and that is load-bearing rather than tidiness: the
// real exit is the only statement in this file beginning at column 0 with
// `process.exit(`. A pattern that scanned anywhere would match the specimen
// inside the comment directly above — and with `[^;]*` spanning newlines it ran
// on to the next statement, reporting two exit sites where there is one. Caught
// by writing the assertion and reading what it actually matched.
{
  const selfSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const calls = [...selfSource.matchAll(/^process\.exit\((.*)\);\s*$/gm)];
  check('verdict: the file has exactly one exit site to pin', calls.length, 1);
  check(
    'verdict: ...and the process exit is DRIVEN BY exitCodeFor, not an inline expression',
    calls.at(-1)?.[1].replace(/\s+/g, ' ').trim(),
    'exitCodeFor(failed, cannotChecked)',
  );
}

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

console.log(`\n${summaryLine(passed, failed, cannotChecked)}`);
// UNCHANGED, deliberately: a skip must still exit 0. `cannotChecked` is
// reported, never gating. See the note on `cannotCheck` above.
//
// NOW ASSERTED, NOT MERELY STATED (#679). The rule this comment describes lives
// in `exitCodeFor`, whose truth table above pins it — including that a
// cannot-check does not gate at 1 and at 18 — and a companion assertion pins
// THIS LINE to that function, so inlining the decision here reddens too. A
// comment and a test that agree are much harder to drift apart than a comment
// alone; changing the rule now means changing both, knowingly.
process.exit(exitCodeFor(failed, cannotChecked));
