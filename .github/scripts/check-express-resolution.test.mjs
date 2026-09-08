#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the #705 Express resolution guard.
 *
 * This guard is the only thing standing between "the leg is named express-5"
 * and "the leg tested express 5", so a guard that silently stopped working
 * would restore exactly the false-coverage state the matrix was built to end.
 * Every branch is driven here against hermetic fixture trees:
 *
 *   - the expected major resolves            -> passes (both legs)
 *   - a DIFFERENT major resolves             -> fails (the #585 trap it exists for)
 *   - the inverse drift (leg 4 gets 5)       -> fails (the assertion is symmetric)
 *   - express not installed at all           -> exit 2, never a silent pass
 *   - the major is not a declared peer       -> fails (instrument vs. claim)
 *   - a peer range it cannot parse           -> exit 2, NOT "no majors, so fine"
 *   - missing manifest / bad or absent arg   -> exit 2
 *
 * The fourth and sixth cases are the ones worth keeping. A guard that reported
 * success when it found nothing to check would pass every one of them while
 * measuring nothing — the decorative-guard shape docs/TESTING.md names.
 *
 * The fixtures are plain directories, so unlike several guards here this test
 * needs no `git` and runs anywhere node does.
 *
 * Run: node .github/scripts/check-express-resolution.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-express-resolution.mjs');

const PEER_BOTH = '^4.18.0 || ^5.0.0';

let passed = 0;
let failed = 0;

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed++;
  }
}

/**
 * A throwaway workspace containing `packages/adapters-express`, optionally with
 * a nested express installed. `express: null` means "not installed anywhere",
 * which is what an install step that silently did nothing leaves behind.
 */
function fixture({ express = null, peer = PEER_BOTH, manifest = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'express-resolution-'));
  const adapter = join(dir, 'packages', 'adapters-express');
  mkdirSync(adapter, { recursive: true });

  if (manifest) {
    const pkg = { name: '@askturret/mcp-adapters-express', version: '0.0.0' };
    if (peer !== null) pkg.peerDependencies = { express: peer };
    writeFileSync(join(adapter, 'package.json'), JSON.stringify(pkg));
  }

  if (express !== null) {
    const nested = join(adapter, 'node_modules', 'express');
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, 'package.json'),
      JSON.stringify({ name: 'express', version: express, main: 'index.js' }),
    );
    writeFileSync(join(nested, 'index.js'), 'module.exports = {};');
  }

  return dir;
}

function runGuard(args) {
  return spawnSync(process.execPath, [GUARD, ...args], { encoding: 'utf8' });
}

/**
 * A fixture carrying a `.github/workflows/test.yml` whose express matrix has
 * exactly the given legs. `legs: null` writes no workflow at all, which is the
 * cannot-check case.
 *
 * Written as real YAML rather than assembled from the repository's own file:
 * a fixture derived from the thing under test would pass whatever that file
 * said, which is the shape these tests exist to refuse.
 */
function matrixFixture({ peer = PEER_BOTH, legs = ['5', '4'], job = 'test-adapters-express' } = {}) {
  const dir = withFixture({ peer });
  if (legs === null) return dir;
  const include = legs
    .map((l) => (l === null ? '          - install: no-express-key\n' : `          - express: '${l}'\n`))
    .join('');
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(dir, '.github', 'workflows', 'test.yml'),
    `name: t\non: push\njobs:\n  ${job}:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        include:\n${include || '          []\n'}    steps:\n      - run: echo hi\n`,
  );
  return dir;
}

const dirs = [];
function withFixture(opts) {
  const dir = fixture(opts);
  dirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
console.log('\n# the expected major resolves — both legs\n');
// ---------------------------------------------------------------------------

check(
  'express 4 installed, express-4 leg passes',
  runGuard(['4', withFixture({ express: '4.22.2' })]).status,
  0,
);

check(
  'express 5 installed, express-5 leg passes',
  runGuard(['5', withFixture({ express: '5.2.1' })]).status,
  0,
);

// ---------------------------------------------------------------------------
console.log('\n# the drift it exists for — in both directions\n');
// ---------------------------------------------------------------------------

{
  // The #585 shape: the leg claims 5, the adapter resolves 4. Before this
  // guard, this combination went GREEN and reported express-5.
  const run = runGuard(['5', withFixture({ express: '4.22.2' })]);
  check('express-5 leg fails when the adapter resolves express 4', run.status, 1);
  check(
    '...and the message names the version actually resolved',
    run.stderr.includes('4.22.2'),
    true,
  );
  check(
    '...and points at the workspace-scoped install as the remedy',
    run.stderr.includes('--workspace=packages/adapters-express'),
    true,
  );
}

check(
  'express-4 leg fails when the adapter resolves express 5 (symmetric drift)',
  runGuard(['4', withFixture({ express: '5.2.1' })]).status,
  1,
);

// ---------------------------------------------------------------------------
console.log('\n# the leg is identifiable from a PASSING run too\n');
// ---------------------------------------------------------------------------

{
  // #705 asks that the leg be identifiable in the output. A guard that passes
  // silently would satisfy the exit code and not the requirement.
  const run = runGuard(['5', withFixture({ express: '5.2.1' })]);
  check('a passing run names the resolved version', run.stdout.includes('5.2.1'), true);
  check('a passing run names the resolved path', run.stdout.includes('node_modules'), true);
  check(
    'a passing run names the declared peer range',
    run.stdout.includes('^4.18.0 || ^5.0.0'),
    true,
  );
}

// ---------------------------------------------------------------------------
console.log('\n# cannot check is never a pass\n');
// ---------------------------------------------------------------------------

check(
  'express not installed at all is exit 2, not a pass',
  runGuard(['5', withFixture({ express: null })]).status,
  2,
);

check('no expected major given is exit 2', runGuard([]).status, 2);

check(
  'a non-integer expected major is exit 2',
  runGuard(['5.x', withFixture({ express: '5.2.1' })]).status,
  2,
);

check(
  'a missing adapter manifest is exit 2',
  runGuard(['4', withFixture({ express: '4.22.2', manifest: false })]).status,
  2,
);

check(
  'no peerDependencies.express to check against is exit 2',
  runGuard(['4', withFixture({ express: '4.22.2', peer: null })]).status,
  2,
);

{
  // The decorative-guard shape: a range the caret matcher finds no majors in
  // must REFUSE, not conclude "nothing declared, so nothing to disagree with".
  const run = runGuard(['4', withFixture({ express: '4.22.2', peer: '>=4 <6' })]);
  check('a peer range it cannot parse is exit 2, not a silent pass', run.status, 2);
  check(
    '...and it names the range rather than loosening the match',
    run.stderr.includes('>=4 <6'),
    true,
  );
}

// ---------------------------------------------------------------------------
console.log('\n# the instrument is tied to the claim\n');
// ---------------------------------------------------------------------------

{
  // Testing a major the adapter no longer declares is measuring a shipped
  // configuration that is not shipped.
  const run = runGuard(['6', withFixture({ express: '6.0.0' })]);
  check('a leg for an undeclared major fails', run.status, 1);
  check(
    '...and reports which majors ARE declared',
    run.stderr.includes('declared majors'),
    true,
  );
}

check(
  'narrowing the peer range breaks the leg it removed',
  runGuard(['5', withFixture({ express: '5.2.1', peer: '^4.18.0' })]).status,
  1,
);

// ---------------------------------------------------------------------------
console.log('\n# --matrix: every DECLARED major has a leg (#721)\n');

// THE CASE THE ISSUE IS ABOUT. Widen the peer range, add no leg, and every
// other check here stays green: each leg still tests a declared major, the
// matrix still has two legs, and express 6 is advertised and executed by
// nothing. This is the only assertion in the repository that fails on it.
{
  const dir = matrixFixture({ peer: '^4.18.0 || ^5.0.0 || ^6.0.0', legs: ['5', '4'] });
  const r = runGuard(['--matrix', dir]);
  check('a DECLARED major with no matrix leg FAILS', r.status, 1);
  check(
    '...and names the uncovered major, not just "a mismatch"',
    /declares Express 6 but the matrix has no leg/.test(r.stderr),
    true,
  );
  check('...and prints both sides so the reader can see which to change', /matrix legs\s+= 5, 4/.test(r.stderr), true);
}

// THE POSITIVE CONTROL, and it is what stops the above being satisfied by a
// check that fails on everything: the same shape with the leg present passes.
{
  const dir = matrixFixture({ peer: '^4.18.0 || ^5.0.0 || ^6.0.0', legs: ['5', '4', '6'] });
  check('...while the same range WITH a leg for it passes', runGuard(['--matrix', dir]).status, 0);
}
{
  const dir = matrixFixture({ peer: PEER_BOTH, legs: ['5', '4'] });
  const r = runGuard(['--matrix', dir]);
  check('the shipped shape — two declared, two legs — passes', r.status, 0);
  check('...and says so out loud rather than exiting 0 silently', /every declared Express major/.test(r.stdout), true);
}

// THE DIRECTION THIS CHECK DOES NOT OWN. A leg for an UNDECLARED major is the
// per-leg check's job — it fails when the major under test is not a declared
// peer. Asserting 0 here pins the division of labour: without it, a later edit
// could make this a symmetric set-equality and nobody would notice the two
// checks had started reporting the same failure twice.
{
  const dir = matrixFixture({ peer: PEER_BOTH, legs: ['5', '4', '6'] });
  check('a leg for an UNDECLARED major is NOT this check’s failure', runGuard(['--matrix', dir]).status, 0);
}

// CANNOT-CHECK ARMS. Each one fails CLOSED, matching the per-leg guard: a
// matrix this cannot read must never resolve as "nothing uncovered".
{
  const noWorkflow = matrixFixture({ legs: null });
  check('no workflow file is CANNOT CHECK (exit 2), not a pass', runGuard(['--matrix', noWorkflow]).status, 2);

  const wrongJob = matrixFixture({ job: 'some-other-job' });
  const r = runGuard(['--matrix', wrongJob]);
  check('a missing matrix job is CANNOT CHECK, not "zero legs, all covered"', r.status, 2);
  check('...and names the job it looked for', /test-adapters-express/.test(r.stderr), true);

  const emptyMatrix = matrixFixture({ legs: [] });
  check('an empty include list is CANNOT CHECK — zero legs would cover nothing', runGuard(['--matrix', emptyMatrix]).status, 2);

  const unreadableLeg = matrixFixture({ legs: ['5', null] });
  check('a leg with no readable express major is CANNOT CHECK, not skipped', runGuard(['--matrix', unreadableLeg]).status, 2);

  // The shared authority path: an unparseable peer range must fail closed here
  // exactly as it does for the per-leg check, because both read it through the
  // same function.
  const badRange = matrixFixture({ peer: '>=4 <6' });
  check('a peer range the guard cannot parse is CANNOT CHECK in --matrix too', runGuard(['--matrix', badRange]).status, 2);
}

// AND THE REAL REPOSITORY, so the check is not green only against fixtures.
{
  const repoRoot = join(here, '..', '..');
  const r = runGuard(['--matrix', repoRoot]);
  check('the real repository passes — every declared major has a leg today', r.status, 0);
}

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
