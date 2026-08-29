#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the shared dependency inventory's cannot-check discipline (#464).
 *
 * `lib/dependencies.mjs` decides what the licence gate, the NOTICE generator
 * and the SBOM scope tagger all believe is installed. When `npm ls` fails to
 * START, the honest answer is "unknown"; the answer this library used to give
 * was an empty set, which is a different and much worse thing:
 *
 *   - `inventory()` classifies scope as `runtimeNames.has(name)`, so an empty
 *     runtime set marks EVERY package `development`
 *   - `generate-notice` then renders "(No third-party runtime dependencies.)",
 *     reports `code: 0`, and rewrites NOTICE
 *
 * Attribution is an Apache-2.0 §4(d) obligation, so that is a compliance
 * failure presenting as a clean exit — this repository's signature defect shape.
 *
 * The discrimination is what these tests pin, in BOTH directions. A library that
 * threw on everything would satisfy the cannot-check cases and be incapable of
 * ever reporting an inventory, so every negative here is paired with the
 * positive that keeps it honest.
 *
 * Run: node .github/scripts/lib/dependencies.test.mjs
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { npmLsNamesFrom } from './dependencies.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..', '..');
const GENERATE_NOTICE = join(here, '..', 'generate-notice.mjs');

let passed = 0;
let failed = 0;

function check(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(
      `FAIL - ${desc}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
    failed++;
  }
}

/** Run `fn`, returning the thrown Error or null. Never rethrows. */
function thrownBy(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

// ---------------------------------------------------------------------------
// Fixtures — the exact shapes spawnSync returns
// ---------------------------------------------------------------------------

// A spawn that never started: null status, NULL stdout, and an error. The null
// stdout is the load-bearing detail — `JSON.parse(null || '{}')` succeeds.
const NEVER_STARTED = {
  status: null,
  stdout: null,
  stderr: null,
  error: new Error('spawnSync npm ENOENT'),
};

// Killed by a signal: null status, signal set, and NO error property at all.
// `didNotStart()` is true here too, so any caller that tests the condition and
// then reads `result.error.message` crashes on this row (#443 finding 2).
const SIGNAL_KILLED = {
  status: null,
  stdout: null,
  stderr: null,
  signal: 'SIGKILL',
};

// npm ran and honestly reported a project with no dependencies.
const RAN_EMPTY_TREE = {
  status: 0,
  stdout: JSON.stringify({ name: 'root', version: '1.0.0' }),
  stderr: '',
};

// npm ran and reported a real tree.
const RAN_WITH_TREE = {
  status: 0,
  stdout: JSON.stringify({ dependencies: { alpha: { dependencies: { beta: {} } } } }),
  stderr: '',
};

// The tolerance the original `|| '{}'` was reaching for, and which must survive:
// a peer-dependency complaint exits non-zero while still emitting a full tree.
const PEER_COMPLAINT = {
  status: 1,
  stdout: JSON.stringify({ dependencies: { alpha: {} } }),
  stderr: 'npm ERR! code ELSPROBLEMS',
};

const RAN_NO_OUTPUT = { status: 1, stdout: '', stderr: 'npm ERR! something went wrong' };
const UNPARSEABLE = { status: 0, stdout: 'this is not json', stderr: '' };

// ---------------------------------------------------------------------------
// The regression: a non-starting npm is cannot-check, never an empty set
// ---------------------------------------------------------------------------

{
  const err = thrownBy(() => npmLsNamesFrom(NEVER_STARTED, true));

  check('a spawn that never started THROWS rather than returning a set', err !== null, true);

  // The acceptance criterion stated as the thing that actually went wrong:
  // returning an empty set here is what made NOTICE claim no dependencies.
  check(
    '...so it never returns an empty runtime set, which is what stripped NOTICE',
    err !== null && !(err instanceof TypeError),
    true,
  );

  check(
    '...and names the spawn cause rather than swallowing it',
    err !== null && /ENOENT/.test(err.message),
    true,
  );

  check(
    '...and says the set is UNKNOWN, not that there are none',
    err !== null && /UNKNOWN/.test(err.message),
    true,
  );
}

// ---------------------------------------------------------------------------
// #443 finding 2: the signal-killed row, where `error` is undefined
// ---------------------------------------------------------------------------

{
  const err = thrownBy(() => npmLsNamesFrom(SIGNAL_KILLED, true));

  check('a signal-killed spawn THROWS rather than returning a set', err !== null, true);

  // A condition-only fix passes the case above and fails THIS one: it reaches
  // `result.error.message` on a row where `error` is undefined, and the guard
  // dies with a TypeError instead of reporting that it could not check.
  check(
    '...with a deliberate cannot-check error, not a TypeError from reading .error.message',
    err !== null && !(err instanceof TypeError),
    true,
  );

  check(
    '...and names the signal, so an OOM kill is distinguishable from a missing binary',
    err !== null && /SIGKILL/.test(err.message),
    true,
  );
}

// ---------------------------------------------------------------------------
// The paired positives — without these, throwing on everything would pass
// ---------------------------------------------------------------------------

{
  const names = thrownBy(() => npmLsNamesFrom(RAN_EMPTY_TREE, true));
  check('npm reporting a genuinely empty tree does NOT throw', names, null);

  check(
    '...and returns an empty set, which is a real answer rather than a refusal',
    [...npmLsNamesFrom(RAN_EMPTY_TREE, true)],
    [],
  );
}

check(
  'a real tree is walked, including nested dependencies',
  [...npmLsNamesFrom(RAN_WITH_TREE, false)].sort(),
  ['alpha', 'beta'],
);

check(
  'a non-zero exit that still emitted a tree is tolerated, as before',
  [...npmLsNamesFrom(PEER_COMPLAINT, false)],
  ['alpha'],
);

// ---------------------------------------------------------------------------
// The remaining unusable-output rows
// ---------------------------------------------------------------------------

check(
  'npm running but emitting nothing is cannot-check, not an empty set',
  thrownBy(() => npmLsNamesFrom(RAN_NO_OUTPUT, true)) !== null,
  true,
);

check(
  'unparseable output is still cannot-check',
  thrownBy(() => npmLsNamesFrom(UNPARSEABLE, true)) !== null,
  true,
);

// ---------------------------------------------------------------------------
// End-to-end, through the real consumer and the real binary
// ---------------------------------------------------------------------------
//
// The unit cases above drive an exported seam. This one drives the shipped
// entry point with `npm` genuinely unresolvable, because the defect was only
// ever visible as an EXIT CODE: `generate-notice` returned 0 and rewrote the
// file. Asserting the code specifically — not that some string appears
// somewhere — is what pins it, since exit 0 is the only value that reaches the
// `writeFileSync` branch.
//
// `generate-notice.mjs`'s own docblock records that the cannot-check path is
// reachable only through its injected-inventory fixture, "a state no fixture
// directory can reliably produce". After this fix an empty PATH produces it,
// so the real path is now witnessable.

{
  const emptyDir = mkdtempSync(join(tmpdir(), 'no-npm-'));
  const sandbox = mkdtempSync(join(tmpdir(), 'notice-sandbox-'));
  const noPath = { ...process.env, PATH: emptyDir };

  try {
    // --- the path CI actually runs -------------------------------------------
    const checkRun = spawnSync(process.execPath, [GENERATE_NOTICE, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: noPath,
    });

    check('with npm unresolvable, `--check` exits 2 (cannot check)', checkRun.status, 2);
    check(
      '...and reports that it could not build the inventory',
      /could not build the dependency inventory/.test(`${checkRun.stdout}${checkRun.stderr}`),
      true,
    );

    // --- the path that does the damage ---------------------------------------
    //
    // `--check` is the milder half: with the bug present it exits 1 (stale),
    // which is loud. The compliance failure is in WRITE mode, where an empty
    // runtime set renders "no third-party dependencies", reports code 0, and
    // reaches `writeFileSync`. Asserting on the file's BYTES is what pins that
    // — an exit-code assertion alone passed against the bug, because 1 is not 0
    // either.
    //
    // Run against a sandbox root, never the repository: the failure being
    // reproduced here is "this command rewrites NOTICE", so pointing it at the
    // real one would destroy the file it is meant to protect.
    const noticePath = join(sandbox, 'NOTICE');
    const attribution = 'alpha 1.0.0 — MIT — an attribution line that must survive';
    const original = `Third-party notices.\n\n${attribution}\n`;
    writeFileSync(noticePath, original);

    const writeRun = spawnSync(process.execPath, [GENERATE_NOTICE, sandbox], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: noPath,
    });

    check('write mode with npm unresolvable exits 2, never 0', writeRun.status, 2);
    check(
      '...and leaves NOTICE byte-for-byte unchanged',
      readFileSync(noticePath, 'utf-8'),
      original,
    );
    // Asserting the attribution line SURVIVES would be decorative: the
    // generator only manages the region between its markers and preserves
    // everything outside it, so that line survives the bug too — verified by
    // running this against the reverted fix. The claim that must never appear
    // is the one the empty set produces.
    check(
      '...and never claims the product bundles nothing third-party',
      readFileSync(noticePath, 'utf-8').includes('No third-party runtime dependencies'),
      false,
    );
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
