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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// THE FOUR CANNOT-CHECK EXITS (#560, D3)
//
// All four are `exit(2)` — the #281 class, where "could not check" must never
// resolve as "it passed". None was witnessed: this file exercised
// `tagComponentScopes` and the pinned generator version, and never drove `main`.
//
// THE SEAM IS PATH, and it needs no production change: the script spawns `npx`
// BY NAME, and takes `<repoRoot> --output <name>`. A fake `npx` earlier on PATH
// therefore decides what the generator does, and a fake `npm` decides whether
// the dependency inventory can be built at all.
//
// Each fixture drives ONE of the four so the exits are told apart rather than
// all four being satisfied by "it exited 2".
// ---------------------------------------------------------------------------
{
  /** A repo root plus a bin dir that shadows npx/npm for the child only. */
  const sbomFixture = ({ npx = null, npm = null }) => {
    const dir = mkdtempSync(join(tmpdir(), 'sbom-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    if (npx !== null) writeFileSync(join(bin, 'npx'), npx, { mode: 0o755 });
    if (npm !== null) writeFileSync(join(bin, 'npm'), npm, { mode: 0o755 });
    return { dir, bin };
  };

  const runGenerator = ({ dir, bin }) =>
    spawnSync(process.execPath, [GENERATOR, dir, '--output', 'sbom.json'], {
      encoding: 'utf-8',
      // The fixture bin FIRST so it shadows, then the standard dirs — the fake
      // generator is a shell script and needs \`cat\` to exist. Neither npx nor npm
      // lives in /usr/bin or /bin on this machine, so the real ones are not
      // reachable through the tail of this PATH.
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });

  // A fake npx that writes whatever body is asked of it to --output-file.
  const npxWriting = (body) =>
    [
      '#!/bin/sh',
      'out=""',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "--output-file" ]; then out="$2"; fi',
      '  shift',
      'done',
      `cat > "$out" <<'JSON'`,
      body,
      'JSON',
      'exit 0',
    ].join('\n');

  const SUCCEEDS = '#!/bin/sh\nexit 0\n';

  // --- the generator RAN and FAILED -----------------------------------------
  {
    const f = sbomFixture({ npx: '#!/bin/sh\necho "boom" >&2\nexit 3\n' });
    try {
      const r = runGenerator(f);
      check('sbom: a generator that fails is CANNOT CHECK', r.status, 2);
      check('sbom: ...and reports the generation failure', /SBOM generation failed/.test(r.stderr), true);
      // Distinguished from the never-started route, which is a different site
      // and already witnessed — otherwise this fixture would cover neither.
      check('sbom: ...and NOT as a generator that could not run', /COULD NOT RUN/.test(r.stderr), false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }

  // --- the generator produced unparseable JSON ------------------------------
  {
    const f = sbomFixture({ npx: npxWriting('this is not json') });
    try {
      const r = runGenerator(f);
      check('sbom: unparseable generator output is CANNOT CHECK', r.status, 2);
      check('sbom: ...and says the JSON could not be parsed', /unparseable JSON/.test(r.stderr), true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }

  // --- the generator produced an EMPTY inventory ----------------------------
  //
  // The one that would otherwise pass every downstream check while describing
  // nothing — an empty SBOM is the empty-pass family (#514) in artifact form.
  {
    const f = sbomFixture({ npx: npxWriting('{"components": []}') });
    try {
      const r = runGenerator(f);
      check('sbom: an SBOM with no components is CANNOT CHECK', r.status, 2);
      check('sbom: ...and refuses to publish an empty inventory', /no components/.test(r.stderr), true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }

  // --- the dependency inventory could not be built --------------------------
  //
  // Reached only when the SBOM itself is fine, so this fixture needs a WORKING
  // generator and a broken `npm` — which is what separates it from the three
  // above rather than merely being a fourth exit 2.
  {
    const f = sbomFixture({
      npx: npxWriting('{"components": [{"name": "x", "version": "1.0.0"}]}'),
      npm: '#!/bin/sh\necho "npm exploded" >&2\nexit 1\n',
    });
    try {
      const r = runGenerator(f);
      check('sbom: an inventory that cannot be built is CANNOT CHECK', r.status, 2);
      check('sbom: ...and says so rather than emitting an untagged SBOM', /dependency inventory/.test(r.stderr), true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }

  // CONTROL. Four exit-2 assertions prove nothing if the script exits 2 on
  // everything: a working generator and a working npm must reach exit 0.
  {
    const f = sbomFixture({
      npx: npxWriting('{"components": [{"name": "x", "version": "1.0.0"}]}'),
      npm: '#!/bin/sh\necho \'{"dependencies":{}}\'\nexit 0\n',
    });
    try {
      const r = runGenerator(f);
      check('sbom: CONTROL — a working generator and npm reach exit 0', r.status, 0);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
