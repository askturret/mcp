#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The Express version under test is the one the adapter actually resolves (#705).
 *
 * `packages/adapters-express` declares `peerDependencies.express` as
 * `^4.18.0 || ^5.0.0` — it CLAIMS both majors. CI installs whichever one the
 * lockfile resolves, so until the matrix landed, one of the two claimed
 * configurations was never executed. The matrix runs the suite twice; this
 * guard is what makes each leg mean something.
 *
 * ## Why a guard rather than trusting the install step
 *
 * Because "express 5 is installed" and "the adapter resolves express 5" are
 * different facts, and this repository has already been bitten by the gap
 * between them. The #585 analysis found a tree with express 5 at the workspace
 * ROOT while `packages/adapters-express` still resolved its own nested
 * `express@4.22.2` — a devDependency of `^4.18.0` is enough to make npm nest a
 * private copy, which then shadows the hoisted one for that package only.
 *
 * That failure is SILENT and it is worse than no leg at all: the job is named
 * `express-5`, it installs express 5, it goes green, and it tested express 4.
 * A leg that reports a version it did not exercise is a false coverage claim,
 * which is the #110/#121 family this repository keeps rediscovering.
 *
 * Resolution is therefore ASSERTED, from the adapter's own directory, using
 * Node's real resolver — not inferred from the install command's exit code and
 * not read off the lockfile. The install step says what was requested; this
 * says what a `require('express')` inside the adapter will actually load.
 *
 * ## Why it runs on BOTH legs, including express 4
 *
 * The express-4 leg is the one nobody would think to check, which is exactly
 * why it is checked. If a future change hoists express 5 to the root, the
 * express-4 leg starts testing express 5 while still reporting `express-4`.
 * The drift is symmetric, so the assertion is too.
 *
 * ## Why the peer range is cross-checked
 *
 * A leg that tests a major the adapter no longer claims is testing a
 * configuration we do not ship, and it would keep passing forever without
 * anyone noticing the claim had narrowed. Asserting `expectedMajor` against
 * the declared range ties the instrument to the claim it measures.
 *
 * Exit codes:
 *   0 - the adapter resolves the expected Express major
 *   1 - it resolves a DIFFERENT major, or that major is not declared as a peer
 *   2 - the check could not be performed (bad argument, missing manifest,
 *       express not installed, unparseable version or peer range)
 *
 * Exit 2 is a FAILURE, not a pass. "I could not check" must never read as
 * "it passed" — the rule this repository applies everywhere else.
 *
 * Run: node .github/scripts/check-express-resolution.mjs <expectedMajor> [repoRoot]
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute, resolve as resolvePath } from 'node:path';

const ADAPTER_DIR = join('packages', 'adapters-express');

function cannotCheck(message) {
  console.error(`check-express-resolution: CANNOT CHECK — ${message}`);
  console.error('Refusing to report success: an unverifiable guard is not a passing guard.');
  process.exit(2);
}

const expectedRaw = process.argv[2];
const root = process.argv[3] ?? '.';

if (expectedRaw === undefined) {
  cannotCheck(
    'no expected Express major given. Usage: check-express-resolution.mjs <expectedMajor> [repoRoot]',
  );
}
if (!/^\d+$/.test(expectedRaw)) {
  cannotCheck(`expected Express major must be a bare integer, got ${JSON.stringify(expectedRaw)}`);
}
const expectedMajor = Number(expectedRaw);

const manifestPath = resolvePath(join(root, ADAPTER_DIR, 'package.json'));
if (!existsSync(manifestPath)) {
  cannotCheck(`no adapter manifest at ${manifestPath}`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  cannotCheck(`adapter manifest is not readable JSON (${manifestPath}): ${err.message}`);
}

// ---------------------------------------------------------------------------
// 1. The major under test must be one the adapter actually claims.
// ---------------------------------------------------------------------------

const peerRange = manifest.peerDependencies?.express;
if (typeof peerRange !== 'string' || peerRange.trim() === '') {
  cannotCheck(`${ADAPTER_DIR} declares no peerDependencies.express to check the leg against`);
}

// Only the caret-comparator shape this manifest actually uses. A range written
// some other way (`>=4 <6`, `4.x`) is NOT silently accepted as "no majors
// found" — that would let the cross-check pass by matching nothing, which is
// the decorative-guard shape. It exits 2 instead, naming the range.
const declaredMajors = [...peerRange.matchAll(/\^(\d+)\./g)].map((m) => Number(m[1]));
if (declaredMajors.length === 0) {
  cannotCheck(
    `cannot read majors out of peerDependencies.express = ${JSON.stringify(peerRange)}. ` +
      'This guard understands caret comparators (`^4.18.0 || ^5.0.0`) only — teach it the ' +
      'new shape rather than loosening it to match nothing.',
  );
}

if (!declaredMajors.includes(expectedMajor)) {
  console.error(
    `Express ${expectedMajor} is under test, but ${ADAPTER_DIR} does not declare it.\n`,
  );
  console.error(`  peerDependencies.express = ${peerRange}`);
  console.error(`  declared majors          = ${declaredMajors.join(', ')}`);
  console.error(
    [
      '',
      'A leg that tests a major the adapter no longer claims is measuring a',
      'configuration we do not ship, and it would keep passing indefinitely.',
      '',
      'Remedy: either restore the major to the peer range, or drop its leg from',
      'the `express` matrix in .github/workflows/test.yml. The matrix and the',
      'peer range are two statements of the same claim and must agree.',
    ].join('\n'),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. What the adapter actually resolves.
// ---------------------------------------------------------------------------

let expressManifestPath;
try {
  expressManifestPath = createRequire(manifestPath).resolve('express/package.json');
} catch (err) {
  cannotCheck(
    `express is not resolvable from ${ADAPTER_DIR} (${err.code ?? err.message}). ` +
      'The install step for this leg did not put it where the adapter can see it.',
  );
}

let installedVersion;
try {
  installedVersion = JSON.parse(readFileSync(expressManifestPath, 'utf8')).version;
} catch (err) {
  cannotCheck(`express manifest at ${expressManifestPath} is not readable JSON: ${err.message}`);
}

const versionMatch = /^(\d+)\./.exec(String(installedVersion ?? ''));
if (!versionMatch) {
  cannotCheck(
    `cannot read a major out of the resolved express version ${JSON.stringify(installedVersion)}`,
  );
}
const installedMajor = Number(versionMatch[1]);

const shown = isAbsolute(expressManifestPath)
  ? relative(resolvePath(root), expressManifestPath)
  : expressManifestPath;

if (installedMajor !== expectedMajor) {
  console.error(
    `Express version mismatch: this leg tests express ${expectedMajor}, but ` +
      `${ADAPTER_DIR} resolves express ${installedVersion}.\n`,
  );
  console.error(`  resolved from : ${manifestPath}`);
  console.error(`  resolved to   : ${shown}`);
  console.error(
    [
      '',
      'The job would have run its suite against the wrong major while reporting',
      `the leg as express-${expectedMajor} — a green result attesting to a`,
      'configuration that was never executed.',
      '',
      'The usual cause is hoisting, not a missing install (#585): installing a',
      'version at the workspace ROOT leaves the adapter resolving its own nested',
      'copy, because its devDependency pins a different major. Install into the',
      'workspace instead, so the nested copy IS the version under test:',
      '',
      '  npm install express@<range> --workspace=packages/adapters-express --save-dev',
      '',
      'Verify with: node -e "console.log(require.resolve(\'express\'))" run from',
      `${ADAPTER_DIR} — the path must sit under that package, not the root.`,
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  `Express ${installedVersion} resolves from ${ADAPTER_DIR} (major ${installedMajor}, as the ` +
    `express-${expectedMajor} leg requires)`,
);
console.log(`  resolved to: ${shown}`);
console.log(`  declared as: peerDependencies.express = ${peerRange}`);
