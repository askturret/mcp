#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Prove the INTEGRATED TREE — every package suite against main's tip (#687).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, which is not "run the tests again"
 * ---------------------------------------------------------------------------
 *
 * `test.yml` used to run on `push: main` as well as on `pull_request`. Change 3
 * of #687 dropped that trigger, because it doubled the run count on a strictly
 * serial single runner — eleven merges in four minutes on 2026-09-05, two of
 * the resulting main-push runs still queued 47 minutes later, in front of live
 * PR work.
 *
 * But that run was NOT a repeat, and the issue's own framing that it was is the
 * part the Architect corrected. A pre-merge run proves THE PR'S TREE. The
 * squashed commit is that PR merged into whatever `main` had become BY MERGE
 * TIME, and main moves constantly. So what the post-merge run uniquely proved
 * is the INTEGRATED TREE — a tree no pull-request run ever saw. The failure it
 * caught is the semantic conflict: two pull requests each green alone, broken
 * together.
 *
 * Nothing else in this repository catches that. There are no required status
 * checks (#647), so there is no up-to-date-before-merge requirement either.
 * Dropping `push: main` without a replacement would therefore have removed the
 * only assertion over the integrated tree — trading away a real check to save
 * runner time, which is the one outcome the founder ruled out.
 *
 * This script is the replacement. It runs on `reliability-nightly.yml`'s
 * existing 03:00 UTC cron, whose own comment already describes that moment as
 * "after the day's merges have landed" — precisely the population that would
 * otherwise go unverified.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP THIS IS WRITTEN TO AVOID — read before "simplifying" it
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation is to reuse `test.yml`'s `changes` job. DO NOT.
 * That job is a `dorny/paths-filter` over a pull request's diff. On a schedule
 * there is no diff, so it trips no filter, schedules ZERO suites, and the run
 * REPORTS GREEN HAVING RUN NOTHING — a constant wearing a verdict, which is the
 * ADR-024 shape, arriving in the one place that has no second observer.
 *
 * So this script does not consult the path filters at all. It cannot: there is
 * no filter in its reach, by construction rather than by discipline. It runs
 * every suite, every night.
 *
 * A weaker version of the same trap is a discovery step that silently finds
 * nothing — an empty scan passes for the same reason an empty filter does.
 * `discoverSuites` therefore refuses an empty result rather than returning it,
 * and the verdict below refuses a set that disagrees with `test.yml`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SUITE LIST IS DERIVED TWICE AND CROSS-CHECKED
 * ---------------------------------------------------------------------------
 *
 * A hardcoded list of twelve packages would be correct today and wrong the
 * first time someone adds a thirteenth — and wrong SILENTLY, because a nightly
 * that runs eleven of twelve suites is green. That is the same hand-maintained
 * set with no checkable member list that #601 and #427 each paid for.
 *
 * So the set is derived from each `packages/<dir>/package.json` (those
 * declaring a `test` script) AND from the `test-<key>` job names in
 * `test.yml`, and the two
 * must agree EXACTLY. Either direction disagreeing is a refusal, not a warning:
 *
 *   - a package with tests and no `test-<key>` job means the PR matrix does not
 *     cover it, which is a real gap this nightly should not paper over;
 *   - a `test-<key>` job with no such package means the matrix schedules a
 *     suite this nightly would not run, so "all suites" would be a false claim.
 *
 * The mapping is total by construction — `test-adapter-conformance` is
 * `packages/adapter-conformance`, and so on for all twelve — so the cross-check
 * needs no translation table to go stale.
 *
 * ---------------------------------------------------------------------------
 * EXIT CODES: 0 all suites ran and passed, 1 a suite ran and failed,
 *             2 something could not be run or determined.
 * ---------------------------------------------------------------------------
 *
 * `2` is not a lesser `1`. This script is the SOLE proof for the integrated
 * tree, so "I could not check" resolving as "it passed" is the worst failure
 * available here — worse than a red, which at least gets looked at. Same
 * reasoning as check-runners.mjs and check-audit-append-only.mjs, and the same
 * precedence: a suite that could not be RUN yields 2 even when another suite
 * genuinely failed. An unrunnable suite undermines the whole verdict rather
 * than one line of it.
 *
 * The spawn-failure arm is not hypothetical. #371 found `sdk-upgrade-drill.mjs`
 * reading a build that never STARTED — `status === null` — as "not a failure",
 * and reporting PASS from a compiler that never ran. `status === null` is
 * cannot-run here, always.
 *
 * ---------------------------------------------------------------------------
 * THE SHA IS NAMED IN EVERY VERDICT, pass or fail.
 * ---------------------------------------------------------------------------
 *
 * "main is broken" is not actionable when a dozen commits landed that day, and
 * a nightly is read the following morning by someone who did not merge any of
 * them. The commit under test is printed in the header and repeated in the
 * failure summary, so it survives a truncated log read from either end.
 *
 * Deliberately uses only Node builtins, so it needs no install of its own to be
 * trustworthy — the same reasoning every guard in this directory gives.
 *
 * Run: node .github/scripts/nightly-integrated-tree.mjs [repoRoot]
 */

import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Thrown for every "could not check" condition, so exit 2 has one source. */
export class CannotCheck extends Error {}

const cannotCheck = (msg) => {
  throw new CannotCheck(msg);
};

/**
 * `test-<key>` jobs in test.yml that are NOT a package suite.
 *
 * `test-integrity` is the repo-integrity job — every guard in `.github/scripts`
 * runs there, it gates on no path filter, and there is no `packages/integrity`
 * for it to correspond to.
 *
 * Named explicitly rather than inferred from "does `packages/<key>` exist",
 * because those two rules disagree in exactly the case that matters. Inference
 * would silently drop a `test-<key>` job whose package was deleted or renamed —
 * the matrix would go on scheduling a suite this runner had quietly stopped
 * expecting, and "every suite" would become false with nothing saying so. With
 * an explicit set, a new non-package `test-*` job instead surfaces as a refusal
 * naming it, and someone decides. Loud beats convenient here.
 */
const NON_PACKAGE_TEST_JOBS = Object.freeze(new Set(['integrity']));

/**
 * Packages under `packages/` that declare a `test` script and are expected to
 * have one.
 *
 * `askturret.testsNotRequired` is honoured because it is this repository's
 * EXISTING, reviewed vocabulary for "this package legitimately has nothing to
 * test" — `check-test-execution.mjs` already reads it, and a package carrying
 * it must justify itself in prose. Inventing a second exemption mechanism here
 * would give two places to state the same fact and one of them would go stale.
 * `packages/examples` is the live case: an aggregator whose `test` script is
 * literally `exit 0`, which would otherwise be counted as a suite that passed.
 *
 * Refuses an empty result: a discovery step that finds nothing is
 * indistinguishable, in a green log, from one that found everything passing.
 */
export function discoverSuites(repoRoot, fs = { readdirSync, readFileSync, statSync, existsSync }) {
  const dir = join(repoRoot, 'packages');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    cannotCheck(`cannot read ${dir}: ${err.message}`);
  }

  const suites = [];
  for (const name of entries.sort()) {
    const manifest = join(dir, name, 'package.json');
    if (!fs.existsSync(manifest)) continue;

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    } catch (err) {
      // A manifest that cannot be parsed is not "a package without tests".
      cannotCheck(`cannot parse ${manifest}: ${err.message}`);
    }
    if (pkg?.askturret?.testsNotRequired) continue;
    if (pkg?.scripts?.test) suites.push(name);
  }

  if (suites.length === 0) {
    cannotCheck(
      `no package under ${dir} declares a \`test\` script — refusing to report a pass over an ` +
        'empty suite set',
    );
  }
  return suites;
}

/**
 * The `test-<key>` job names declared by `test.yml`.
 *
 * Matches job keys at exactly two spaces of indentation, which is what a job
 * key is in this file; a deeper `test-` line belongs to a step and is not a
 * job. Refuses an empty result for the same reason `discoverSuites` does.
 */
export function declaredSuiteJobs(repoRoot, fs = { readFileSync }) {
  const path = join(repoRoot, '.github', 'workflows', 'test.yml');
  let text;
  try {
    text = fs.readFileSync(path, 'utf-8');
  } catch (err) {
    cannotCheck(`cannot read ${path}: ${err.message}`);
  }

  const jobs = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '');
    const m = line.match(/^ {2}test-([a-z0-9-]+):\s*$/);
    if (m && !NON_PACKAGE_TEST_JOBS.has(m[1])) jobs.push(m[1]);
  }

  if (jobs.length === 0) {
    cannotCheck(
      `${path} declares no \`test-<key>\` jobs — either the file moved or this parser no longer ` +
        'understands it; refusing to report a pass either way',
    );
  }
  return jobs.sort();
}

/** Symmetric difference, so a refusal can name what is missing on each side. */
function disagreement(discovered, declared) {
  const a = new Set(discovered);
  const b = new Set(declared);
  return {
    testedButNotScheduled: discovered.filter((s) => !b.has(s)),
    scheduledButNotTested: declared.filter((s) => !a.has(s)),
  };
}

/**
 * The default suite runner. Split out so the self-test can drive every verdict
 * without spawning npm — including the arms that are hard to provoke for real.
 */
export function runSuiteWithNpm(repoRoot, pkg, spawn = spawnSync) {
  const r = spawn('npm', ['test', `--workspace=packages/${pkg}`], {
    cwd: repoRoot,
    stdio: 'inherit',
    // npm is a shell script on Windows runners; this pool is Linux-only
    // (check-runners.mjs enforces that), so no shell is needed or wanted.
    shell: false,
  });

  // #371: a process that never STARTED reports status null, and `status !== 0`
  // reads that as a failure while `status === 0` reads it as a pass. Neither is
  // true — it is cannot-run, and it is the arm that produced a PASS from a
  // compiler that never ran.
  if (r.error) return { outcome: 'cannot-run', detail: r.error.message };
  if (r.status === null) {
    return {
      outcome: 'cannot-run',
      detail: r.signal ? `terminated by signal ${r.signal}` : 'process did not start',
    };
  }
  return r.status === 0 ? { outcome: 'pass' } : { outcome: 'fail', detail: `exit ${r.status}` };
}

/**
 * Resolve the commit under test.
 *
 * `GITHUB_SHA` is what Actions sets and is preferred; `git rev-parse` is the
 * local fallback. An unresolvable SHA is cannot-check rather than "unknown",
 * because an unattributable verdict is the thing this is here to prevent.
 */
export function resolveSha({ env = process.env, repoRoot = '.', git = spawnSync } = {}) {
  const fromEnv = env.GITHUB_SHA?.trim();
  if (fromEnv) return fromEnv;

  const r = git('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' });
  const out = r?.stdout?.trim();
  if (r?.error || r?.status !== 0 || !out) {
    cannotCheck(
      'cannot determine the commit under test: GITHUB_SHA is unset and `git rev-parse HEAD` ' +
        `did not answer (${r?.error?.message ?? `exit ${r?.status}`})`,
    );
  }
  return out;
}

/**
 * Run every discovered suite and return a structured verdict.
 *
 * Every collaborator is injectable so the self-test can reach all three exits.
 */
export function runIntegratedTree({
  repoRoot,
  sha,
  discover = () => discoverSuites(repoRoot),
  declared = () => declaredSuiteJobs(repoRoot),
  runSuite = (pkg) => runSuiteWithNpm(repoRoot, pkg),
}) {
  const discovered = discover();
  const declaredJobs = declared();

  const diff = disagreement(discovered, declaredJobs);
  if (diff.testedButNotScheduled.length > 0 || diff.scheduledButNotTested.length > 0) {
    cannotCheck(
      'the suite set derived from packages/ disagrees with the `test-<key>` jobs in test.yml, so ' +
        '"every suite" cannot be asserted:' +
        (diff.testedButNotScheduled.length
          ? `\n  has tests, no test-<key> job: ${diff.testedButNotScheduled.join(', ')}`
          : '') +
        (diff.scheduledButNotTested.length
          ? `\n  test-<key> job, no package tests: ${diff.scheduledButNotTested.join(', ')}`
          : ''),
    );
  }

  const results = [];
  for (const pkg of discovered) {
    console.log(`\n=== ${pkg} — integrated tree at ${sha} ===`);
    results.push({ pkg, ...runSuite(pkg) });
  }

  const failed = results.filter((r) => r.outcome === 'fail');
  const unrunnable = results.filter((r) => r.outcome === 'cannot-run');

  return { sha, suites: discovered, results, failed, unrunnable };
}

/** One-line-per-suite summary; the SHA is repeated so a tail-read still has it. */
export function report(verdict) {
  const lines = [
    '',
    '--------------------------------------------------------------------',
    `Integrated tree: ${verdict.sha}`,
    `Suites run: ${verdict.results.length} of ${verdict.suites.length}`,
  ];
  for (const r of verdict.results) {
    const mark = r.outcome === 'pass' ? 'PASS' : r.outcome === 'fail' ? 'FAIL' : 'CANNOT RUN';
    lines.push(`  ${mark.padEnd(10)} ${r.pkg}${r.detail ? ` (${r.detail})` : ''}`);
  }
  return lines.join('\n');
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const repoRoot = resolve(process.argv[2] ?? '.');

  try {
    const sha = resolveSha({ repoRoot });
    console.log(`Integrated-tree run — every package suite against ${sha}`);
    console.log('Path filters are not consulted: this run has none in reach (#687).');

    const verdict = runIntegratedTree({ repoRoot, sha });
    console.log(report(verdict));

    if (verdict.unrunnable.length > 0) {
      console.error(
        `\nCANNOT CHECK the integrated tree at ${sha}: ` +
          `${verdict.unrunnable.map((r) => r.pkg).join(', ')} could not be run. ` +
          'This is NOT a pass and NOT a plain failure — the verdict is undetermined.',
      );
      process.exit(2);
    }

    if (verdict.failed.length > 0) {
      console.error(
        `\nINTEGRATED TREE IS BROKEN at ${sha}: ` +
          `${verdict.failed.map((r) => r.pkg).join(', ')} failed.\n` +
          'Each of these suites passed on its own pull request. Two changes that were green ' +
          'alone are broken together, which is exactly the failure this run exists to catch. ' +
          `Bisect from ${sha}.`,
      );
      process.exit(1);
    }

    console.log(`\nIntegrated tree OK at ${sha} — ${verdict.suites.length} suites ran and passed.`);
  } catch (err) {
    if (err instanceof CannotCheck) {
      console.error(`\nCANNOT CHECK: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}
