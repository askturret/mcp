#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the Releases-vs-registry reconciler (#599).
 *
 * THE ACCEPTANCE ITEM THIS FILE EXISTS FOR: "verified by construction against
 * the 2026-09-03 state" — the reconciler must FAIL when pointed at a release
 * whose publish did not land. A reconciler that has never been shown going red
 * is the same class of defect it exists to catch, and it is the item most
 * likely to be skipped because the happy path is easy and green.
 *
 * So the cases below are ordered by what they prove, not by what they cover:
 *
 *   1. It goes RED on the real 2026-09-03 shape (Release exists, npm does not
 *      have it). Without this every other assertion here is decoration.
 *   2. It goes RED in the OTHER direction (npm has it, no Release).
 *   3. The baseline suppresses ONLY the declared pair, and a NEW manual publish
 *      still fires. A baseline that suppressed the class would have silenced
 *      the case the direction exists for.
 *   4. Cannot-read is exit 2 and never a pass.
 *   5. The vacuity guards: an empty package set and an unreadable baseline are
 *      cannot-check, not clean runs.
 *
 * Every arm runs OFFLINE against an injected `readState`. A self-test that had
 * to reach the network to exercise the cannot-check arm would be flaky in
 * exactly the conditions that arm exists for.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkLive,
  reconcile,
  report,
  versionOfTag,
  discoverPublicPackages,
  EXIT_OK,
  EXIT_DIVERGENCE,
  EXIT_CANNOT_CHECK,
} from './check-release-registry-reconcile.mjs';

let passed = 0;
let failed = 0;
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

/** A throwaway repo root: public packages, plus an optional baseline file. */
function fixture({ packages = { core: false, cli: false }, baseline = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'packages'), { recursive: true });
  for (const [name, isPrivate] of Object.entries(packages)) {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    writeFileSync(
      join(dir, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@askturret/mcp-${name}`, version: '0.0.0', private: isPrivate }, null, 2),
    );
  }
  mkdirSync(join(dir, '.github'), { recursive: true });
  if (baseline !== null) {
    writeFileSync(join(dir, '.github', 'release-registry-baseline.json'), JSON.stringify({ baseline }, null, 2));
  }
  return dir;
}

const reader = (state) => async () => state;
const v = (attested = false) => ({ attested });

/** Everything `report` would put on stdout and stderr, as one string. */
function capture(result) {
  const lines = [];
  const sink = (m) => lines.push(String(m));
  report(result, { log: sink, error: sink });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 1. THE 2026-09-03 SHAPE. A Release exists; the registry does not have it.
//    This is the incident, and it is the assertion this file exists for.
// ---------------------------------------------------------------------------
{
  const dir = fixture();
  const r = await checkLive({
    rootDir: dir,
    readState: reader({
      releases: [{ tag: 'v0.1.1', publishedAt: '2026-09-03T17:21:30Z' }],
      registry: {
        // core published; cli did NOT land. That asymmetry is the point: a
        // partial publish is still a failed publish.
        '@askturret/mcp-core': { versions: { '0.1.1': v() }, absent: false },
        '@askturret/mcp-cli': { versions: {}, absent: false },
      },
      unreadable: [],
    }),
  });
  check('2026-09-03: a Release whose publish did not land is a DIVERGENCE', r.code, EXIT_DIVERGENCE);
  check(
    '2026-09-03: ...and it names the package that is missing from the registry',
    r.divergences.some((d) => d.includes('@askturret/mcp-cli@0.1.1') && d.includes('did not land')),
    true,
  );
  check(
    '2026-09-03: ...and does NOT accuse the package that did publish',
    r.divergences.some((d) => d.includes('@askturret/mcp-core@0.1.1')),
    false,
  );
}

// ---------------------------------------------------------------------------
// 2. THE OTHER DIRECTION. The registry has a version no Release names.
// ---------------------------------------------------------------------------
{
  const dir = fixture();
  const r = await checkLive({
    rootDir: dir,
    readState: reader({
      releases: [{ tag: 'v0.1.1' }],
      registry: {
        '@askturret/mcp-core': { versions: { '0.1.1': v(), '0.9.9': v() }, absent: false },
        '@askturret/mcp-cli': { versions: { '0.1.1': v() }, absent: false },
      },
      unreadable: [],
    }),
  });
  check('manual publish: a registry version with no Release is a DIVERGENCE', r.code, EXIT_DIVERGENCE);
  check(
    'manual publish: ...and it names the pair and says it bypassed the release path',
    r.divergences.some((d) => d.includes('@askturret/mcp-core@0.9.9') && d.includes('outside the release path')),
    true,
  );
}

// ---------------------------------------------------------------------------
// 3. THE BASELINE SUPPRESSES ONE PAIR — AND NOTHING ELSE.
//
//    The constraint that matters: a NEW manual publish still fires while the
//    declared one is quiet. A cutoff would have silenced both, which is why the
//    baseline is pairs.
// ---------------------------------------------------------------------------
{
  const dir = fixture({
    baseline: [{ package: '@askturret/mcp-core', version: '0.1.0', recorded: '2026-09-04', reason: 'fixture' }],
  });
  const r = await checkLive({
    rootDir: dir,
    readState: reader({
      releases: [{ tag: 'v0.1.1' }],
      registry: {
        '@askturret/mcp-core': { versions: { '0.1.0': v(), '0.1.1': v() }, absent: false },
        '@askturret/mcp-cli': { versions: { '0.1.1': v() }, absent: false },
      },
      unreadable: [],
    }),
  });
  check('baseline: the declared pair does NOT redden the run', r.code, EXIT_OK);
  check('baseline: ...and the suppression is REPORTED, not silent', r.suppressed.join(','), '@askturret/mcp-core@0.1.0');

  // The same fixture plus an UNDECLARED manual publish must still go red.
  const r2 = await checkLive({
    rootDir: dir,
    readState: reader({
      releases: [{ tag: 'v0.1.1' }],
      registry: {
        '@askturret/mcp-core': { versions: { '0.1.0': v(), '0.1.1': v(), '0.2.0': v() }, absent: false },
        '@askturret/mcp-cli': { versions: { '0.1.1': v() }, absent: false },
      },
      unreadable: [],
    }),
  });
  check('baseline: a NEW manual publish still fires alongside a baselined one', r2.code, EXIT_DIVERGENCE);
  check(
    'baseline: ...and it is the new pair that is named, not the declared one',
    r2.divergences.some((d) => d.includes('0.2.0')) && !r2.divergences.some((d) => d.includes('mcp-core@0.1.0')),
    true,
  );
}

// ---------------------------------------------------------------------------
// 4. CANNOT-READ IS EXIT 2, NEVER A PASS, AND NEVER A DIVERGENCE.
//
//    An unread package can manufacture a "missing from the registry" finding
//    that is really an outage. Reporting that as a divergence would be a false
//    accusation; reporting it as OK would be #281.
// ---------------------------------------------------------------------------
{
  const dir = fixture();
  const r = await checkLive({
    rootDir: dir,
    readState: reader({
      releases: [{ tag: 'v0.1.1' }],
      registry: { '@askturret/mcp-core': { versions: { '0.1.1': v() }, absent: false } },
      unreadable: [{ what: '@askturret/mcp-cli', reason: 'registry returned 503' }],
    }),
  });
  check('outage: an unreadable package is CANNOT CHECK', r.code, EXIT_CANNOT_CHECK);
  check('outage: ...and it says which one and why', r.cannotCheck.some((c) => c.includes('503')), true);

  const noReleases = await checkLive({
    rootDir: dir,
    readState: reader({ releases: null, registry: {}, unreadable: [{ what: 'releases', reason: 'API returned 502' }] }),
  });
  check('outage: an unreadable release list is CANNOT CHECK, not "no releases"', noReleases.code, EXIT_CANNOT_CHECK);
}

// ---------------------------------------------------------------------------
// 4b. THE MIXED STATE: a genuine divergence AND an unreadable package, together.
//
//     Neither pure case above exercises this, which is exactly why the defect
//     survived review (#649). Cannot-check outranks divergence for the exit
//     code — that ordering is correct and is asserted here unchanged — but the
//     report used to return from the cannot-check branch BEFORE printing the
//     divergences it had already computed. The operator was told "Nothing was
//     compared" while a package had in fact been compared and had produced the
//     incident-shaped finding.
//
//     This is the shape of the reconciler's FIRST real exercise: nine registry
//     reads, and any one of them hiccuping suppresses the naming of a package
//     that did not publish.
// ---------------------------------------------------------------------------
{
  const dir = fixture();
  const mixed = await checkLive({
    rootDir: dir,
    readState: reader({
      releases: [{ tag: 'v0.1.1' }],
      // core reads fine and DIVERGES — the publish did not land.
      // cli cannot be read at all.
      registry: { '@askturret/mcp-core': { versions: {}, absent: false } },
      unreadable: [{ what: '@askturret/mcp-cli', reason: 'registry returned 503' }],
    }),
  });

  check('mixed: cannot-check still OUTRANKS divergence for the exit code', mixed.code, EXIT_CANNOT_CHECK);
  check(
    'mixed: ...and the divergence really is computed, so suppressing it would lose a finding',
    mixed.divergences.some((d) => d.includes('@askturret/mcp-core@0.1.1') && d.includes('did not land')),
    true,
  );

  const printed = capture(mixed);
  check('mixed: the divergence is PRINTED, not returned past (#649)', printed.includes('@askturret/mcp-core@0.1.1'), true);
  check('mixed: ...alongside the cannot-check block, which still names the outage', printed.includes('503'), true);
  check(
    'mixed: ...and the report never claims nothing was compared when something was',
    printed.includes('Nothing was compared'),
    false,
  );
  check(
    'mixed: ...it states what WAS and was not compared, so the reader can size the gap',
    printed.includes('1 of 2 package(s) were compared'),
    true,
  );

  // CONTROL. Without this, the assertion above is satisfied by deleting the
  // sentence outright — and the sentence is CORRECT when it is true. A pure
  // cannot-check, nothing compared at all, must still say so.
  const nothing = await checkLive({
    rootDir: dir,
    readState: reader({ releases: null, registry: {}, unreadable: [{ what: 'releases', reason: 'API returned 502' }] }),
  });
  const nothingPrinted = capture(nothing);
  check(
    'CONTROL: when nothing genuinely was compared, the report still says exactly that',
    nothingPrinted.includes('Nothing was compared. This is NOT a pass.'),
    true,
  );
  check(
    'CONTROL: ...and invents no divergence it did not find',
    nothingPrinted.includes('DIVERGENCE'),
    false,
  );
}

// ---------------------------------------------------------------------------
// 5. VACUITY GUARDS. An empty comparison must not render as a clean one (#63).
// ---------------------------------------------------------------------------
{
  const empty = fixture({ packages: { secret: true } }); // every workspace private
  const r = await checkLive({ rootDir: empty, readState: reader({ releases: [], registry: {}, unreadable: [] }) });
  check('vacuity: no public packages is CANNOT CHECK, not a clean run', r.code, EXIT_CANNOT_CHECK);

  const noBaseline = fixture({ baseline: null });
  const ok = await checkLive({
    rootDir: noBaseline,
    readState: reader({ releases: [], registry: { '@askturret/mcp-core': { versions: {}, absent: false }, '@askturret/mcp-cli': { versions: {}, absent: false } }, unreadable: [] }),
  });
  check('vacuity: an ABSENT baseline file is fine — it means no declared exceptions', ok.code, EXIT_OK);

  const badBaseline = mkdtempSync(join(tmpdir(), 'reconcile-bad-'));
  tmpDirs.push(badBaseline);
  mkdirSync(join(badBaseline, 'packages', 'core'), { recursive: true });
  writeFileSync(
    join(badBaseline, 'packages', 'core', 'package.json'),
    JSON.stringify({ name: '@askturret/mcp-core', version: '0.0.0' }),
  );
  mkdirSync(join(badBaseline, '.github'), { recursive: true });
  writeFileSync(join(badBaseline, '.github', 'release-registry-baseline.json'), '{ not json');
  const bad = await checkLive({ rootDir: badBaseline, readState: reader({ releases: [], registry: {}, unreadable: [] }) });
  check('vacuity: an UNPARSEABLE baseline is CANNOT CHECK, not "no exceptions"', bad.code, EXIT_CANNOT_CHECK);
}

// ---------------------------------------------------------------------------
// 6. Attestation is reported per version and never affects the exit code.
// ---------------------------------------------------------------------------
{
  const dir = fixture();
  const r = await checkLive({
    rootDir: dir,
    readState: reader({
      releases: [{ tag: 'v0.1.1' }],
      registry: {
        '@askturret/mcp-core': { versions: { '0.1.1': v(false) }, absent: false },
        '@askturret/mcp-cli': { versions: { '0.1.1': v(true) }, absent: false },
      },
      unreadable: [],
    }),
  });
  check('attestation: an unattested version does NOT redden the run', r.code, EXIT_OK);
  check(
    'attestation: ...but it is reported, so it is distinguishable from an automated one',
    r.attestations.includes('@askturret/mcp-core@0.1.1: provenance ABSENT') &&
      r.attestations.includes('@askturret/mcp-cli@0.1.1: provenance PRESENT'),
    true,
  );
}

// ---------------------------------------------------------------------------
// 7. Units.
// ---------------------------------------------------------------------------
{
  check('tag: v1.2.3 names 1.2.3', versionOfTag('v1.2.3'), '1.2.3');
  check('tag: a prerelease tag is still a version', versionOfTag('v1.2.3-rc.1'), '1.2.3-rc.1');
  check('tag: a non-release tag names nothing', versionOfTag('operum-attachments'), null);
  check('tag: a bare number is not a release tag', versionOfTag('1.2.3'), null);

  const dir = fixture({ packages: { core: false, secret: true } });
  check('discover: private workspaces are excluded', discoverPublicPackages(dir).packages.join(','), '@askturret/mcp-core');
}

// ---------------------------------------------------------------------------
// 8. THE CONTROL. Everything above asserts the reconciler FAILS on something.
//    Without this, all of it is satisfied by a reconciler that refuses
//    everything — the same trap the #593 measurement needed a positive control
//    for.
// ---------------------------------------------------------------------------
{
  const agreeing = reconcile({
    releases: [{ tag: 'v0.1.1' }],
    registry: {
      '@askturret/mcp-core': { versions: { '0.1.1': v() }, absent: false },
      '@askturret/mcp-cli': { versions: { '0.1.1': v() }, absent: false },
    },
    packages: ['@askturret/mcp-core', '@askturret/mcp-cli'],
  });
  check('CONTROL: a fully reconciled state produces NO divergence', agreeing.divergences.length, 0);
  check('CONTROL: ...and no cannot-check', agreeing.cannotCheck.length, 0);
}

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
