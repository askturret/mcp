#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the collapsed coverage signal (#110).
 *
 * This script replaced 13 wrapper jobs that fed a merge gate. The whole point of
 * the collapse is that one job now answers a question 13 jobs used to, so the
 * negative cases below are the substance: each asserts a specific way the signal
 * must refuse.
 *
 * Two of them are the reason this rewrite is not a pure refactor. The wrappers
 * reported SUCCESS when the `changes` job failed, and would report success for an
 * empty requirement set. Both are false passes, and both are asserted here.
 *
 * The parity block at the end is the important one for review: it re-implements
 * nothing, it drives the SAME table of packages this repo really has and checks
 * the new signal agrees with the old wrapper rule on every reachable input.
 *
 * Run: node .github/scripts/ci-coverage-status.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate, report } from './ci-coverage-status.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const WORKFLOW = join(repoRoot, '.github/workflows/test.yml');

let passed = 0;
let failed = 0;

function check_(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(
      `FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
    failed++;
  }
}

/** Build a `needs` context. `results` maps a test job to its conclusion. */
function needs({ changesResult = 'success', outputs = {}, results = {} }) {
  const n = { changes: { result: changesResult, outputs } };
  for (const [job, result] of Object.entries(results)) n[job] = { result };
  return n;
}

// ---------------------------------------------------------------------------
console.log('\n# the contract the wrappers implemented\n');
// ---------------------------------------------------------------------------

{
  // Implicated and passed.
  const o = evaluate(
    needs({ outputs: { core: 'true', cli: 'false', workspace: 'false' }, results: { 'test-core': 'success', 'test-cli': 'skipped' } }),
  );
  check_('a changed package that passed is covered', o.ok, true);
  check_('...and the untouched one is reported as not implicated', o.rows.find((r) => r.job === 'test-cli').verdict, 'not implicated');
}

{
  // Implicated and failed.
  const o = evaluate(
    needs({ outputs: { core: 'true', workspace: 'false' }, results: { 'test-core': 'failure' } }),
  );
  check_('a changed package whose tests FAILED is refused', o.ok, false);
}

{
  // Implicated but skipped — the case a coverage gate exists for.
  const o = evaluate(
    needs({ outputs: { core: 'true', workspace: 'false' }, results: { 'test-core': 'skipped' } }),
  );
  check_('a changed package whose tests SKIPPED is refused', o.ok, false);
  check_('...and says so in the reason', o.errors[0].includes("concluded 'skipped'"), true);
}

{
  // Not implicated — vacuously satisfied. This is why a green aggregate next to
  // a skipped test-core is correct on a cli-only PR.
  const o = evaluate(
    needs({ outputs: { core: 'false', cli: 'true', workspace: 'false' }, results: { 'test-core': 'skipped', 'test-cli': 'success' } }),
  );
  check_('an untouched package does not need to have run', o.ok, true);
}

{
  // workspace-wide implicates everything, which is what made the old
  // `workspace-status` job redundant.
  const o = evaluate(
    needs({
      outputs: { core: 'false', cli: 'false', workspace: 'true' },
      results: { 'test-core': 'success', 'test-cli': 'skipped' },
    }),
  );
  check_('a workspace-wide change implicates every package', o.ok, false);
  check_('...naming the workspace-wide reason, not a per-package one', o.errors[0].includes('workspace-wide change'), true);
}

// ---------------------------------------------------------------------------
console.log('\n# the two false passes this replaces\n');
// ---------------------------------------------------------------------------

{
  // The 2026-08-21 outage shape: `changes` never got a runner. Every wrapper
  // interpolated empty outputs, took its "not implicated" branch, and went green.
  const o = evaluate(
    needs({ changesResult: 'failure', outputs: {}, results: { 'test-core': 'skipped', 'test-cli': 'skipped' } }),
  );
  check_('a failed `changes` job is refused, not read as "nothing implicated"', o.ok, false);
  check_('...and the reason names the missing filters', o.errors[0].includes('path filters are unavailable'), true);

  const cancelled = evaluate(needs({ changesResult: 'cancelled', outputs: {}, results: { 'test-core': 'skipped' } }));
  check_('a cancelled `changes` job is refused too', cancelled.ok, false);

  // The case above is refused by TWO independent rules: the `changes`-result
  // guard, and the undeclared-filter rule (empty outputs mean no key is
  // declared, so every job is assumed implicated). Good defence in depth, but it
  // means that case cannot tell the two apart. This one can: outputs are present
  // and say nothing is implicated, so ONLY the result guard can refuse it. If
  // that guard is ever removed, this is the assertion that goes red.
  const withOutputs = evaluate(
    needs({
      changesResult: 'failure',
      outputs: { core: 'false', cli: 'false', workspace: 'false' },
      results: { 'test-core': 'skipped', 'test-cli': 'skipped' },
    }),
  );
  check_('a failed `changes` job is refused even when its outputs look complete', withOutputs.ok, false);
}

{
  // An empty requirement set is satisfied by having no requirements.
  const o = evaluate(needs({ outputs: { core: 'true' }, results: {} }));
  check_('no test jobs at all is refused, not passed by vacuity', o.ok, false);
  check_('...and says the set was empty', o.errors[0].includes('No `test-*` jobs'), true);
}

{
  const o = evaluate({ 'test-core': { result: 'success' } });
  check_('a missing `changes` job is refused', o.ok, false);
}

// ---------------------------------------------------------------------------
console.log('\n# fail-closed on an undeclared filter\n');
// ---------------------------------------------------------------------------

{
  // A test job with no matching filter output must be assumed implicated. The
  // alternative — ignoring it — is a package that can never be required.
  const o = evaluate(
    needs({ outputs: { workspace: 'false' }, results: { 'test-newpkg': 'skipped' } }),
  );
  check_('a test job with no declared filter is assumed implicated', o.ok, false);
  check_('...and warns that the filter is missing', o.warnings.length, 1);

  const ok = evaluate(needs({ outputs: { workspace: 'false' }, results: { 'test-newpkg': 'success' } }));
  check_('...and is satisfied when it passes', ok.ok, true);
}

// ---------------------------------------------------------------------------
console.log('\n# parity with the wrapper rule, over this repo\'s real package list\n');
// ---------------------------------------------------------------------------

{
  // Read the packages straight out of the workflow so this cannot drift from
  // reality, then check the new signal against the OLD wrapper rule on every
  // reachable combination. The old rule is stated once, here, as the oracle —
  // it is the specification being preserved, not a copy of the new code.
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const testJobs = [...workflow.matchAll(/^  (test-[a-z-]+):$/gm)]
    .map((m) => m[1])
    .filter((j) => j !== 'test-integrity');

  check_('found the repo\'s test jobs in the workflow', testJobs.length > 5, true);

  const oldWrapperRule = (key, outputs, result) =>
    outputs[key] === 'true' || outputs.workspace === 'true' ? result === 'success' : true;

  let combos = 0;
  let disagreements = 0;

  for (const changed of testJobs) {
    for (const workspace of ['true', 'false']) {
      for (const result of ['success', 'failure', 'skipped', 'cancelled']) {
        const outputs = { workspace };
        for (const j of testJobs) outputs[j.slice('test-'.length)] = j === changed ? 'true' : 'false';

        const results = {};
        for (const j of testJobs) {
          // The changed package gets the result under test; everything else
          // behaves as the workflow's own `if:` would make it behave.
          results[j] = j === changed ? result : workspace === 'true' ? 'success' : 'skipped';
        }

        const expected = testJobs.every((j) =>
          oldWrapperRule(j.slice('test-'.length), outputs, results[j]),
        );
        const actual = evaluate(needs({ outputs, results })).ok;

        combos++;
        if (actual !== expected) {
          disagreements++;
          if (disagreements === 1) {
            console.log(`     first disagreement: changed=${changed} workspace=${workspace} result=${result}`);
          }
        }
      }
    }
  }

  check_(`agrees with the wrapper rule on all ${combos} reachable combinations`, disagreements, 0);
  check_('...and the sweep was not empty', combos > 50, true);
}

// ---------------------------------------------------------------------------
console.log('\n# every test job is actually wired into the aggregate\n');
// ---------------------------------------------------------------------------

{
  // The collapse's one new maintenance hazard: a package whose test job exists
  // but was never added to `coverage-status`'s `needs` is simply never required,
  // and nothing else would say so. With 13 wrapper jobs the omission was at
  // least visible as a missing job; here it is one absent list entry.
  const workflow = readFileSync(WORKFLOW, 'utf8');

  const testJobs = [...workflow.matchAll(/^  (test-[a-z-]+):$/gm)]
    .map((m) => m[1])
    .filter((j) => j !== 'test-integrity');

  const needsBlock = /^  coverage-status:$[\s\S]*?^    if:/m.exec(workflow)?.[0] ?? '';
  const wired = [...needsBlock.matchAll(/^      - (test-[a-z-]+)$/gm)].map((m) => m[1]);

  const unwired = testJobs.filter((j) => !wired.includes(j));
  const stale = wired.filter((j) => !testJobs.includes(j));

  check_('the coverage-status needs block was found', wired.length > 5, true);
  check_(
    `every path-filtered test job is in coverage-status needs${unwired.length ? ` (missing: ${unwired.join(', ')})` : ''}`,
    unwired.length,
    0,
  );
  check_(
    `coverage-status needs no job that no longer exists${stale.length ? ` (stale: ${stale.join(', ')})` : ''}`,
    stale.length,
    0,
  );
  check_('and the changes job is a dependency too', needsBlock.includes('- changes'), true);
}

// ---------------------------------------------------------------------------
console.log('\n# the report is legible\n');
// ---------------------------------------------------------------------------

{
  const o = evaluate(
    needs({ outputs: { core: 'true', cli: 'false', workspace: 'false' }, results: { 'test-core': 'success', 'test-cli': 'skipped' } }),
  );
  const text = report(o);
  check_('names every job it considered', text.includes('test-core') && text.includes('test-cli'), true);
  check_('distinguishes covered from not implicated', text.includes('covered') && text.includes('not implicated'), true);
  check_('counts what it decided', text.includes('1 covered, 1 not implicated, 2 total'), true);
}

// ---------------------------------------------------------------------------
console.log('\n# the script actually RUNS when invoked as CI invokes it\n');
// ---------------------------------------------------------------------------

{
  // Everything above imports `evaluate` directly, which passes happily even if
  // the entry block never executes. That is not hypothetical: the first version
  // of this script guarded its entry point with
  // `import.meta.url === \`file://${process.argv[1]}\``, which does not match
  // whenever the checkout path contains a character `import.meta.url`
  // percent-encodes. A path containing a space was enough — the module loaded,
  // the entry block was skipped, and the process exited 0 having evaluated
  // nothing. A coverage gate that exits 0 without running is the worst possible
  // failure, and no amount of unit-testing `evaluate` would have caught it.
  //
  // So these cases run the real file as a subprocess and assert on its exit code.
  const script = join(here, 'ci-coverage-status.mjs');

  const run = (env) =>
    spawnSync(process.execPath, [script], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });

  const failing = run({
    NEEDS_JSON: JSON.stringify({
      changes: { result: 'success', outputs: { cli: 'true', workspace: 'false' } },
      'test-cli': { result: 'failure' },
    }),
  });
  check_('a failing payload exits non-zero through the real entry point', failing.status, 1);
  check_('...and prints the reason', failing.stdout.includes('REQUIRED BUT NOT COVERED'), true);

  const passing = run({
    NEEDS_JSON: JSON.stringify({
      changes: { result: 'success', outputs: { cli: 'true', workspace: 'false' } },
      'test-cli': { result: 'success' },
    }),
  });
  check_('a passing payload exits zero through the real entry point', passing.status, 0);
  check_('...and says so rather than staying silent', passing.stdout.includes('Coverage signal: OK'), true);

  // The specific regression: no output at all means the entry block did not run.
  check_('the entry point is never silent', passing.stdout.trim().length > 0, true);

  const noEnv = run({ NEEDS_JSON: '' });
  check_('a missing NEEDS_JSON refuses rather than passing by default', noEnv.status, 1);

  const badJson = run({ NEEDS_JSON: '{not json' });
  check_('unparseable NEEDS_JSON refuses', badJson.status, 1);
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
