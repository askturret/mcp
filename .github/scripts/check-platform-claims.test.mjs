#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the platform-claim guard (#535).
 *
 * Both halves are witnessed here, and the SECOND of each pair is the one that
 * decays:
 *
 *   Part A  registered-file-without-block fails  AND  block-in-unregistered-file
 *           fails. #428: without the second direction the registry goes stale
 *           silently, because nothing notices a block nobody compares.
 *
 *   Part B  divergence fails naming the claim    AND  unreadable state exits 2
 *           CANNOT CHECK. #535 names the cannot-check arm as the one most likely
 *           to be written and never exercised, which is why it is exercised
 *           here rather than left to an outage to discover.
 *
 * Part B's live reader is INJECTED. A self-test that had to reach the network to
 * exercise the cannot-check arm would be flaky in exactly the conditions that
 * arm exists for — and could not distinguish "the guard reported cannot-check"
 * from "the test could not reach the network".
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkDeclarations, checkLive, parseBlock, VOCABULARY, REGISTERED_SITES } from './check-platform-claims.mjs';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-platform-claims.mjs');

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

/** A throwaway tree of markdown documents. */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-claims-'));
  tmpDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const GOOD_BLOCK = `<!-- platform-claims
repository_visibility: public (verifiable)
author_is_bypass_actor: true (declared-unverifiable)
-->
`;

// ---------------------------------------------------------------------------
// PART A — declaration integrity
// ---------------------------------------------------------------------------

{
  const dir = fixture({ 'docs/a.md': `# A\n\n${GOOD_BLOCK}` });
  const r = checkDeclarations({ rootDir: dir, sites: ['docs/a.md'] });
  check('A: a well-formed block on a registered file passes', r.code, 0);
  check('A: ...and reports no problems', r.problems.length, 0);
}

// DIRECTION 1 — registered, no block.
{
  const dir = fixture({ 'docs/a.md': '# A\n\nno block here\n' });
  const r = checkDeclarations({ rootDir: dir, sites: ['docs/a.md'] });
  check('A: a registered file with NO block fails', r.code, 1);
  check(
    'A: ...and names the file and what to do about it',
    /docs\/a\.md: registered .* carries no/.test(r.problems.join('\n')),
    true,
  );
}

// DIRECTION 2 — a block in a file nobody registered. THE ONE THAT DECAYS.
// A block here reads as guarded while nothing compares it, which is the exact
// property this guard exists to remove, reproduced inside the guard.
{
  const dir = fixture({ 'docs/a.md': `# A\n\n${GOOD_BLOCK}`, 'docs/stray.md': `# Stray\n\n${GOOD_BLOCK}` });
  const r = checkDeclarations({ rootDir: dir, sites: ['docs/a.md'] });
  check('A: a block in an UNREGISTERED file fails', r.code, 1);
  check(
    'A: ...and names the stray file, not the registered one',
    r.problems.some((p) => p.startsWith('docs/stray.md:')),
    true,
  );
  check(
    'A: ...and does NOT complain about the correctly registered file',
    r.problems.some((p) => p.startsWith('docs/a.md:')),
    false,
  );
}

// THE CLOSED VOCABULARY. A property outside it would imply coverage the guard
// does not have, so it is refused at declaration time.
{
  const dir = fixture({
    'docs/a.md': `<!-- platform-claims\nbranch_count: 7 (verifiable)\n-->\n`,
  });
  const r = checkDeclarations({ rootDir: dir, sites: ['docs/a.md'] });
  check('A: a property outside the closed vocabulary fails', r.code, 1);
  check(
    'A: ...and lists what the vocabulary actually permits',
    /not in the closed vocabulary/.test(r.problems.join('\n')),
    true,
  );
}

// THE SILENT DOWNGRADE — the cheapest way to defeat this guard, so the one it
// is built to catch. Relabelling a verifiable claim as declared-unverifiable
// would drop it out of Part B's comparison without removing the claim.
{
  const dir = fixture({
    'docs/a.md': `<!-- platform-claims\nrepository_visibility: public (declared-unverifiable)\n-->\n`,
  });
  const r = checkDeclarations({ rootDir: dir, sites: ['docs/a.md'] });
  check('A: relabelling a verifiable property as unverifiable fails', r.code, 1);
  check(
    'A: ...and says which classification the vocabulary holds',
    /tagged `declared-unverifiable` but the vocabulary classifies it as `verifiable`/.test(r.problems.join('\n')),
    true,
  );
}

// Malformed shapes, each its own message rather than one generic refusal.
{
  const dir = fixture({ 'docs/a.md': '<!-- platform-claims\nrepository_visibility public\n-->\n' });
  const r = checkDeclarations({ rootDir: dir, sites: ['docs/a.md'] });
  check('A: an unparseable claim line fails', r.code, 1);
  check('A: ...and quotes the line it could not parse', /unparseable claim line/.test(r.problems.join('\n')), true);
}
{
  const dir = fixture({ 'docs/a.md': '<!-- platform-claims\nrepository_visibility: public (verifiable)\n' });
  const r = checkDeclarations({ rootDir: dir, sites: ['docs/a.md'] });
  check('A: an unclosed block fails', r.code, 1);
}
{
  const dir = fixture({ 'docs/a.md': `${GOOD_BLOCK}\n${GOOD_BLOCK}` });
  const r = checkDeclarations({ rootDir: dir, sites: ['docs/a.md'] });
  check('A: two blocks in one file fail rather than one being picked', r.code, 1);
}

// PART A IS OFFLINE — ASSERTED, NOT ASSUMED.
//
// The whole design rests on Part A making no network call: that is why it can
// fail closed in the PR path. A comment saying so is exactly the kind of
// unchecked prose this issue is about, so the claim is executed instead. The
// child replaces `fetch` with a throw and runs the real guard over the real
// repository; if any code path reaches the network, it exits non-zero.
{
  const probe = `
    globalThis.fetch = () => { throw new Error('PART A REACHED THE NETWORK'); };
    const { main } = await import(${JSON.stringify(GUARD)});
    process.exit(await main(['node', ${JSON.stringify(GUARD)}, ${JSON.stringify(join(dirname(GUARD), '..', '..'))}]));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf-8' });
  check('A: runs to completion with `fetch` replaced by a throw — it is offline', r.status, 0);
  check(
    'A: ...and did not reach the network',
    /PART A REACHED THE NETWORK/.test(`${r.stdout}${r.stderr}`),
    false,
  );
}

// ---------------------------------------------------------------------------
// PART B — divergence detection
// ---------------------------------------------------------------------------

const liveFixture = () => fixture({ 'docs/a.md': `# A\n\n${GOOD_BLOCK}` });

{
  const dir = liveFixture();
  const r = await checkLive({
    rootDir: dir,
    sites: ['docs/a.md'],
    readState: async () => ({ values: { repository_visibility: 'public' }, unreadable: [] }),
  });
  check('B: a claim matching live state passes', r.code, 0);
  check('B: ...and reports no divergence', r.divergences.length, 0);
}

// DIVERGENCE. The #330 failure, caught.
{
  const dir = liveFixture();
  const r = await checkLive({
    rootDir: dir,
    sites: ['docs/a.md'],
    readState: async () => ({ values: { repository_visibility: 'private' }, unreadable: [] }),
  });
  check('B: a claim diverging from live state FAILS', r.code, 1);
  check(
    'B: ...and names the file and the specific claim, not just "something changed"',
    /docs\/a\.md: `repository_visibility` is declared `public` but live platform state reads `private`/.test(
      r.divergences.join('\n'),
    ),
    true,
  );
}

// CANNOT CHECK — the arm most likely to be written and never exercised (#535).
{
  const dir = liveFixture();
  const r = await checkLive({
    rootDir: dir,
    sites: ['docs/a.md'],
    readState: async () => ({
      values: {},
      unreadable: [{ property: 'repository_visibility', reason: 'HTTP 503' }],
    }),
  });
  check('B: unreadable state exits 2, NOT 0', r.code, 2);
  check(
    'B: ...and carries the reason it could not read, so the run is actionable',
    /`repository_visibility` could not be read — HTTP 503/.test(r.cannotCheck.join('\n')),
    true,
  );
  check('B: ...and does NOT invent a divergence from state it never read', r.divergences.length, 0);
}

// PRECEDENCE. A confirmed falsehood outranks an unknown — but the unknown is
// still REPORTED, because narrowing to one exit code must not narrow the report.
{
  const dir = fixture({
    'docs/a.md': `<!-- platform-claims\nrepository_visibility: public (verifiable)\norganisation_plan: free (verifiable)\n-->\n`,
  });
  const r = await checkLive({
    rootDir: dir,
    sites: ['docs/a.md'],
    readState: async () => ({
      values: { repository_visibility: 'private' },
      unreadable: [{ property: 'organisation_plan', reason: 'no `plan` field' }],
    }),
  });
  check('B: divergence outranks cannot-check in the exit code', r.code, 1);
  check('B: ...and the cannot-check is still reported rather than swallowed', r.cannotCheck.length, 1);
}

// A DECLARED-UNVERIFIABLE CLAIM IS REPORTED, NOT SILENTLY SKIPPED. Omitting it
// would leave #330's most important claim invisible — the original defect,
// reproduced inside the mechanism built to prevent it.
{
  const dir = liveFixture();
  const r = await checkLive({
    rootDir: dir,
    sites: ['docs/a.md'],
    readState: async () => ({ values: { repository_visibility: 'public' }, unreadable: [] }),
  });
  check(
    'B: a declared-unverifiable claim is announced as declared-and-unchecked',
    /`author_is_bypass_actor` = true — declared, not verified/.test(r.declaredUnverifiable.join('\n')),
    true,
  );
  check('B: ...and does not make the run fail on its own', r.code, 0);
}

{
  const dir = fixture({ 'docs/a.md': '<!-- platform-claims\n\n-->\n' });
  const r = checkDeclarations({ rootDir: dir, sites: ['docs/a.md'] });
  check('A: an empty block fails rather than counting as a declaration', r.code, 1);
  check('A: ...and says the block is empty', /the declaration block is empty/.test(r.problems.join('\n')), true);
}

// ---------------------------------------------------------------------------
// THE ENTRY POINT AND main()'s RETURN CODES — #110's shape
//
// Every case above calls an exported function directly, so `main()` and the
// module's own `process.exit(await main(...))` were never executed. That is the
// exact gap this repository has spent the week closing: the line CI actually
// depends on had no witness while the exported functions were covered. Measured
// with the mutation audit — 6 of 7 sites were unwitnessed until these existed.
// ---------------------------------------------------------------------------

/** A fixture whose paths match REGISTERED_SITES, so the real `main()` can run. */
function registeredFixture(block) {
  const files = {};
  for (const rel of REGISTERED_SITES) files[rel] = `# doc\n\n${block}`;
  return fixture(files);
}

/** Run a child that stubs `fetch`, then calls the guard's real `main()`. */
function spawnWithFetch(stub, args) {
  const src = `
    globalThis.fetch = ${stub};
    const { main } = await import(${JSON.stringify(GUARD)});
    process.exit(await main(['node', ${JSON.stringify(GUARD)}, ${args.map((a) => JSON.stringify(a)).join(', ')}]));
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf-8' });
}

// The ENTRY POINT, spawned as a real subprocess rather than imported.
{
  const dir = fixture({ 'docs/unrelated.md': '# nothing\n' });
  const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf-8' });
  check('entry: the script itself exits 1 when Part A finds a problem', r.status, 1);
  check(
    'entry: ...and names the registered site it could not find',
    /registered as a platform-claim site, but the file does not exist/.test(`${r.stdout}${r.stderr}`),
    true,
  );
}
{
  const dir = registeredFixture(GOOD_BLOCK);
  const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf-8' });
  check('entry: ...and exits 0 on a clean tree', r.status, 0);
}

// main() --live: DIVERGENCE returns 1, through the real fetch path.
{
  const dir = registeredFixture(GOOD_BLOCK);
  const r = spawnWithFetch(
    `async (u) => ({ ok: true, json: async () => (String(u).includes('/repos/') ? { visibility: 'private' } : { plan: { name: 'free' } }) })`,
    [dir, '--live'],
  );
  check('main --live: divergence returns 1', r.status, 1);
  check(
    'main --live: ...and prints the diverging claim',
    /DIVERGENCE .* `repository_visibility` is declared `public` but live platform state reads `private`/.test(
      `${r.stdout}${r.stderr}`,
    ),
    true,
  );
}

// main() --live: CANNOT CHECK returns 2. Also witnesses the non-ok throw inside
// the real live reader, which no injected fake would reach.
{
  const dir = registeredFixture(GOOD_BLOCK);
  const r = spawnWithFetch(`async () => ({ ok: false, status: 503, json: async () => ({}) })`, [dir, '--live']);
  check('main --live: unreadable live state returns 2, not 0 and not 1', r.status, 2);
  check(
    'main --live: ...and reports the HTTP status it could not get past',
    /CANNOT CHECK .* HTTP 503/.test(`${r.stdout}${r.stderr}`),
    true,
  );
}

// main() --live: the clean path returns 0, so the codes above are a decision
// rather than a constant.
{
  const dir = registeredFixture(GOOD_BLOCK);
  const r = spawnWithFetch(
    `async (u) => ({ ok: true, json: async () => (String(u).includes('/repos/') ? { visibility: 'public' } : { plan: { name: 'free' } }) })`,
    [dir, '--live'],
  );
  check('main --live: agreement returns 0', r.status, 0);
}

// ---------------------------------------------------------------------------
// The vocabulary and registry themselves
// ---------------------------------------------------------------------------

check('vocabulary: every member is classified', Object.values(VOCABULARY).every((v) => v.classification === 'verifiable' || v.classification === 'declared-unverifiable'), true);
check(
  'vocabulary: every declared-unverifiable member records WHY it cannot be read',
  Object.values(VOCABULARY)
    .filter((v) => v.classification === 'declared-unverifiable')
    .every((v) => typeof v.reason === 'string' && v.reason.length > 0),
  true,
);
check('vocabulary: the two unverifiable members are named', Object.entries(VOCABULARY).filter(([, v]) => v.classification === 'declared-unverifiable').length, 2);
check('registry: the #330 sites are registered', REGISTERED_SITES.includes('docs/ownership.md'), true);

// The parser, on the shape the documents actually carry.
{
  const p = parseBlock(`prose before\n\n${GOOD_BLOCK}\nprose after\n`);
  check('parse: finds the block amid surrounding prose', p.claims.length, 2);
  check('parse: reads the tag as its own field', p.claims[1].tag, 'declared-unverifiable');
  check('parse: a document with no block is not an error by itself', parseBlock('# nothing\n').found, false);
}

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
