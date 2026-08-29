#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for sdk-upgrade-drill.mjs (#371).
 *
 * The drill had no self-test at all, which is why the defect below survived: it
 * is the only script in .github/scripts wired into test-integrity without a
 * sibling `*.test.mjs`, so nothing exercised its failure routing.
 *
 * ## What is asserted, and why it is asserted HERE rather than end-to-end
 *
 * The property is a CLASSIFICATION: a spawn result that never started must
 * route to CANNOT CHECK, never to interpretation. Driving that end-to-end would
 * mean inducing a real spawn failure, and after #371 the interpreter is
 * `process.execPath` — which always resolves — so the honest way to reach the
 * branch is to hand the classifier the shape `spawnSync` actually returns.
 *
 * That is deliberate rather than a shortcut. Faking the spawn would let the
 * test pass while the production call site ignored the classifier, so the
 * ROUTING is asserted separately below by reading the call sites, and the
 * classifier by exercising it.
 *
 * Run: node .github/scripts/sdk-upgrade-drill.test.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { didNotStart, couldNotRun, spawnFailureDetail } from './sdk-upgrade-drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DRILL = join(here, 'sdk-upgrade-drill.mjs');

let passed = 0;
let failed = 0;

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (expected ${expected}, got ${actual})`);
    failed++;
  }
}

// The exact shape spawnSync returns when the process never started: a null
// status and NULL stdout/stderr, plus an error. Not an exit code, and not empty
// output from a real run.
const NEVER_STARTED = {
  status: null,
  stdout: null,
  stderr: null,
  error: new Error('spawnSync node ENOENT'),
};

// A real run that failed, and a real run that succeeded silently. The second is
// the one that makes this discrimination non-trivial: it also has no output.
const RAN_AND_FAILED = { status: 2, stdout: 'src/a.ts(1,1): error TS2307\n', stderr: '' };
const RAN_AND_SAID_NOTHING = { status: 0, stdout: '', stderr: '' };

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

check('a spawn that never started is recognised', didNotStart(NEVER_STARTED), true);

// The paired positives. Without these, a classifier that returned true for
// everything — routing every run to CANNOT CHECK — would satisfy the case above
// and make the drill incapable of ever passing or failing.
check('a build that ran and FAILED is not confused with one that never started', didNotStart(RAN_AND_FAILED), false);
check(
  'a build that ran and emitted NOTHING is not confused with one that never started',
  didNotStart(RAN_AND_SAID_NOTHING),
  false,
);

// ---------------------------------------------------------------------------
// The verdict it produces
// ---------------------------------------------------------------------------

{
  const verdict = couldNotRun(NEVER_STARTED, 'post-break');

  // 2, never 0 and never 1: the drill did not measure anything, so it has
  // neither passed nor found a violation.
  check('a build that never started is CANNOT CHECK (2)', verdict.code, 2);
  check(
    '...and says so in words, rather than implying a verdict',
    /COULD NOT RUN/.test(verdict.message) && /never the same as a pass/.test(verdict.message),
    true,
  );
  check('...and names the phase, so the reader knows which build died', /post-break/.test(verdict.message), true);
  check('...and surfaces the spawn error rather than swallowing it', /ENOENT/.test(verdict.message), true);
  check(
    '...and states what WOULD have been reported, which is the whole hazard',
    /PASS with an empty blast radius/.test(verdict.message),
    true,
  );
}

// ---------------------------------------------------------------------------
// The shared failure detail (#464)
//
// `didNotStart()` is true for TWO shapes, and only one of them sets `error`. A
// caller that tests the condition and then reads `result.error.message` crashes
// on the other — #443 finding 2. This is the one place that knows the
// difference, so `lib/dependencies.mjs` imports it rather than re-deriving it.
// ---------------------------------------------------------------------------

check(
  'a failed spawn reports its error message',
  spawnFailureDetail(NEVER_STARTED),
  'spawnSync node ENOENT',
);

// The row that has no `error` at all. Reading `.error.message` here throws.
const SIGNAL_KILLED = { status: null, stdout: null, stderr: null, signal: 'SIGKILL' };

check(
  'a signal-killed spawn names the signal rather than dereferencing undefined',
  spawnFailureDetail(SIGNAL_KILLED),
  'killed by signal SIGKILL',
);

check(
  'a spawn with neither error nor signal degrades to a stated absence',
  spawnFailureDetail({ status: null, stdout: null, stderr: null }),
  '(none reported)',
);

check(
  'the signal row still reaches CANNOT CHECK (2) rather than crashing the drill',
  couldNotRun(SIGNAL_KILLED, 'baseline').code,
  2,
);

// ---------------------------------------------------------------------------
// The routing — asserted against the production source
//
// The classifier being correct is worth nothing if a call site ignores it. Both
// builds must consult it, and the post-break one must do so BEFORE the
// `status === 0` test that would otherwise swallow a null.
//
// Read from source rather than executed, because reaching these lines for real
// requires a spawn failure that `process.execPath` has now made unreachable by
// design. Stated plainly so nobody mistakes this for an end-to-end check.
// ---------------------------------------------------------------------------

const source = readFileSync(DRILL, 'utf-8');

check(
  'the baseline build consults the classifier',
  /didNotStart\(before\)/.test(source),
  true,
);

check(
  'the post-break build consults the classifier',
  /didNotStart\(after\)/.test(source),
  true,
);

// Both ordering assertions require PRESENCE explicitly. Without it they pass
// VACUOUSLY when the guard is deleted: `indexOf` returns -1, and -1 is less than
// any real position, so a removed check satisfies "comes before".
//
// Found by running the routing revert and noticing that ONE assertion reddened
// where two should have. The presence assertions above already catch deletion,
// so this was never the only line of defence — but an assertion that cannot fail
// on the thing it names is decorative, which is the antipattern docs/TESTING.md
// names and this file exists to avoid.
const orderedBefore = (first, second) => {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  return a !== -1 && b !== -1 && a < b;
};

check(
  'the post-break null check comes BEFORE the `status === 0` test it would fall through',
  orderedBefore('didNotStart(after)', 'after.status === 0'),
  true,
);

check(
  'the baseline null check comes BEFORE the branch that reads its stdout',
  orderedBefore('didNotStart(before)', 'before.status !== 0'),
  true,
);

// The interpreter half of #371. Cheap to assert here as well as in
// check-guards.test.mjs, because that guard scans *.test.mjs only — this is a
// production script and would otherwise be covered by nothing.
check(
  'the drill spawns process.execPath, not a bare `node`',
  /spawnSync\(process\.execPath,/.test(source) && !/spawnSync\(\s*['"]node['"]/.test(source),
  true,
);

check(
  'and the tsc path stays RELATIVE, so it still resolves against the temp-copy cwd',
  /'node_modules\/typescript\/bin\/tsc'/.test(source),
  true,
);

// ---------------------------------------------------------------------------
// The signal-killed row, against a REAL child rather than a fixture (#443)
//
// Every case above uses a hand-written object shaped like a `spawnSync` result.
// That is the right way to test a classifier, and it has one weakness: the
// fixture asserts what I BELIEVE node returns for a signal-killed child. If the
// belief is wrong, the fixture and the code agree with each other and both are
// wrong — the Transcribed Oracle shape, one level up.
//
// So this spawns a child that kills ITSELF with SIGKILL and asserts the shape
// from the runtime. It is also the acceptance item #443 asks for: the row is
// `status: null` with `error` UNDEFINED, which is the combination a condition-
// only fix admits and then dereferences.
// ---------------------------------------------------------------------------
{
  const killed = spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'], {
    encoding: 'utf-8',
  });

  check('a REAL signal-killed child reports status null', killed.status, null);
  check('...and carries NO error object — the half a condition-only fix misses', killed.error, undefined);
  check('...and does carry the signal', killed.signal, 'SIGKILL');

  check('didNotStart recognises it', didNotStart(killed), true);
  check('spawnFailureDetail names the signal rather than crashing', spawnFailureDetail(killed), 'killed by signal SIGKILL');
  check('...and it still routes to CANNOT CHECK (2)', couldNotRun(killed, 'baseline').code, 2);

  // THE DEFECT ITSELF, observed rather than described: the inlined form #443
  // finding 2 documents throws on this exact result.
  let threw = null;
  try {
    void killed.error.message;
  } catch (e) {
    threw = e.constructor.name;
  }
  check('the inlined `result.error.message` THROWS on this row', threw, 'TypeError');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
