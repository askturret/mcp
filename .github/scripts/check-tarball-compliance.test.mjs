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
  findRelativeLinks,
  findManifestMetadataIssues,
  findRootPublishGuardIssues,
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

/** A README carrying no repository-relative link — the compliant default (#596). */
const CLEAN_README = '# pkg\n\nSee the [main README](https://github.com/askturret/mcp#readme).\n';

/**
 * A throwaway workspace tree.
 *
 * Every package also gets a README on disk: since #596 the guard reads the
 * content of the README the pack list says ships, so a fixture without one is
 * a cannot-check rather than the case under test.
 */
function fixture(packages, readmes = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tarball-compliance-'));
  tmpDirs.push(dir);
  // Since #591 the guard also reads the ROOT manifest, so a fixture without one
  // is a cannot-check rather than the case under test — the same reason each
  // package gets a README. The root-guard cases below build their own roots
  // deliberately, to exercise the failing arms.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@fixture/root', private: true, scripts: { prepublishOnly: 'node -e "process.exit(1)"' } }, null, 2),
  );
  for (const [name, manifest] of Object.entries(packages)) {
    const pkgDir = join(dir, 'packages', name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(pkgDir, 'README.md'), readmes[name] ?? CLEAN_README);
  }
  return dir;
}

/** A fully compliant public manifest for a package living at packages/<dirName>. */
function publicManifest(dirName, name = '@scope/pkg') {
  return {
    name,
    keywords: ['a'],
    files: ['dist', 'README.md', 'LICENSE', 'NOTICE'],
    repository: { type: 'git', url: 'https://github.com/askturret/mcp.git', directory: `packages/${dirName}` },
    homepage: 'https://github.com/askturret/mcp#readme',
    bugs: { url: 'https://github.com/askturret/mcp/issues' },
  };
}

const PUBLIC_MANIFEST = publicManifest('pkg');

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
  const dir = fixture({ a: publicManifest('a', '@scope/a'), b: publicManifest('b', '@scope/b') });
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
// #596 — LINK CLASSIFICATION.
//
// The discriminator is "does this target resolve on a page with no repository
// context", so both directions are asserted: an over-strict rule that rejected
// anchors would redden the cli README, which is correct today.
// ---------------------------------------------------------------------------
{
  check('an https link is accepted', findRelativeLinks('[a](https://example.com/x)').length, 0);
  check('an http link is accepted', findRelativeLinks('[a](http://example.com)').length, 0);
  check('a mailto link is accepted', findRelativeLinks('[a](mailto:x@example.com)').length, 0);
  check('an intra-document anchor is accepted', findRelativeLinks('[a](#a-section)').length, 0);
  check('a link with a title is accepted', findRelativeLinks('[a](https://example.com "T")').length, 0);

  check('the #596 link itself is rejected', findRelativeLinks('[main README](../../README.md)')[0], '../../README.md');
  check('a same-directory relative link is rejected', findRelativeLinks('[a](./docs/x.md)')[0], './docs/x.md');
  check('a bare relative path is rejected', findRelativeLinks('[a](docs/x.md)')[0], 'docs/x.md');
  check('a relative directory link is rejected', findRelativeLinks('[a](../../examples/x)')[0], '../../examples/x');
  check('a relative IMAGE is rejected too', findRelativeLinks('![img](../../logo.png)')[0], '../../logo.png');
  check(
    'a reference-style definition is scanned, not just inline links',
    findRelativeLinks('[label]: ../../README.md')[0],
    '../../README.md',
  );
  check('every offender is reported, not just the first', findRelativeLinks('[a](../x)\n[b](../y)').length, 2);
}

// ---------------------------------------------------------------------------
// #596 — MANIFEST METADATA. One case per field, so a check that only ever
// looked for `repository` cannot pass this block.
// ---------------------------------------------------------------------------
{
  const ok = publicManifest('core');
  check('a complete manifest raises nothing', findManifestMetadataIssues(ok, 'packages/core').length, 0);

  const noRepo = { ...ok };
  delete noRepo.repository;
  check('a manifest with no repository is flagged', findManifestMetadataIssues(noRepo, 'packages/core').length, 1);

  const noDir = { ...ok, repository: { type: 'git', url: 'https://github.com/askturret/mcp.git' } };
  check('a repository with no directory is flagged', findManifestMetadataIssues(noDir, 'packages/core').length, 1);

  // The copy-paste case: nine manifests gain this field at once and one keeps
  // its neighbour's directory. Present, well-formed, and pointing at the wrong
  // source — invisible to a presence-only check.
  const wrongDir = { ...ok, repository: { ...ok.repository, directory: 'packages/transports' } };
  const wrong = findManifestMetadataIssues(wrongDir, 'packages/core');
  check('a repository.directory naming ANOTHER package is flagged', wrong.length, 1);
  // String(... ?? '') rather than wrong[0].includes: when a mutation removes the
  // branch, wrong[0] is undefined and a bare .includes THROWS, aborting the run
  // before the summary. A witness must report a failure, not become one.
  const wrongMsg = String(wrong[0] ?? '');
  check('...and the message names both directories', wrongMsg.includes('packages/transports') && wrongMsg.includes('packages/core'), true);

  const noHomepage = { ...ok };
  delete noHomepage.homepage;
  check('a manifest with no homepage is flagged', findManifestMetadataIssues(noHomepage, 'packages/core').length, 1);

  const noBugs = { ...ok };
  delete noBugs.bugs;
  check('a manifest with no bugs.url is flagged', findManifestMetadataIssues(noBugs, 'packages/core').length, 1);

  const emptyUrl = { ...ok, repository: { ...ok.repository, url: '' } };
  check('an empty repository url is flagged, not accepted as present', findManifestMetadataIssues(emptyUrl, 'packages/core').length, 1);
}

// ---------------------------------------------------------------------------
// #596 — THROUGH main(). The unit checks above prove the predicates; these
// prove they are actually WIRED to the exit code.
// ---------------------------------------------------------------------------
{
  const dir = fixture({ pkg: PUBLIC_MANIFEST }, { pkg: '# pkg\n\nSee the [main README](../../README.md).\n' });
  const r = silently(() => main(['node', GUARD, dir], runnerWithFiles(COMPLIANT)));
  check('#596 regression: a shipped README with a relative link exits 1', r.code, EXIT_DIVERGENCE);
  check('...and names the offending target', r.out.includes('../../README.md'), true);
  check('...and says it resolves to nothing on the npm page', r.out.includes('resolves to nothing on the npm page'), true);
}

{
  const noRepo = { ...PUBLIC_MANIFEST };
  delete noRepo.repository;
  const dir = fixture({ pkg: noRepo });
  const r = silently(() => main(['node', GUARD, dir], runnerWithFiles(COMPLIANT)));
  check('#596 regression: a manifest with no repository exits 1', r.code, EXIT_DIVERGENCE);
  check('...and explains npm renders no Repository link', r.out.includes('no Repository link'), true);
}

// The ORDER that keeps the content check honest: a README the tarball does not
// carry is a divergence, and its content is never consulted. Reading it anyway
// would answer a question about a file nobody receives.
{
  const dir = fixture({ pkg: PUBLIC_MANIFEST }, { pkg: '# pkg\n\n[x](../../README.md)\n' });
  const withoutReadme = COMPLIANT.filter((f) => f !== 'README.md');
  const r = silently(() => main(['node', GUARD, dir], runnerWithFiles(withoutReadme)));
  check('a README absent from the tarball is a divergence', r.code, EXIT_DIVERGENCE);
  check('...reported as the missing file', r.out.includes('README.md is NOT in the published tarball'), true);
  check('...and its content is NOT reported as a link issue', r.out.includes('resolves to nothing'), false);
}

// A packed README that cannot be read is cannot-check, never a silent pass.
{
  const dir = fixture({ pkg: PUBLIC_MANIFEST });
  rmSync(join(dir, 'packages', 'pkg', 'README.md'));
  const r = silently(() => main(['node', GUARD, dir], runnerWithFiles(COMPLIANT)));
  check('a packed README that cannot be read exits 2, not 0', r.code, EXIT_CANNOT_CHECK);
  check('...and says its links were NOT checked', r.out.includes('links were NOT checked'), true);
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

    // #596's own RED-on-revert pair. These bite on the real tree, need neither
    // npm nor a build, and go red the moment either half of the fix is undone.
    // Compared as joined strings rather than arrays: `check` is ===, so an
    // array comparison would be reference equality and could never pass. The
    // join also puts the actual offenders in the failure message.
    check(`${pkg.name}: manifest carries repository/homepage/bugs`, findManifestMetadataIssues(manifest, pkg.dir).join(' | '), '');

    const readme = readFileSync(join(REPO_ROOT, pkg.dir, 'README.md'), 'utf-8');
    check(`${pkg.name}: README has no repository-relative link`, findRelativeLinks(readme).join(' | '), '');
  }
}

// ---------------------------------------------------------------------------
// THE ROOT MUST REFUSE TO PUBLISH (#591)
//
// Two properties, and the second exists because the first is not sufficient:
// npm gates its private check on `workspace && manifest.private`, so a bare
// root publish never reaches it. Measured on npm 11.8.0 with `private: true`
// set: `npm publish --dry-run` at the root packed all 909 files and exited 0.
//
// Driven against FIXTURE roots rather than the real one, so each arm is
// exercised in both directions. The real repository is asserted separately
// below — a guard that only ever sees a passing tree has not been shown able
// to fail.
// ---------------------------------------------------------------------------
{
  const rootFixture = (manifest) => {
    const dir = mkdtempSync(join(tmpdir(), 'root-guard-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
    return dir;
  };

  const compliant = { name: '@x/root', private: true, scripts: { prepublishOnly: 'node -e "process.exit(1)"' } };

  check('root guard: a compliant root produces no errors', findRootPublishGuardIssues(rootFixture(compliant)).errors.length, 0);

  const noPrivate = findRootPublishGuardIssues(rootFixture({ ...compliant, private: undefined }));
  check('root guard: a root WITHOUT private:true is a divergence', noPrivate.errors.length, 1);
  check('root guard: ...and the message names what would be shipped', noPrivate.errors[0].includes('entire repository'), true);

  const privateFalse = findRootPublishGuardIssues(rootFixture({ ...compliant, private: false }));
  check('root guard: private:false is refused as firmly as an absent field', privateFalse.errors.length, 1);

  const noScript = findRootPublishGuardIssues(rootFixture({ ...compliant, scripts: {} }));
  check('root guard: a root without prepublishOnly is a divergence', noScript.errors.length, 1);
  check(
    'root guard: ...and the message says WHY private:true is not enough',
    noScript.errors[0].includes('workspace && manifest.private'),
    true,
  );

  const empty = findRootPublishGuardIssues(rootFixture({ ...compliant, scripts: { prepublishOnly: '   ' } }));
  check('root guard: a blank prepublishOnly does not satisfy it', empty.errors.length, 1);

  const neither = findRootPublishGuardIssues(rootFixture({ name: '@x/root' }));
  check('root guard: both missing reports BOTH, not just the first', neither.errors.length, 2);

  const missing = findRootPublishGuardIssues(mkdtempSync(join(tmpdir(), 'root-guard-absent-')));
  check('root guard: an absent root manifest is CANNOT CHECK, not a pass', missing.cannotCheck.length, 1);
  check('root guard: ...and reports no divergence it could not have established', missing.errors.length, 0);

  // THE REAL REPOSITORY, which is the property that actually protects it.
  check('root guard: the real repository root refuses to publish', findRootPublishGuardIssues(REPO_ROOT).errors.join(' | '), '');
}


for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
