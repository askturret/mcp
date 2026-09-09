#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for check-npx-invocations.mjs (#738/#755).
 *
 * THE CENTRAL CASE IS THE DISCRIMINATOR: the same invocation line, in the same
 * file, differing only in whether the named package is one the workspace
 * publishes. Without that pair a guard that flagged every `@askturret/…`
 * invocation would satisfy every rejection arm below while being a completely
 * different — and useless — check.
 *
 * The second pair is scope: an INVOCATION of an unpublished name is a finding, a
 * bare IMPORT of the same name is not. That bound is what keeps the guard off
 * `package-lock.json` and off every first-party import in the tree.
 *
 * Exit codes are LOCAL LITERALS, never imported from the module under test.
 * #746 was exactly that defect: constants compared against themselves hold for
 * every possible value.
 *
 * Run: node .github/scripts/check-npx-invocations.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, 'check-npx-invocations.mjs');
const REPO_ROOT = resolve(HERE, '..', '..');

// Deliberately literal. See the header.
const EXIT_OK = 0;
const EXIT_UNKNOWN_PACKAGE = 1;
const EXIT_CANNOT_CHECK = 2;

/**
 * Fixture specifiers, assembled rather than written literally.
 *
 * The guard scans `.mjs` files, INCLUDING THIS ONE. A literal
 * `npx @askturret/<unpublished>` here would make the guard fail the real
 * repository on its own negative fixtures — a guard that forbids its own test
 * data, which is the #740 shape (a step's comment saying "NO continue-on-error"
 * tripping the check that forbids it).
 *
 * Exempting this file from the scan was the other option and is worse: it would
 * also hide a genuine mistake written here. Interpolation keeps the scan
 * complete and costs one indirection.
 */
const SCOPE = '@askturret';
const UNPUBLISHED = `${SCOPE}/mcp`;
const PUBLISHED = `${SCOPE}/mcp-cli`;
const DECLARED = `${SCOPE}/mcp-adapter-test`;
const OTHER_PRIVATE = `${SCOPE}/mcp-secret-thing`;
const INTERNAL = `${SCOPE}/mcp-internal`;

let passed = 0;
let failed = 0;

function check(desc, ok, detail = '') {
  if (ok) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc}${detail ? `\n       ${detail}` : ''}`);
    failed++;
  }
}

function runGuard(root) {
  const r = spawnSync(process.execPath, [GUARD, root], { encoding: 'utf-8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const roots = [];
/** A fixture workspace: `pkgs` are package names, `private` names the private ones. */
function fixture(label, { pkgs = [PUBLISHED], privatePkgs = [], docs = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), `npx-invocations-${label}-`));
  roots.push(root);
  [...pkgs, ...privatePkgs].forEach((name, i) => {
    const dir = join(root, 'packages', `p${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', ...(privatePkgs.includes(name) ? { private: true } : {}) }),
    );
  });
  for (const [name, text] of Object.entries(docs)) {
    const p = join(root, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

try {
  // --- the real repository passes -------------------------------------------
  {
    const { status, out } = runGuard(REPO_ROOT);
    check('the real repository passes — every invocation names a published package', status === EXIT_OK, `exit ${status}\n${out.trim()}`);
    check(
      'a passing run PRINTS a verdict — exit 0 with no output is a silent no-op',
      status === EXIT_OK && /check-npx-invocations: OK/.test(out),
      out.trim(),
    );
    check(
      'the declared exemption is printed on a PASSING run, so a suppression is visible',
      /declared-unpublished: @askturret\/mcp-adapter-test/.test(out),
      out.trim(),
    );
  }

  // --- THE DISCRIMINATOR ------------------------------------------------------
  {
    const bad = fixture('unpublished', { docs: { 'README.md': `Run \`npx ${UNPUBLISHED} doctor spec.yaml\`\n` } });
    const badRun = runGuard(bad);

    const good = fixture('published', { docs: { 'README.md': `Run \`npx ${PUBLISHED} doctor spec.yaml\`\n` } });
    const goodRun = runGuard(good);

    check('an invocation of an UNPUBLISHED package fails', badRun.status === EXIT_UNKNOWN_PACKAGE, `exit ${badRun.status}\n${badRun.out.trim()}`);
    check('the SAME line naming a PUBLISHED package passes', goodRun.status === EXIT_OK, `exit ${goodRun.status}\n${goodRun.out.trim()}`);
    check('the failure names the file, the line and the specifier', /README\.md:1\s+@askturret\/mcp\b/.test(badRun.out), badRun.out.trim());
    check('the failure lists what IS published, so the reader can pick', /@askturret\/mcp-cli/.test(badRun.out), badRun.out.trim());
  }

  // --- scope: invocations, not bare mentions ---------------------------------
  {
    const root = fixture('bare-mention', {
      docs: {
        'src/index.ts': `import { compile } from '${UNPUBLISHED}';\nconst dep = '${UNPUBLISHED}';\n`,
      },
    });
    const { status, out } = runGuard(root);
    check(
      'a bare IMPORT of an unpublished name is NOT flagged — that is a different claim from "go install this"',
      status === EXIT_OK,
      `exit ${status}\n${out.trim()}`,
    );
  }

  // --- the forms a reader actually copies ------------------------------------
  {
    const versioned = fixture('versioned', { docs: { 'a.md': `npx ${PUBLISHED}@0.1.2 migrate\n` } });
    check('a version suffix is tolerated and ignored', runGuard(versioned).status === EXIT_OK);

    const flagged = fixture('flagged', { docs: { 'a.md': `npx --yes ${PUBLISHED} migrate\n` } });
    check('flags between the command and the specifier are tolerated', runGuard(flagged).status === EXIT_OK);

    const badVersioned = fixture('bad-versioned', { docs: { 'a.md': `npx ${UNPUBLISHED}@0.1.2 migrate\n` } });
    check('...and a versioned UNPUBLISHED name is still caught', runGuard(badVersioned).status === EXIT_UNKNOWN_PACKAGE);

    // --- THE CO-INSTALLED DEPENDENCY (#766) ----------------------------------
    //
    // `npm install express @askturret/…` — the specifier is not the first
    // argument. The pattern used to skip only FLAGS, so a bare package name
    // ahead of ours ended the match and the invocation was never FOUND. An
    // unfound invocation is indistinguishable from a file containing none, so
    // this failed SILENT rather than loud.
    //
    // It is README.md's primary quick-start install line, and it was the only
    // line in the repository the old pattern missed. Measured on the PRE-CHANGE
    // tree (`origin/main` at 13684c6): 61 such lines, of which the old pattern
    // matched 60 and this one matches all 61 — one gained, README.md:21, no
    // remainder. The guard header carries the same figures and why they must be
    // measured against the pre-change tree.
    const coInstalledBad = fixture('co-installed-unpublished', {
      docs: { 'README.md': `npm install express ${UNPUBLISHED}\n` },
    });
    check(
      'a specifier AFTER a co-installed package is FOUND, and fails when unpublished',
      runGuard(coInstalledBad).status === EXIT_UNKNOWN_PACKAGE,
      runGuard(coInstalledBad).out.trim(),
    );

    // Without this the assertion above is also satisfied by a guard that fails
    // on every co-installed line whatever it names — the tautology shape.
    const coInstalledGood = fixture('co-installed-published', {
      docs: { 'README.md': `npm install express ${PUBLISHED}\n` },
    });
    check(
      '...and the SAME shape naming a PUBLISHED package passes',
      runGuard(coInstalledGood).status === EXIT_OK,
      runGuard(coInstalledGood).out.trim(),
    );

    // The skip admits ARGUMENTS, not arbitrary text. A `.*` here would report a
    // package that is not being installed at all.
    const notAnArgument = fixture('not-an-argument', {
      docs: { 'a.md': `npm install express && echo ${UNPUBLISHED}\n` },
    });
    check(
      'text after a shell operator is NOT read as an installed package',
      runGuard(notAnArgument).status === EXIT_OK,
      runGuard(notAnArgument).out.trim(),
    );

    // --- THE SAME RESIDUAL, FOR SCOPED AND VERSIONED NEIGHBOURS (#766) -------
    //
    // The skip run admits a flag, or a BARE package name. It admits neither an
    // @-scoped name nor a versioned one, so a co-installed neighbour of either
    // shape still ends the match and the specifier after it is never FOUND —
    // the identical silent shape this change fixed for the plain case.
    //
    // That is a CONSEQUENCE OF THE DELIBERATE @-EXCLUSION documented on the
    // pattern, not an oversight: nothing @-prefixed may be consumed by the skip,
    // which is exactly what stops the skip swallowing the specifier itself. A
    // widening would have to preserve that property, and there is nothing live
    // to pay for it — on the pre-change tree the new pattern matches 61 of 61,
    // remainder zero. So the limitation is PINNED rather than fixed, and these
    // two cases redden the day someone widens the pattern without revisiting
    // them, which is the point of writing them down as tests instead of prose.
    //
    // Exit 0 means NOT FOUND here, because the specifier names an UNPUBLISHED
    // package — were it found, the guard would exit 1. The bare-neighbour case
    // above is the control: same shape, neighbour written bare, exit 1. A guard
    // that simply never fires cannot satisfy both.
    const scopedNeighbour = fixture('scoped-neighbour', {
      docs: { 'README.md': `npm install @types/node ${UNPUBLISHED}\n` },
    });
    check(
      'KNOWN LIMITATION: an @-scoped co-installed neighbour hides the specifier — not found, so exit 0',
      runGuard(scopedNeighbour).status === EXIT_OK,
      runGuard(scopedNeighbour).out.trim(),
    );

    const versionedNeighbour = fixture('versioned-neighbour', {
      docs: { 'README.md': `npm install express@^5 ${UNPUBLISHED}\n` },
    });
    check(
      'KNOWN LIMITATION: a VERSIONED co-installed neighbour hides the specifier too',
      runGuard(versionedNeighbour).status === EXIT_OK,
      runGuard(versionedNeighbour).out.trim(),
    );

    for (const cmd of ['npm install', 'npm i', 'yarn add', 'pnpm add']) {
      const root = fixture(`cmd-${cmd.replace(/\W+/g, '-')}`, { docs: { 'a.md': `${cmd} ${UNPUBLISHED}\n` } });
      check(`\`${cmd}\` is an invocation form too`, runGuard(root).status === EXIT_UNKNOWN_PACKAGE);
    }
  }

  // --- the declared exemption -------------------------------------------------
  {
    const root = fixture('exempt', {
      privatePkgs: [DECLARED],
      docs: { 'docs/adapters.md': `npx ${DECLARED} ./my-adapter\n` },
    });
    const { status, out } = runGuard(root);
    check(
      'a DECLARED unpublished package is suppressed rather than failing',
      status === EXIT_OK,
      `exit ${status}\n${out.trim()}`,
    );
    check('...and the suppression is PRINTED with its reason and issue', /#173/.test(out), out.trim());
    check('...and it names how many invocations it suppressed', /1 invocation\(s\) suppressed/.test(out), out.trim());

    // The exemption must not become a blanket pass for anything private.
    const other = fixture('other-private', {
      privatePkgs: [OTHER_PRIVATE],
      docs: { 'a.md': `npx ${OTHER_PRIVATE} run\n` },
    });
    check(
      'a DIFFERENT private package is NOT exempt — the entries are named, not a pattern',
      runGuard(other).status === EXIT_UNKNOWN_PACKAGE,
    );

    // --- AN EXEMPTION IS NOT INHERITED BY EXTENSION (#759) --------------------
    //
    // The capture used to be `[a-z0-9][a-z0-9-]*`, which excludes `_` and `.` —
    // both LEGAL npm name characters. It truncated at the first one, and the
    // exemption lookup is an exact `Object.hasOwn`, so the TRUNCATED name
    // matched: a package inherited an exemption by merely STARTING with an
    // exempt name, and was suppressed.
    //
    // These are the direct pins. Each name below extends the exempt entry by a
    // character the old class could not hold, so each captured as the exempt
    // entry and returned exit 0. They must now be FOUND, and finding them means
    // failing, because the extended name is not a published package.
    for (const [suffix, shape] of [
      ['_v2', 'underscore'],
      ['.v2', 'dot'],
      ['_', 'a TRAILING underscore — the name must not truncate back onto the exemption'],
    ]) {
      const extended = fixture(`exempt-extended-${shape.replace(/\W+/g, '-')}`, {
        privatePkgs: [DECLARED],
        docs: { 'docs/adapters.md': `npx ${DECLARED}${suffix} ./my-adapter\n` },
      });
      const r = runGuard(extended);
      check(
        `a name extending the exempt entry by ${shape} is FLAGGED, not suppressed`,
        r.status === EXIT_UNKNOWN_PACKAGE,
        `exit ${r.status}\n${r.out.trim()}`,
      );
      check(
        `...and the report names the FULL extended name, not the exempt prefix`,
        r.out.includes(`${DECLARED}${suffix}`),
        r.out.trim(),
      );
    }

    // THE POSITIVE CONTROL, and it is what stops all of the above being
    // satisfied by a guard that simply exempts nothing: the exact exempt name,
    // unextended, must still be suppressed. Asserted at the top of this block
    // too — repeated here deliberately, because these two claims are only
    // meaningful as a pair and a future edit will read them together.
    const exact = fixture('exempt-exact-control', {
      privatePkgs: [DECLARED],
      docs: { 'docs/adapters.md': `npx ${DECLARED} ./my-adapter\n` },
    });
    check(
      '...while the exact exempt name is STILL suppressed — the exemption still works',
      runGuard(exact).status === EXIT_OK,
      runGuard(exact).out.trim(),
    );

    // THE OTHER DIRECTION OF THE SAME CHOICE. The name may end with `_` or `-`
    // but NOT with a dot, because a sentence-ending period is the common
    // neighbour of a package name in prose. Admitting a trailing dot would
    // capture `<published>.` and report a package that does not exist — a
    // noisy false accusation on a correct document, traded for the silent
    // suppression above. This pins that trade.
    // NOTE THE ABSENCE OF BACKTICKS, and it is the whole assertion. The first
    // version of this fixture wrote ``npx <pkg>`.`` — the closing backtick sits
    // between the name and the period, so the capture ended at the backtick and
    // the period was never adjacent to the name. It passed under a pattern that
    // DOES admit a trailing dot, which means it was pinning nothing. Caught by
    // running the mutation rather than by reading the fixture.
    const prose = fixture('prose-trailing-period', {
      docs: { 'docs/guide.md': `Install it with npx ${PUBLISHED}.\n` },
    });
    check(
      'a sentence-ending period after a PUBLISHED name is not read as part of it',
      runGuard(prose).status === EXIT_OK,
      runGuard(prose).out.trim(),
    );
  }

  // --- stale exemptions are reported -----------------------------------------
  {
    // Nothing invokes the declared package here, so the entry has become a claim
    // about nothing and should say so rather than sit unread.
    const root = fixture('stale', { docs: { 'a.md': `npx ${PUBLISHED} doctor\n` } });
    const { status, out } = runGuard(root);
    check('an exemption nothing invokes is reported as STALE', status === EXIT_OK && /is STALE/.test(out), out.trim());
  }

  // --- CANNOT CHECK arms ------------------------------------------------------
  {
    const noPackages = mkdtempSync(join(tmpdir(), 'npx-invocations-nopkgs-'));
    roots.push(noPackages);
    const r1 = runGuard(noPackages);
    check('no packages/ directory is CANNOT CHECK (exit 2), not a pass', r1.status === EXIT_CANNOT_CHECK, `exit ${r1.status}\n${r1.out.trim()}`);
    check('...and it says nothing was verified', /NOT a pass/.test(r1.out), r1.out.trim());

    // The vacuity guard. An empty authority set would make EVERY invocation look
    // invalid — a confidently wrong answer rather than an absent one.
    const allPrivate = fixture('all-private', { pkgs: [], privatePkgs: [INTERNAL], docs: { 'a.md': `npx ${UNPUBLISHED} doctor\n` } });
    const r2 = runGuard(allPrivate);
    check('a workspace with no PUBLIC package is CANNOT CHECK, not 100% violations', r2.status === EXIT_CANNOT_CHECK, `exit ${r2.status}\n${r2.out.trim()}`);
  }

  // --- the three outcomes are distinct ----------------------------------------
  check(
    'the three exit codes are pairwise distinct (0 pass, 1 finding, 2 cannot-check)',
    EXIT_OK !== EXIT_UNKNOWN_PACKAGE && EXIT_OK !== EXIT_CANNOT_CHECK && EXIT_UNKNOWN_PACKAGE !== EXIT_CANNOT_CHECK,
  );
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
