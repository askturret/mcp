#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the tarball compliance guard (#583).
 *
 * THE ARM THAT MATTERS HERE IS CANNOT-CHECK. The guard this replaced exited 0
 * green while every tarball was missing NOTICE, so "the guard said yes" was
 * worth nothing. Every route to a verdict is therefore witnessed:
 *
 *   exit 0  a packed list carrying all three required entries
 *   exit 1  DIVERGENCE — a required entry absent from the packed list
 *   exit 2  CANNOT CHECK — five distinct causes, each asserted apart, because
 *           "npm is missing" and "npm ran and said nothing" are different facts
 *
 * TWO SEAMS, DELIBERATELY.
 *   - An INJECTED runner drives the verdict logic in-process: fast, and it can
 *     produce npm failures that are awkward to arrange for real.
 *   - A FAKE npm ON PATH drives the guard's OWN spawn through its real entry
 *     point in a subprocess. The injected runner cannot witness
 *     `process.exit(main(process.argv))`, and that line is what CI depends on —
 *     #110's shape, which this repository keeps rediscovering.
 *
 * AND ONE ASSERTION AGAINST THE REAL MANIFESTS, at the end: every public
 * package's `files` array must name NOTICE. That is the assertion that goes RED
 * if #583's fix is reverted, and it is fast enough to run everywhere. The
 * packed assertion is the authority, but it needs npm and a build; this one
 * needs neither and still bites on the exact regression.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  main,
  packPackage,
  discoverPublicPackages,
  REQUIRED_TARBALL_ENTRIES,
  EXIT_OK,
  EXIT_DIVERGENCE,
  EXIT_CANNOT_CHECK,
} from './check-tarball-compliance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'check-tarball-compliance.mjs');
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

/** A throwaway workspace tree. */
function fixture(packages) {
  const dir = mkdtempSync(join(tmpdir(), 'tarball-compliance-'));
  tmpDirs.push(dir);
  for (const [name, manifest] of Object.entries(packages)) {
    const pkgDir = join(dir, 'packages', name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest, null, 2));
  }
  return dir;
}

const PUBLIC_MANIFEST = { name: '@scope/pkg', keywords: ['a'], files: ['dist', 'README.md', 'LICENSE', 'NOTICE'] };

/** A runner returning a packed list of exactly these paths. */
function runnerWithFiles(paths) {
  return () => ({
    status: 0,
    stdout: JSON.stringify([{ name: '@scope/pkg', files: paths.map((p) => ({ path: p })) }]),
    stderr: '',
  });
}

const COMPLIANT = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'dist/index.js'];

// Quiet the guard's own reporting; these tests assert exit codes, not prose.
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

// ---------------------------------------------------------------------------
// EXIT 0 — the compliant case
// ---------------------------------------------------------------------------
{
  const dir = fixture({ pkg: PUBLIC_MANIFEST });
  const r = silently(() => main(['node', GUARD, dir], runnerWithFiles(COMPLIANT)));
  check('a tarball carrying all three required entries exits 0', r.code, EXIT_OK);
}

// ---------------------------------------------------------------------------
// EXIT 1 — divergence. One case per required entry, so a guard that only ever
// looked for one of the three cannot pass this block.
// ---------------------------------------------------------------------------
for (const missing of REQUIRED_TARBALL_ENTRIES) {
  const dir = fixture({ pkg: PUBLIC_MANIFEST });
  const files = COMPLIANT.filter((f) => f !== missing);
  const r = silently(() => main(['node', GUARD, dir], runnerWithFiles(files)));
  check(`a tarball missing ${missing} exits 1`, r.code, EXIT_DIVERGENCE);
  check(`...and names ${missing}`, r.out.includes(missing), true);
}

// THE #583 CASE ITSELF: `files: ["dist"]` with a NOTICE on disk. This is the
// exact state the old guard passed — the tarball npm actually produced before
// this fix, with README and LICENSE present via npm's always-included list and
// NOTICE absent.
{
  const dir = fixture({ pkg: PUBLIC_MANIFEST });
  const r = silently(() =>
    main(['node', GUARD, dir], runnerWithFiles(['package.json', 'README.md', 'LICENSE', 'dist/index.js'])),
  );
  check('#583 regression: README+LICENSE present but NOTICE absent exits 1', r.code, EXIT_DIVERGENCE);
  check('...and says NOTICE is not in the published tarball', r.out.includes('NOTICE is NOT in the published tarball'), true);
}

// ---------------------------------------------------------------------------
// EXIT 2 — cannot check. Five causes, asserted apart.
// ---------------------------------------------------------------------------
{
  const dir = fixture({ pkg: PUBLIC_MANIFEST });
  const cases = [
    ['npm cannot be started', () => ({ error: Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }) })],
    ['npm pack exits non-zero', () => ({ status: 1, stdout: '', stderr: 'workspace not found' })],
    ['npm pack emits non-JSON', () => ({ status: 0, stdout: 'not json at all', stderr: '' })],
    ['npm pack reports no package entry', () => ({ status: 0, stdout: '[]', stderr: '' })],
    ['npm pack entry carries no file list', () => ({ status: 0, stdout: JSON.stringify([{ name: '@scope/pkg' }]), stderr: '' })],
  ];
  for (const [desc, runner] of cases) {
    const r = silently(() => main(['node', GUARD, dir], runner));
    check(`cannot check: ${desc} exits 2`, r.code, EXIT_CANNOT_CHECK);
    check(`...and says it was NOT verified`, r.out.includes('This is NOT a pass'), true);
  }
}

// An UNBUILT package packs fine and carries the licence files, but its tarball
// is not representative. That is cannot-check, never a pass — "unbuilt" and
// "dist excluded by a bad files array" are indistinguishable from pack output.
{
  const dir = fixture({ pkg: PUBLIC_MANIFEST });
  const r = silently(() => main(['node', GUARD, dir], runnerWithFiles(['package.json', 'README.md', 'LICENSE', 'NOTICE'])));
  check('an unbuilt package (no dist/ entries) exits 2, not 0', r.code, EXIT_CANNOT_CHECK);
  check('...and says the package looks UNBUILT', r.out.includes('UNBUILT'), true);
}

// A tree with no public packages must not be a silent success — "nothing to
// check" and "everything checked out" are different facts.
{
  const dir = fixture({ hidden: { name: '@scope/hidden', private: true, keywords: ['a'] } });
  const r = silently(() => main(['node', GUARD, dir], runnerWithFiles(COMPLIANT)));
  check('a tree with no public packages exits 2, not 0', r.code, EXIT_CANNOT_CHECK);
}

// ---------------------------------------------------------------------------
// PRECEDENCE — divergence outranks cannot-check, and BOTH are still printed.
// Narrowing to one exit code must not narrow the report.
// ---------------------------------------------------------------------------
{
  const dir = fixture({ a: { ...PUBLIC_MANIFEST, name: '@scope/a' }, b: { ...PUBLIC_MANIFEST, name: '@scope/b' } });
  const runner = (_root, pkgName) =>
    pkgName === '@scope/a'
      ? { status: 0, stdout: JSON.stringify([{ name: '@scope/a', files: COMPLIANT.filter((f) => f !== 'NOTICE').map((p) => ({ path: p })) }]), stderr: '' }
      : { error: Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }) };
  const r = silently(() => main(['node', GUARD, dir], runner));
  check('divergence outranks cannot-check', r.code, EXIT_DIVERGENCE);
  check('...but the divergence is still reported', r.out.includes('@scope/a'), true);
  check('...and the cannot-check is still reported', r.out.includes('@scope/b'), true);
}

// ---------------------------------------------------------------------------
// DISCOVERY — private out, public in. A hardcoded list is what goes stale.
// ---------------------------------------------------------------------------
{
  const dir = fixture({
    pub: { name: '@scope/pub', keywords: ['a'], files: ['dist'] },
    priv: { name: '@scope/priv', private: true, keywords: ['a'] },
  });
  const found = discoverPublicPackages(dir).map((p) => p.name);
  check('discovery includes the public package', found.includes('@scope/pub'), true);
  check('discovery excludes the private package', found.includes('@scope/priv'), false);

  const unreadable = fixture({});
  mkdirSync(join(unreadable, 'packages', 'broken'), { recursive: true });
  writeFileSync(join(unreadable, 'packages', 'broken', 'package.json'), '{ this is not json');
  const brokenFound = discoverPublicPackages(unreadable);
  check('an unparseable manifest is surfaced, not silently skipped', brokenFound.length, 1);
  const r = silently(() => main(['node', GUARD, unreadable], runnerWithFiles(COMPLIANT)));
  check('...and makes the guard exit 2', r.code, EXIT_CANNOT_CHECK);
}

// packPackage's own error mapping, exercised directly.
{
  const r = packPackage('.', '@scope/pkg', () => null);
  check('packPackage treats a null runner result as cannot-check', r.ok, false);
}

// ---------------------------------------------------------------------------
// THE REAL ENTRY POINT — a fake npm on PATH, the guard spawned as a FILE.
//
// Everything above injects the runner, so none of it executes the guard's own
// spawnSync('npm', ...) or its `process.exit(main(process.argv))`. Those are
// the lines CI actually runs.
// ---------------------------------------------------------------------------
function withFakeNpm(stdout, exitCode = 0) {
  const binDir = mkdtempSync(join(tmpdir(), 'fake-npm-'));
  tmpDirs.push(binDir);
  const npm = join(binDir, 'npm');
  writeFileSync(npm, `#!/bin/sh\ncat <<'PACKJSON'\n${stdout}\nPACKJSON\nexit ${exitCode}\n`);
  chmodSync(npm, 0o755);
  return binDir;
}

function runGuard(repoRoot, binDir) {
  return spawnSync(process.execPath, [GUARD, repoRoot], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
}

{
  const dir = fixture({ pkg: PUBLIC_MANIFEST });
  const compliantJson = JSON.stringify([{ name: '@scope/pkg', files: COMPLIANT.map((p) => ({ path: p })) }]);
  const r = runGuard(dir, withFakeNpm(compliantJson));
  check('entry point: compliant tarball exits 0 through the real spawn', r.status, EXIT_OK);

  const missingNotice = JSON.stringify([
    { name: '@scope/pkg', files: COMPLIANT.filter((f) => f !== 'NOTICE').map((p) => ({ path: p })) },
  ]);
  const r2 = runGuard(dir, withFakeNpm(missingNotice));
  check('entry point: missing NOTICE exits 1 through the real spawn', r2.status, EXIT_DIVERGENCE);

  const r3 = runGuard(dir, withFakeNpm('', 1));
  check('entry point: a failing npm exits 2 through the real spawn', r3.status, EXIT_CANNOT_CHECK);
}

// An empty PATH is the honest "npm is not installed" case, and it is the one
// the previous attempt on #583 hit and then reasoned around. It must be 2.
{
  const dir = fixture({ pkg: PUBLIC_MANIFEST });
  const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf-8', env: { ...process.env, PATH: '' } });
  check('entry point: npm absent from PATH exits 2, never 0', r.status, EXIT_CANNOT_CHECK);
}

// ---------------------------------------------------------------------------
// THE REAL MANIFESTS — the RED-on-revert assertion for #583 itself.
// ---------------------------------------------------------------------------
{
  const publicPkgs = discoverPublicPackages(REPO_ROOT);
  check('the repository has public packages to check', publicPkgs.length > 0, true);

  for (const pkg of publicPkgs) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pkg.dir, 'package.json'), 'utf-8'));
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    // NOTICE is the load-bearing one: unlike README and LICENSE it is NOT on
    // npm's always-included list, so it ships ONLY because `files` names it.
    check(`${pkg.name}: files[] names NOTICE`, files.includes('NOTICE'), true);
    for (const required of REQUIRED_TARBALL_ENTRIES) {
      check(`${pkg.name}: ${required} exists on disk`, existsSync(join(REPO_ROOT, pkg.dir, required)), true);
    }
  }
}

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
