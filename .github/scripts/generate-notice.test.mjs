#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the NOTICE generator (#456, closing a gap found in #431).
 *
 * Wired into `supply-chain.yml:54` with no self-test at all. In `--check` mode
 * it IS a guard — it fails the build when NOTICE is stale — and what it guards
 * is a licence obligation: Apache-2.0 §4(d) requires redistributing the NOTICE
 * content of bundled dependencies. A silent failure here does not break a
 * build, it ships a compliance problem.
 *
 * Two failure sites, and they are different in kind:
 *
 *   exit 2  the dependency inventory could not be built — CANNOT CHECK
 *   exit 1  NOTICE is stale under --check — a real finding
 *
 * ## What had to change before any of this was testable
 *
 * `main()` was invoked at module scope, so importing this file ran the whole
 * generator as an import side effect — including its `writeFileSync`. A test
 * could not load the module without rewriting the repository's real NOTICE.
 * `generateNotice()` now computes and RETURNS; the caller decides whether to
 * write. That separation is what lets every assertion below run without
 * touching a tracked file.
 *
 * The cannot-check path additionally needs an injectable `inventory`: the real
 * one throws on a broken dependency tree, which no fixture directory can
 * reliably produce (#349's fixture-parameter technique).
 *
 * ## Every failure site here has been observed red
 *
 * Verified mechanically by `check-mutation-audit.mjs`.
 *
 * `CONTROL` marks assertions that pin already-correct behaviour and would
 * survive their site being neutralised — notably the up-to-date and
 * write-suppression cases, which are about what this generator must NOT do.
 *
 * Run: node .github/scripts/generate-notice.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateNotice, noticeTargets, staleNoticeTargets } from './generate-notice.mjs';
import { didNotStart } from './sdk-upgrade-drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const scriptPath = join(here, 'generate-notice.mjs');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check_(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed++;
  }
}

function scratch(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'generate-notice-'));
  tmpDirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

const HEADER = `${'='.repeat(80)}\n`;

/** A fake inventory, so these tests do not depend on what is in node_modules. */
const fakeInventory = (deps) => () => deps;

const dep = (name, over = {}) => ({
  name,
  version: '1.0.0',
  license: 'MIT',
  scope: 'runtime',
  firstParty: false,
  dir: '/nonexistent',
  ...over,
});

function runScript(args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf-8' });
  if (didNotStart(result)) {
    return { cannotCheck: true, why: `never started: ${result.error ? result.error.message : '(none reported)'}` };
  }
  return { cannotCheck: false, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function checkSpawned(desc, run, fn) {
  if (run.cannotCheck) {
    console.log(`FAIL - ${desc} (CANNOT CHECK — ${run.why})`);
    failed++;
    return;
  }
  fn();
}

// ---------------------------------------------------------------------------
// Site 1 — the dependency inventory could not be built  (CANNOT CHECK, exit 2)
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 1 — inventory could not be built (cannot-check)\n');

{
  const dir = scratch({ NOTICE: HEADER });
  const result = generateNotice(dir, {
    inventory: () => {
      throw new Error('ENOENT: no such file or directory, open package.json');
    },
  });

  check_('CANNOT CHECK (2) when the inventory throws', result.code, 2);
  check_('...and says the inventory could not be built', result.message.includes('could not build the dependency inventory'), true);
  check_('...and quotes the underlying error', result.message.includes('ENOENT'), true);
  check_('...and emits a CI annotation', result.message.startsWith('::error::'), true);
}

{
  // The distinction that matters: cannot-check must NOT be reported as
  // up-to-date. A generator that shrugs off a broken inventory and reports
  // success would let a NOTICE go stale invisibly — the #281 shape exactly.
  const dir = scratch({ NOTICE: HEADER });
  const result = generateNotice(dir, {
    checkOnly: true,
    inventory: () => {
      throw new Error('broken tree');
    },
  });
  check_('cannot-check is 2 under --check too, never 0 and never 1', result.code, 2);
  check_('...and proposes no NOTICE content', result.next, '');
  check_('...and reports no dependency count it did not measure', result.runtimeCount, 0);
}

// ---------------------------------------------------------------------------
// Site 2 — NOTICE is stale under --check  (exit 1)
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 2 — stale NOTICE under --check\n');

{
  const dir = scratch({ NOTICE: HEADER });
  const result = generateNotice(dir, {
    checkOnly: true,
    inventory: fakeInventory([dep('left-pad')]),
  });

  check_('FAILS (1) when NOTICE is stale under --check', result.code, 1);
  check_('...and says it is out of date', result.message.includes('out of date'), true);
  check_('...and tells the reader how to regenerate it', result.message.includes('node .github/scripts/generate-notice.mjs'), true);
  check_('...and says why it is a build failure rather than a warning', result.message.includes('licence obligation'), true);
  check_('...and emits a CI annotation', result.message.startsWith('::error::'), true);
  check_('...and marks the content as changed', result.changed, true);
}

{
  // A dependency ADDED since the last regeneration is the real-world way this
  // goes stale, and the case the licence obligation actually turns on.
  const dir = scratch({ NOTICE: HEADER });
  const first = generateNotice(dir, { inventory: fakeInventory([dep('a')]) });
  writeFileSync(join(dir, 'NOTICE'), first.next);

  const afterAdding = generateNotice(dir, {
    checkOnly: true,
    inventory: fakeInventory([dep('a'), dep('b')]),
  });
  check_('FAILS (1) when a new runtime dependency appears', afterAdding.code, 1);
  check_('...and the proposed content names the new dependency', afterAdding.next.includes('b@1.0.0'), true);
}

{
  // Removal is equally a staleness: NOTICE would attribute something no longer
  // shipped, which misstates what is in the package.
  const dir = scratch({ NOTICE: HEADER });
  const first = generateNotice(dir, { inventory: fakeInventory([dep('a'), dep('b')]) });
  writeFileSync(join(dir, 'NOTICE'), first.next);

  const afterRemoving = generateNotice(dir, {
    checkOnly: true,
    inventory: fakeInventory([dep('a')]),
  });
  check_('FAILS (1) when a runtime dependency is removed', afterRemoving.code, 1);
}

// ---------------------------------------------------------------------------
// Up to date, and the scope rules
// ---------------------------------------------------------------------------

console.log('\n# CONTROL: up-to-date and scope\n');

{
  const dir = scratch({ NOTICE: HEADER });
  const first = generateNotice(dir, { inventory: fakeInventory([dep('a')]) });
  writeFileSync(join(dir, 'NOTICE'), first.next);

  const again = generateNotice(dir, { checkOnly: true, inventory: fakeInventory([dep('a')]) });
  check_('CONTROL: an up-to-date NOTICE passes under --check', again.code, 0);
  check_('...and is reported as unchanged', again.changed, false);
  check_('...and says it is up to date', again.message.includes('up to date'), true);

  // Idempotence: regenerating twice must converge, or --check would fail
  // forever on a correctly-generated file.
  const third = generateNotice(dir, { inventory: fakeInventory([dep('a')]) });
  check_('CONTROL: regeneration is idempotent', third.changed, false);
}

{
  const dir = scratch({ NOTICE: HEADER });
  const result = generateNotice(dir, {
    inventory: fakeInventory([dep('shipped'), dep('tooling', { scope: 'dev' })]),
  });
  check_('CONTROL: dev dependencies are excluded', result.next.includes('tooling'), false);
  check_('CONTROL: runtime dependencies are included', result.next.includes('shipped'), true);
  check_('CONTROL: and the count reflects only runtime', result.runtimeCount, 1);
}

{
  const dir = scratch({ NOTICE: HEADER });
  const result = generateNotice(dir, {
    inventory: fakeInventory([dep('ours', { firstParty: true }), dep('theirs')]),
  });
  check_('CONTROL: first-party packages are excluded', result.next.includes('ours@'), false);
  check_('CONTROL: third-party packages are included', result.next.includes('theirs@'), true);
}

{
  const dir = scratch({ NOTICE: HEADER });
  const result = generateNotice(dir, { inventory: fakeInventory([]) });
  check_('CONTROL: an empty runtime set renders explicitly rather than blank', result.next.includes('(No third-party runtime dependencies.)'), true);
}

{
  // A dependency shipping its own NOTICE must have it reproduced — that is the
  // §4(d) obligation this whole script exists to satisfy.
  const depDir = scratch({ NOTICE: 'Copyright (c) Example Corp.\n' });
  const dir = scratch({ NOTICE: HEADER });
  const result = generateNotice(dir, {
    inventory: fakeInventory([dep('withnotice', { dir: depDir })]),
  });
  check_("CONTROL: a dependency's own NOTICE is reproduced", result.next.includes('Copyright (c) Example Corp.'), true);
  check_('...under a header naming it', result.next.includes('--- withnotice@1.0.0 ---'), true);
}

// ---------------------------------------------------------------------------
// The generator must not write. That is the caller's job.
// ---------------------------------------------------------------------------

console.log('\n# CONTROL: no write as a side effect\n');

{
  const dir = scratch({ NOTICE: HEADER });
  const before = readFileSync(join(dir, 'NOTICE'), 'utf-8');
  generateNotice(dir, { inventory: fakeInventory([dep('a')]) });
  check_('CONTROL: generateNotice does not write NOTICE itself', readFileSync(join(dir, 'NOTICE'), 'utf-8'), before);
}

{
  const dir = scratch({ NOTICE: HEADER });
  generateNotice(dir, { checkOnly: true, inventory: fakeInventory([dep('a')]) });
  check_('CONTROL: --check never writes', readFileSync(join(dir, 'NOTICE'), 'utf-8'), HEADER);
}

{
  const dir = scratch();
  generateNotice(dir, { inventory: fakeInventory([dep('a')]) });
  check_('CONTROL: a missing NOTICE is not created as a side effect', existsSync(join(dir, 'NOTICE')), false);
}

// ---------------------------------------------------------------------------
// The exit code CI reads, and the write the CLI DOES perform
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: the script process exit code\n');

{
  // Witnesses `process.exit(result.code)` in the entry point — a claim the
  // in-process assertions above cannot make, since they never run that line.
  //
  // This uses the STALE path (exit 1) rather than the cannot-check path,
  // and the reason is worth stating rather than leaving as an apparent gap:
  // the real `inventory()` throws only when `npm ls` emits unparseable stdout,
  // which no fixture directory can reliably provoke — an empty directory makes
  // `npm ls` emit a valid `{}` and no error. I checked that rather than
  // assuming it, after this assertion first failed expecting 2 and observing 1.
  //
  // The exit-2 SITE is still witnessed: `code: 2` is neutralisable and is
  // reddened by the injected-inventory assertions at the top of this file. What
  // is not covered is the pairing of that code with the exit call, and since
  // the exit call is the same single line for every code, exercising it once is
  // sufficient to redden it. No exemption-ledger entry is warranted.
  const dir = scratch({ NOTICE: HEADER });
  const run = runScript([dir, '--check']);
  checkSpawned('the script PROCESS exits non-zero on a stale NOTICE', run, () => {
    check_('the script PROCESS exits non-zero on a stale NOTICE', run.status, 1);
    check_('...and annotates stderr', run.stderr.includes('::error::'), true);
  });
}

{
  // The write half of the CLI, which `generateNotice` deliberately does not do.
  // Without this, nothing would notice if the entry point stopped writing and
  // every in-process assertion would still pass.
  const dir = scratch({ NOTICE: HEADER });
  const run = runScript([dir]);
  checkSpawned('the CLI writes NOTICE when not in --check mode', run, () => {
    check_('the CLI exits 0 when regenerating', run.status, 0);
    check_('...and the file now exists', existsSync(join(dir, 'NOTICE')), true);
    check_(
      '...and contains the generated section',
      readFileSync(join(dir, 'NOTICE'), 'utf-8').includes('BEGIN GENERATED THIRD-PARTY NOTICES'),
      true,
    );
  });
}

{
  const run = runScript([repoRoot, '--check']);
  checkSpawned('CONTROL: the real repository is up to date, exit 0', run, () => {
    check_('CONTROL: the real repository is up to date, exit 0', run.status, 0);
  });
}

// ---------------------------------------------------------------------------
// The real repository
// ---------------------------------------------------------------------------

console.log('\n# this repository\n');

{
  const result = generateNotice(repoRoot, { checkOnly: true });
  check_('CONTROL: the repository NOTICE is up to date', result.code, 0);
  // An inventory that collapsed to nothing would also report up-to-date;
  // assert it is real so a broken scan cannot look healthy.
  check_('CONTROL: and the inventory is non-trivial', result.runtimeCount > 10, true);
}

// ---------------------------------------------------------------------------
// EVERY NOTICE COPY, FROM A LIST THAT IS NOT WRITTEN HERE (#711)
//
// Apache-2.0 §4(d) is satisfied per ARTIFACT, so a package shipping a stale
// NOTICE is non-compliant even when the root is current. The generator writes
// them all — and the point of #711 is that it does so from a SHARED list,
// because a sixth hand-written copy of "which packages are public" would make
// the set receiving a NOTICE a parallel to the set that exists.
// ---------------------------------------------------------------------------
{
  // DERIVED, NOT HARDCODED — including the count. A fixture with two public
  // packages, one private, and one public-without-a-NOTICE must yield exactly
  // root + the two that qualify, so neither membership nor number can have been
  // written down anywhere.
  const dir = scratch({
    NOTICE: 'ROOT\n',
    'packages/alpha/package.json': '{"name":"@x/alpha","version":"0.0.0"}',
    'packages/alpha/NOTICE': 'ROOT\n',
    'packages/beta/package.json': '{"name":"@x/beta","version":"0.0.0"}',
    'packages/beta/NOTICE': 'stale\n',
    'packages/hidden/package.json': '{"name":"@x/hidden","version":"0.0.0","private":true}',
    'packages/hidden/NOTICE': 'ROOT\n',
    // Public, but ships no NOTICE. Deliberately NOT given one: whether it
    // should ship one is check-tarball-compliance's call, not this script's.
    'packages/nonotice/package.json': '{"name":"@x/nonotice","version":"0.0.0"}',
  });

  const targets = noticeTargets(dir).map((p) => p.slice(dir.length + 1));
  check_('#711: root and every public package carrying a NOTICE is a target', targets.length, 3);
  check_('#711: ...the private package is excluded', targets.includes('packages/hidden/NOTICE'), false);
  check_(
    '#711: ...and a public package with no NOTICE is not given one',
    targets.includes('packages/nonotice/NOTICE'),
    false,
  );

  // THE DRIFT PROBE, and it is the assertion that caught a real defect in the
  // first version of this change: `beta` has drifted while the ROOT is current.
  // Gating the write on the root's own `changed` flag left it drifted — which
  // is the #587 state exactly, a copy going stale while the root regenerates.
  const stale = staleNoticeTargets(dir, 'ROOT\n').map((p) => p.slice(dir.length + 1));
  check_('#711: a drifted copy is stale even when the ROOT is current', stale.join(','), 'packages/beta/NOTICE');

  // THE CONTROL. Without it the assertion above is satisfied by a rule that
  // calls every copy stale, which would rewrite all ten on every run and make
  // "stale" mean nothing.
  writeFileSync(join(dir, 'packages/beta/NOTICE'), 'ROOT\n');
  check_('#711: ...and once it matches, nothing is stale', staleNoticeTargets(dir, 'ROOT\n').length, 0);
}

// ---------------------------------------------------------------------------

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${String(passed)} passed, ${String(failed)} failed\n`);
process.exit(failed === 0 ? 0 : 1);
