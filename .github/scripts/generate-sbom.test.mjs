#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the SBOM generator (#443).
 *
 * ## Why this file exists at all, and what it deliberately does NOT cover
 *
 * `generate-sbom.mjs` had no self-test. #443 added a cannot-check branch to it —
 * a generator that never STARTS now says so instead of reporting
 * `SBOM generation failed (exit null)`, which named an exit that never happened.
 * A new cannot-check branch with nothing asserting it is the exact shape #443 is
 * about: nothing executes the detail-string construction, which is why the
 * original undefined-dereference shipped in the first place.
 *
 * This is NOT the full suite that file deserves. `generate-sbom` is
 * cannot-check-dominant — unparseable JSON, an empty component list and a failed
 * inventory are three more paths — and reaching those needs the #349
 * injectable-seam treatment, which is its own piece of work. What is covered
 * here is the branch this change introduced. Saying which is which matters more
 * than the count: a self-test that exists is routinely mistaken for a self-test
 * that is complete.
 *
 * ## The never-started branch is reachable for real, which was not obvious
 *
 * #349's warning is not to accept an "unreachable" claim without trying it, and
 * it pays off here. The generator spawns `npx` BY NAME, so an empty PATH reaches
 * the branch immediately — no seam, no fixture, no injection. Contrast
 * `check-mutation-audit`, whose two sites spawn `process.execPath`, an absolute
 * path that always resolves; there the same property is pinned by source
 * assertion because a real spawn genuinely cannot be induced.
 *
 * Run: node .github/scripts/generate-sbom.test.mjs
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { tagComponentScopes, CYCLONEDX_NPM_VERSION } from './generate-sbom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GENERATOR = join(here, 'generate-sbom.mjs');

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

// ---------------------------------------------------------------------------
// The cannot-check branch #443 added, driven through the SHIPPED entry point
// ---------------------------------------------------------------------------
{
  const empty = mkdtempSync(join(tmpdir(), 'no-npx-'));
  try {
    const run = spawnSync(process.execPath, [GENERATOR, empty], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: empty },
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;

    // CONTROL, NOT A WITNESS — and it is labelled here because this is where a
    // reader of the assertion looks. Verified by disabling the guard: this line
    // stays GREEN, because the old code exited 2 from the next branch down. It
    // establishes that the run refused at all; the four below are what
    // establish it refused for the RIGHT REASON, and they are the ones that go
    // red.
    check('CONTROL: a generator that never STARTS exits 2', run.status, 2);

    check('...and says it COULD NOT RUN', /COULD NOT RUN/.test(out), true);
    check('...and names the spawn cause rather than swallowing it', /ENOENT/.test(out), true);

    // The sentence this replaced. `null !== 0` is true, so the old code fell
    // into the exit-code branch and reported an exit that never happened —
    // fail-closed, but naming the wrong thing.
    check('...rather than reporting an exit that never happened', /exit null/.test(out), false);

    // And it must not claim to have produced anything.
    check('...and states that nothing was generated', /has not checked anything/.test(out), true);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The paired positive, kept OFF the network
//
// A control that ran the real generator would download a pinned package and
// take minutes, so the positive half is asserted against the pure exported
// helper instead. Without some positive, the cases above would be satisfied by
// a generator that could never succeed at all.
// ---------------------------------------------------------------------------
{
  const sbom = {
    components: [
      { name: 'alpha' },
      { name: 'beta', group: '@scope' },
      { name: 'unknown-to-the-tree' },
    ],
  };
  const deps = [
    { name: 'alpha', scope: 'runtime' },
    { name: '@scope/beta', scope: 'development' },
  ];

  const { tagged, untagged } = tagComponentScopes(sbom, deps);

  check('components present in the inventory are tagged', tagged, 2);
  check('...and one absent from it is reported untagged rather than guessed', untagged, 1);

  const scopeOf = (n) =>
    (sbom.components.find((c) => c.name === n)?.properties ?? []).find(
      (p) => p.name === 'askturret:dependency-scope',
    )?.value;

  check('a runtime dependency is tagged runtime', scopeOf('alpha'), 'runtime');
  // The scoped name must be rebuilt from `group` before lookup, or every scoped
  // package silently falls into the untagged bucket.
  check('a scoped package is matched on its full npm name', scopeOf('beta'), 'development');

  check('the generator version stays pinned', /^\d+\.\d+\.\d+$/.test(CYCLONEDX_NPM_VERSION), true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
