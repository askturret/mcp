#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the compatibility-contract watcher (#612).
 *
 * The point of this guard is that it RE-DERIVES rather than trusts, so the
 * assertions below are organised around the ways a re-derivation can quietly
 * stop deriving anything:
 *
 *   - an entry with no `source` is SKIPPED rather than failed (check A), which
 *     would make coverage opt-in — the exact failure #612 is about, reproduced
 *     one level down inside its own fix
 *   - the walk finds nothing and every case passes vacuously
 *   - a `source` path resolves to undefined and compares equal to nothing
 *
 * The end-to-end mutations against the pre-#611 contract are reported in the PR
 * rather than committed: they must rewrite `docs/compatibility.{md,json}`, and a
 * killed run would leave the published contract mutated on disk.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  main,
  resolveSource,
  declaredEntries,
  versionBearingRows,
  majorsNamedBy,
  installedVersion,
  discoverPublicPackages,
  EXIT_OK,
  EXIT_DIVERGENCE,
  EXIT_CANNOT_CHECK,
} from './check-compatibility-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

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

function silently(fn) {
  const log = console.log;
  const error = console.error;
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { code: fn(), out: out.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** A throwaway repo root carrying a contract, a rendering and a lockfile. */
function fixture({ contract, md = '', lock = { packages: {} }, packages = {}, rootManifest = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-contract-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'compatibility.json'), JSON.stringify(contract, null, 2));
  writeFileSync(join(dir, 'docs', 'compatibility.md'), md);
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));
  // `rootManifest` lets an adapter fixture supply the peer range its `source`
  // points at — without it check B reports cannot-check and the row-level
  // assertion under test never runs.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', engines: { node: '>=20.0.0' }, ...rootManifest }, null, 2),
  );
  for (const [name, manifest] of Object.entries(packages)) {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    writeFileSync(join(dir, 'packages', name, 'package.json'), JSON.stringify(manifest, null, 2));
  }
  return dir;
}

const run = (dir) => silently(() => main(['node', 'guard', dir]));

// ---------------------------------------------------------------------------
// resolveSource — the addressing scheme. Bracket syntax is not cosmetic: npm
// package names contain dots and slashes, so a dotted path alone cannot address
// `peerDependencies["@modelcontextprotocol/sdk"]`, which is the SDK row itself.
// ---------------------------------------------------------------------------
{
  check('a dotted path resolves', resolveSource(REPO_ROOT, 'package.json#engines.node').value, '>=20.0.0');
  check(
    'a bracketed key containing dots and slashes resolves',
    resolveSource(REPO_ROOT, 'package.json#peerDependencies["@modelcontextprotocol/sdk"]').value,
    '^1.24.0',
  );
  check(
    'single quotes work too',
    resolveSource(REPO_ROOT, "package.json#peerDependencies['@modelcontextprotocol/sdk']").value,
    '^1.24.0',
  );

  // Each failure is DISTINCT, because "you pointed at a missing file" and "you
  // pointed at a missing key" need different fixes.
  check('a source with no # is an error', resolveSource(REPO_ROOT, 'package.json').error !== undefined, true);
  check('a missing file is an error', resolveSource(REPO_ROOT, 'nope.json#a').error !== undefined, true);
  check('a missing path is an error', resolveSource(REPO_ROOT, 'package.json#engines.nope').error !== undefined, true);
  check('a non-string source is an error', resolveSource(REPO_ROOT, null).error !== undefined, true);

  // The trap this avoids: a path that resolves to undefined would compare equal
  // to an absent `declared` and report agreement between two nothings.
  check('a missing path never returns a value', 'value' in resolveSource(REPO_ROOT, 'package.json#engines.nope'), false);
}

// ---------------------------------------------------------------------------
// declaredEntries — the walk. If this returns nothing, everything downstream
// passes vacuously, which is how a check rots into decoration.
// ---------------------------------------------------------------------------
{
  const real = declaredEntries(JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'compatibility.json'), 'utf-8')));
  check('the real contract has declared entries', real.length > 0, true);
  check('every real entry now carries a source', real.every((e) => typeof e.source === 'string'), true);
  check('the sdk entry is found by the walk', real.some((e) => e.path === 'protocol.mcp.sdk'), true);

  check('a contract with no declared entries yields none', declaredEntries({ a: { b: 1 } }).length, 0);
  check('nested declared entries are found', declaredEntries({ x: { y: { declared: '^1', source: 's' } } })[0].path, 'x.y');
}

// ---------------------------------------------------------------------------
// installedVersion — what CI actually installs.
// ---------------------------------------------------------------------------
{
  const lock = { packages: { 'node_modules/@scope/pkg': { version: '1.2.3' } } };
  check('reads the installed version', installedVersion(lock, '@scope/pkg'), '1.2.3');
  check('an absent package is null, not undefined-as-equal', installedVersion(lock, '@scope/other'), null);
  check('a malformed lockfile is null', installedVersion({}, '@scope/pkg'), null);
}

// ---------------------------------------------------------------------------
// CHECK A — the one that keeps the rest honest. A `declared` with no `source`
// must FAIL, never be skipped. Skipping is how coverage silently becomes the
// set of entries somebody remembered to annotate.
// ---------------------------------------------------------------------------
{
  const dir = fixture({ contract: { runtime: { node: { declared: '>=20.0.0' } } }, md: '>=20.0.0' });
  const r = run(dir);
  check('a declared entry with NO source FAILS', r.code, EXIT_DIVERGENCE);
  check('...and says it would otherwise be covered by nothing', r.out.includes('covered by nothing'), true);
}

// ---------------------------------------------------------------------------
// CHECK B — declared vs the code. The #612 case.
// ---------------------------------------------------------------------------
{
  const contract = { runtime: { node: { declared: '>=18.0.0', source: 'package.json#engines.node' } } };
  const r = run(fixture({ contract, md: '>=18.0.0' }));
  check('declared disagreeing with the manifest FAILS', r.code, EXIT_DIVERGENCE);
  check('...and quotes both sides', r.out.includes("'>=18.0.0'") && r.out.includes("'>=20.0.0'"), true);

  const agreeing = { runtime: { node: { declared: '>=20.0.0', source: 'package.json#engines.node' } } };
  check('declared agreeing passes', run(fixture({ contract: agreeing, md: '>=20.0.0' })).code, EXIT_OK);
}

// ---------------------------------------------------------------------------
// CHECK C — tested vs what the lockfile installs. "Supported" is defined by
// both files as exercised by CI, and CI installs the lockfile.
// ---------------------------------------------------------------------------
{
  const base = (tested) => ({
    runtime: { node: { declared: '>=20.0.0', source: 'package.json#engines.node' } },
    protocol: { sdk: { declared: '>=20.0.0', source: 'package.json#engines.node', package: '@scope/sdk', tested } },
  });
  const lock = { packages: { 'node_modules/@scope/sdk': { version: '2.0.0' } } };

  const bad = run(fixture({ contract: base('1.0.0'), md: '>=20.0.0 1.0.0', lock }));
  check('tested disagreeing with the lockfile FAILS', bad.code, EXIT_DIVERGENCE);
  check('...and names what CI installs', bad.out.includes("installs '2.0.0'"), true);

  check('tested agreeing passes', run(fixture({ contract: base('2.0.0'), md: '>=20.0.0 2.0.0', lock })).code, EXIT_OK);

  // A `tested` claim with no package name cannot be re-derived at all.
  const noPkg = {
    protocol: { sdk: { declared: '>=20.0.0', source: 'package.json#engines.node', tested: '2.0.0' } },
  };
  check('tested with no package name FAILS', run(fixture({ contract: noPkg, md: '>=20.0.0 2.0.0', lock })).code, EXIT_DIVERGENCE);
}

// ---------------------------------------------------------------------------
// CHECK D — the aspirational species. Do not watch the plan; assert the
// artifact the claim presupposes. `@askturret/mcp/express` sat as Supported
// while the umbrella package returned 404.
// ---------------------------------------------------------------------------
{
  const withAdapter = (entryPoint) => ({
    runtime: { node: { declared: '>=20.0.0', source: 'package.json#engines.node' } },
    // These rows carry verifiedBy so check F is satisfied; these cases are
    // about entry points, not about where a version is derived from.
    adapters: [{ framework: 'express', entryPoint, entries: [{ version: '4.x', status: 'supported', verifiedBy: 'package.json' }] }],
  });
  const packages = { core: { name: '@scope/real-adapter' } };

  const phantom = run(fixture({ contract: withAdapter('@scope/umbrella/express'), md: '>=20.0.0 @scope/umbrella/express', packages }));
  check('a supported row naming an unpublished entry point FAILS', phantom.code, EXIT_DIVERGENCE);
  check('...and says the repository does not publish it', phantom.out.includes('does not publish'), true);

  const real = run(fixture({ contract: withAdapter('@scope/real-adapter'), md: '>=20.0.0 @scope/real-adapter', packages }));
  check('a supported row naming a published package passes', real.code, EXIT_OK);

  // A planned row makes no support claim, so it is not held to this.
  const planned = {
    runtime: { node: { declared: '>=20.0.0', source: 'package.json#engines.node' } },
    adapters: [{ framework: 'fastify', entryPoint: null, entries: [{ version: '5.x', status: 'planned', verifiedBy: 'package.json' }] }],
  };
  check('a planned row is not required to name an entry point', run(fixture({ contract: planned, md: '>=20.0.0', packages })).code, EXIT_OK);
}

// ---------------------------------------------------------------------------
// CHECK E — the two hand-maintained copies. Value presence, not semantics.
//
// The limit is asserted, not merely documented: identical drift in BOTH copies
// is INVISIBLE to E. That is why B and C compare against the CODE instead.
// ---------------------------------------------------------------------------
{
  const contract = {
    matrixVersion: '9.9.9',
    runtime: { node: { declared: '>=20.0.0', source: 'package.json#engines.node' } },
  };

  const drifted = run(fixture({ contract, md: '>=20.0.0' }));
  check('a value in the JSON missing from the .md FAILS', drifted.code, EXIT_DIVERGENCE);
  check('...and names the missing value', drifted.out.includes("'9.9.9'"), true);

  check('both copies agreeing passes', run(fixture({ contract, md: '9.9.9 >=20.0.0' })).code, EXIT_OK);

  // THE STATED LIMIT, PINNED. Both copies say '>=18.0.0'; they agree with each
  // other and disagree with the code. E is silent; B is what fires.
  const synchronised = { runtime: { node: { declared: '>=18.0.0', source: 'package.json#engines.node' } } };
  const both = run(fixture({ contract: synchronised, md: '>=18.0.0' }));
  check('synchronised drift is NOT caught by the cross-check', both.out.includes('does not mention'), false);
  check('...and IS caught by the re-derivation', both.out.includes('package.json#engines.node'), true);
}

// ---------------------------------------------------------------------------
// CANNOT CHECK — never conflated with a pass.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'compat-empty-'));
  tmpDirs.push(dir);
  const r = run(dir);
  check('a tree with no contract is CANNOT CHECK, not OK', r.code, EXIT_CANNOT_CHECK);
  check('...and says nothing was verified', r.out.includes('NOT a pass'), true);

  const empty = run(fixture({ contract: { a: 1 }, md: '' }));
  check('a contract with no declared entries is CANNOT CHECK, not a vacuous pass', empty.code, EXIT_CANNOT_CHECK);
  check('...and says the walk found nothing', empty.out.includes('carries a `declared` value'), true);
}

// ---------------------------------------------------------------------------
// THE REAL CONTRACT — the RED-on-revert assertions for #612 itself.
// ---------------------------------------------------------------------------
{
  const r = run(REPO_ROOT);
  check('the real contract passes its own watcher', r.code, EXIT_OK);
  check('the real repository publishes packages to check entry points against', discoverPublicPackages(REPO_ROOT).size > 0, true);
}

// ---------------------------------------------------------------------------
// #618 — THE OMISSION DOOR, ONE LEVEL DOWN.
//
// Check A stopped a row escaping by omitting `source`. It could not stop a row
// escaping by carrying no `declared` at all, and seven did: four adapter rows
// and three OpenAPI source rows, invisible to A, B and C alike. That is the
// opt-in failure #612 exists to watch, reproducing inside #612's own fix.
// ---------------------------------------------------------------------------
{
  // Row versions are human notation, so containment is by MAJOR. A string
  // comparison against a peer range would fail on day one and be weakened to
  // nothing by the second person to hit it.
  check('a hyphenated range names its major once', [...majorsNamedBy('4.18.x - 4.x')].join(','), '4');
  check('an x-range names its major', [...majorsNamedBy('5.x')].join(','), '5');
  check('a parenthesised note does not confuse it', [...majorsNamedBy('2.0 (Swagger)')].join(','), '2');
  check('a >= range names its major', [...majorsNamedBy('>=5.5')].join(','), '5');
  check('a two-major row names both', [...majorsNamedBy('4.x, 5.x')].sort().join(','), '4,5');
  check('a versionless string names nothing', majorsNamedBy('none').size, 0);
  check('a non-string names nothing rather than throwing', majorsNamedBy(undefined).size, 0);
}

{
  // The walk is what makes previously-invisible rows addressable. Enrolment
  // stops being "has a declared key" and becomes "carries a version".
  const contract = {
    adapters: [{ framework: 'x', source: 's', entries: [{ version: '1.x', status: 'supported' }] }],
    sources: [{ kind: 'y', entries: [{ version: '2.x', status: 'unsupported', verifiedBy: 't' }] }],
  };
  const rows = versionBearingRows(contract);
  check('both rows are found', rows.length, 2);
  check('an adapter row is owned by the adapter, which holds the source', rows[0].owner.source, 's');
  check('a source row carries its own verifiedBy', rows[1].row.verifiedBy, 't');
  check('the row path is reported for the reader', rows[0].path, 'adapters[0].entries[0]');
  check('a contract with no rows yields none', versionBearingRows({ a: 1 }).length, 0);
}

// --- F: a row declaring NEITHER source NOR verifiedBy must FAIL -------------
{
  const contract = {
    runtime: { node: { declared: '>=20.0.0', source: 'package.json#engines.node' } },
    sources: [{ kind: 'openapi', entries: [{ version: '9.9.x', status: 'supported' }] }],
  };
  const r = run(fixture({ contract, md: '>=20.0.0' }));
  check('a version-bearing row with neither source nor verifiedBy FAILS', r.code, EXIT_DIVERGENCE);
  check('...and says it is invisible to every check', r.out.includes('invisible to every check'), true);
}

// --- H: a verifiedBy naming a file that does not exist must FAIL -----------
{
  const contract = {
    runtime: { node: { declared: '>=20.0.0', source: 'package.json#engines.node' } },
    sources: [{ kind: 'openapi', entries: [{ version: '3.0.x', status: 'supported', verifiedBy: 'nope/gone.test.ts' }] }],
  };
  const r = run(fixture({ contract, md: '>=20.0.0' }));
  check('a verifiedBy pointing at a missing test FAILS', r.code, EXIT_DIVERGENCE);
  check('...and says a row pointing at a missing test is not verified', r.out.includes('is not a verified row'), true);

  // The paired positive: an existing file passes, so this is not "always red".
  const ok = {
    runtime: { node: { declared: '>=20.0.0', source: 'package.json#engines.node' } },
    sources: [{ kind: 'openapi', entries: [{ version: '3.0.x', status: 'supported', verifiedBy: 'package.json' }] }],
  };
  check('a verifiedBy naming a file that exists passes', run(fixture({ contract: ok, md: '>=20.0.0' })).code, EXIT_OK);
}

// --- G: a supported row must cover the version CI actually installs ---------
//
// THE ASSERTION WITH THE DEADLINE. #585 upgrades express 4.22.2 -> 5.2.1. This
// fixture is synthetic on purpose: if it relied on the live upgrade to
// demonstrate the check fires, the check would be remembered rather than
// witnessed, and only once.
{
  const adapterContract = (rowVersion) => ({
    runtime: { node: { declared: '>=20.0.0', source: 'package.json#engines.node' } },
    adapters: [
      {
        framework: 'express',
        entryPoint: '@scope/adapters-express',
        declared: '^4.18.0 || ^5.0.0',
        source: 'package.json#peerDependencies.express',
        entries: [{ version: rowVersion, status: 'supported' }],
      },
    ],
  });
  const lockWith = (v) => ({ packages: { 'node_modules/express': { version: v } } });
  const packages = { ex: { name: '@scope/adapters-express' } };
  const md = '>=20.0.0 ^4.18.0 || ^5.0.0 @scope/adapters-express';
  const rootManifest = { peerDependencies: { express: '^4.18.0 || ^5.0.0' } };

  // Baseline: the row covers what the lockfile installs.
  check(
    'a supported row covering the installed major passes',
    run(fixture({ contract: adapterContract('4.18.x - 4.x'), md, lock: lockWith('4.22.2'), packages, rootManifest })).code,
    EXIT_OK,
  );

  // #585, simulated. The lockfile moves to express 5 and nobody edits the row.
  const upgraded = run(fixture({ contract: adapterContract('4.18.x - 4.x'), md, lock: lockWith('5.2.1'), packages, rootManifest }));
  check('#585 simulated: express 5 installed against a 4.x supported row FAILS', upgraded.code, EXIT_DIVERGENCE);
  check('...and names both what CI installs and what the row claims', upgraded.out.includes('5.2.1') && upgraded.out.includes('4.18.x - 4.x'), true);

  // QA's probe 1, as filed.
  const probe = run(fixture({ contract: adapterContract('99.x'), md, lock: lockWith('4.22.2'), packages, rootManifest }));
  check("QA probe 1: a supported row of '99.x' against installed 4.22.2 FAILS", probe.code, EXIT_DIVERGENCE);

  // An adapter whose package is absent from the lockfile is cannot-check, not a
  // pass — the row was not verified either way.
  const noLock = run(fixture({ contract: adapterContract('4.18.x - 4.x'), md, lock: { packages: {} }, packages, rootManifest }));
  check('an adapter missing from the lockfile is CANNOT CHECK, not OK', noLock.code, EXIT_CANNOT_CHECK);
}

// --- the real contract: every version-bearing row is covered ----------------
{
  const contract = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'compatibility.json'), 'utf-8'));
  const rows = versionBearingRows(contract);

  check('the real contract has version-bearing rows', rows.length > 0, true);
  const uncovered = rows.filter(
    ({ row, owner }) =>
      !(owner && typeof owner.source === 'string') && typeof row.verifiedBy !== 'string',
  );
  check(
    'every version-bearing row in the real contract declares how it is verified',
    uncovered.map((u) => u.path).join(' | '),
    '',
  );
}

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
