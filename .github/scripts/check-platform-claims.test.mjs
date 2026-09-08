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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
// Driven by a FIXTURE vocabulary rather than the real one, because this asserts
// a MECHANIC (which code wins) and not a classification. It used to lean on
// `organisation_plan` being `verifiable`; #784 reclassified it, and a mechanic
// test that breaks when an unrelated property is reclassified was testing the
// wrong thing. The classification itself is pinned against the REAL vocabulary
// further down, which is where that belongs.
{
  const dir = fixture({
    'docs/a.md': `<!-- platform-claims\nrepository_visibility: public (verifiable)\nsecond_property: free (verifiable)\n-->\n`,
  });
  const r = await checkLive({
    rootDir: dir,
    sites: ['docs/a.md'],
    vocabulary: {
      repository_visibility: { classification: 'verifiable', source: 'x' },
      second_property: { classification: 'verifiable', source: 'y' },
    },
    readState: async () => ({
      values: { repository_visibility: 'private' },
      unreadable: [{ property: 'second_property', reason: 'no `plan` field' }],
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
// `dependabot_security_updates` — THE CLAIM, AND ITS CONTROL (#677, ADR-024)
//
// These run against the REAL `VOCABULARY` and the REAL shipped document, not a
// fixture vocabulary. That is the whole point: a fixture would prove the guard
// can classify SOME property, which is already covered above, and would stay
// green if this property were reclassified or its declaration deleted.
// ---------------------------------------------------------------------------

check(
  '#677: the real vocabulary carries `dependabot_security_updates`',
  Object.prototype.hasOwnProperty.call(VOCABULARY, 'dependabot_security_updates'),
  true,
);

// PINS THE CLASSIFICATION ITSELF, not merely that an entry exists. #677 was
// filed expecting `verifiable`; it is `declared-unverifiable` because no
// `permissions:` scope can give the Actions token admin read. Flipping it back
// reddens HERE, next to the reason, rather than silently at 03:00 in a nightly.
check(
  '#677: ...classified `declared-unverifiable`, deliberately and against the first reading',
  VOCABULARY['dependabot_security_updates'].classification,
  'declared-unverifiable',
);

check(
  '#677: ...and carries the reason a reader needs to disagree with it',
  /admin read access/i.test(VOCABULARY['dependabot_security_updates'].reason),
  true,
);

// THE RED ARM. A claim that cannot go red is the #621 species, so here is the
// mutation that reddens it: tag the property `(verifiable)` and Part A refuses.
// This is what stops a later edit quietly upgrading the tag without also giving
// the scheduled job a credential that can read it.
{
  const dir = fixture({
    'docs/a.md': '<!-- platform-claims\ndependabot_security_updates: enabled (verifiable)\n-->\n',
  });
  const r = checkDeclarations({ rootDir: dir, sites: ['docs/a.md'] });
  check('#677: RED ARM — tagging it `(verifiable)` is REFUSED', r.code, 1);
  check(
    '#677: ...and the refusal names the property and both classifications',
    /`dependabot_security_updates` is tagged `verifiable` but the vocabulary classifies it as `declared-unverifiable`/.test(
      r.problems.join('\n'),
    ),
    true,
  );
}

// AND THE QUIET ARM: correctly tagged, it is ANNOUNCED as declared-and-unchecked
// rather than skipped. "Nothing verified this" has to be visible, or declaring
// an unverifiable claim buys nothing over not declaring it.
{
  const dir = fixture({
    'docs/a.md': '<!-- platform-claims\ndependabot_security_updates: enabled (declared-unverifiable)\n-->\n',
  });
  const r = await checkLive({
    rootDir: dir,
    sites: ['docs/a.md'],
    readState: async () => ({ values: {}, unreadable: [] }),
  });
  check(
    '#677: correctly tagged, it is announced as declared-and-unchecked',
    /`dependabot_security_updates` = enabled — declared, not verified/.test(r.declaredUnverifiable.join('\n')),
    true,
  );
  check('#677: ...and does not redden the run on its own', r.code, 0);
}

// THE DECLARATION ITSELF IS THE DELIVERABLE, so it gets an assertion. Part A's
// bidirectional check catches a registered file with NO block; it does not catch
// a block that quietly loses one claim line. Deleting the declaration reddens
// here and nowhere else.
check(
  '#677: the shipped docs/ownership.md actually declares the claim',
  /^dependabot_security_updates: enabled \(declared-unverifiable\)$/m.test(
    readFileSync(join(dirname(GUARD), '..', '..', 'docs', 'ownership.md'), 'utf-8'),
  ),
  true,
);

// ---------------------------------------------------------------------------
// `organisation_plan` — RECLASSIFIED ON A MEASUREMENT (#784)
//
// Against the REAL vocabulary, for the reason the #677 block gives: a fixture
// would prove the guard can classify SOME property and would stay green if this
// one were flipped back.
// ---------------------------------------------------------------------------

check(
  '#784: `organisation_plan` is `declared-unverifiable`, not `verifiable`',
  VOCABULARY['organisation_plan'].classification,
  'declared-unverifiable',
);
check(
  '#784: ...and carries a reason rather than a source, per the class contract',
  typeof VOCABULARY['organisation_plan'].reason === 'string' &&
    VOCABULARY['organisation_plan'].source === undefined,
  true,
);
// The reason must name the CREDENTIAL, not merely the endpoint. "Needs
// GET /orgs/{org}" is true of the `verifiable` classification too, so a reason
// that only said that would not distinguish the two.
check(
  '#784: ...and the reason names why the credential cannot see it',
  /organisation OWNER|permissions:` block/.test(VOCABULARY['organisation_plan'].reason),
  true,
);

// THE READ IS GONE TOO. Reclassifying while leaving the org fetch in place would
// keep a nightly API call whose result can never be compared — and would leave
// the next reader thinking the property is still being checked.
check(
  '#784: readLiveState no longer fetches the organisation',
  /api\.github\.com\/orgs\//.test(readFileSync(GUARD, 'utf-8')),
  false,
);

// THE GUARD'S OWN PROSE NAMES A `verifiable` EXAMPLE, AND IT MUST STILL BE ONE.
//
// This is the assertion that was missing. The paragraph contrasting the two
// classifications named `organisation_plan` as its `verifiable` example; this
// change reclassified that property and left the sentence standing, and the
// suite was 67/0 with it false (#802, QA). Prose asserting the PRE-change
// classification, AS THE GUIDANCE FOR THE NEXT CLASSIFICATION DECISION, is
// #784's own defect in another medium — and the original misclassification came
// from reasoning across resources BY ANALOGY, which is exactly what that
// sentence invites a reader to do.
//
// Scoped to the ONE name the prose asserts, rather than checking prose in
// general: "is this sentence a present-tense claim or a description of history?"
// is not decidable, and a checker that guessed would fire on the two lines in
// the guard that correctly narrate what the classification USED to be.
{
  const guardSource = readFileSync(GUARD, 'utf-8');
  const named = /^\s*\/\/\s+`verifiable` example: `([a-z_]+)`/m.exec(guardSource);
  // NON-VACUITY FIRST. If the line is reworded or deleted this must fail rather
  // than silently stop checking — a check that passes because it found nothing
  // is the shape #784 cost us.
  check('#784: the guard prose still names a `verifiable` example in the checked form', named !== null, true);
  check(
    '#784: ...and the property it names really is classified `verifiable`',
    named === null ? '(no example found)' : VOCABULARY[named[1]]?.classification,
    'verifiable',
  );
}

// ---------------------------------------------------------------------------
// THE MISCLASSIFICATION AUDIT — the answer to "should an undeclared vocabulary
// entry be flagged at all?" (#784)
//
// It runs over the VOCABULARY rather than the declarations, because the entry
// that was wrong was declared at no site: every declaration-driven assertion in
// this file was green while the classification was false.
// ---------------------------------------------------------------------------
{
  // RED ARM. A `verifiable` entry the credential cannot read is a confirmed
  // falsehood about our own vocabulary, so it ranks with a divergence.
  const dir = fixture({ 'docs/a.md': '<!-- platform-claims\nrepository_visibility: public (verifiable)\n-->\n' });
  const r = await checkLive({
    rootDir: dir,
    sites: ['docs/a.md'],
    vocabulary: {
      repository_visibility: { classification: 'verifiable', source: 'x' },
      never_declared: { classification: 'verifiable', source: 'y' },
    },
    readState: async () => ({
      values: { repository_visibility: 'public' },
      unreadable: [{ property: 'never_declared', kind: 'absent-field', reason: 'the payload carried no field' }],
    }),
  });
  check('#784: RED ARM — a verifiable entry the credential cannot read is reported', r.misclassified.length, 1);
  check('#784: ...even though NOTHING declares it', /`never_declared`/.test(r.misclassified.join('\n')), true);
  check('#784: ...and it reddens the run as a confirmed falsehood, not a cannot-check', r.code, 1);
  check('#784: ...and says how to clear it', /reclassify it `declared-unverifiable`/.test(r.misclassified.join('\n')), true);
}
{
  // GREEN ARM. Readable — so the classification is TRUE and nothing is said.
  // Without this the red arm above is satisfied by a rule that always fires.
  const dir = fixture({ 'docs/a.md': '<!-- platform-claims\nrepository_visibility: public (verifiable)\n-->\n' });
  const r = await checkLive({
    rootDir: dir,
    sites: ['docs/a.md'],
    vocabulary: {
      repository_visibility: { classification: 'verifiable', source: 'x' },
      never_declared: { classification: 'verifiable', source: 'y' },
    },
    readState: async () => ({
      values: { repository_visibility: 'public', never_declared: 'anything' },
      unreadable: [],
    }),
  });
  check('#784: GREEN ARM — a readable verifiable entry is not reported', r.misclassified.length, 0);
  check('#784: ...and the run is clean', r.code, 0);
}
{
  // A TRANSPORT FAILURE IS NOT A MISCLASSIFICATION. This is the anti-noise arm:
  // without the `kind` distinction, every GitHub outage would report the
  // vocabulary as wrong — a standing alarm that is never a true positive, which
  // is the failure this file argues against elsewhere.
  const dir = fixture({ 'docs/a.md': '<!-- platform-claims\nrepository_visibility: public (verifiable)\n-->\n' });
  const r = await checkLive({
    rootDir: dir,
    sites: ['docs/a.md'],
    vocabulary: { repository_visibility: { classification: 'verifiable', source: 'x' } },
    readState: async () => ({
      values: {},
      unreadable: [{ property: 'repository_visibility', kind: 'transport', reason: 'HTTP 503' }],
    }),
  });
  check('#784: a TRANSPORT failure is not reported as a misclassification', r.misclassified.length, 0);
  check('#784: ...it stays a cannot-check, exit 2', r.code, 2);
}
{
  // ANTI-VACUITY. The audit is silent when the vocabulary has no `verifiable`
  // entry at all, so "silent" must not be mistaken for "checked". The real
  // vocabulary must actually give it something to check.
  check(
    '#784: the real vocabulary has at least one `verifiable` entry for the audit to check',
    Object.values(VOCABULARY).some((v) => v.classification === 'verifiable'),
    true,
  );
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
// ASSERTS THE MEMBERSHIP, NOT THE COUNT. This read `.length === 2` under the
// same name — but a count cannot say WHICH members, so swapping one property for
// another left it green, and it could not force this comment to be corrected
// when the set changed. Adding `dependabot_security_updates` (#677) is what
// surfaced the gap: the count went red, which was right, while the name it went
// red under was already inaccurate. Comparing the sorted list is what the
// description always claimed.
// It earned its keep again on #784: moving `organisation_plan` into this set
// reddened it BY NAME, printing both lists side by side. A count would have gone
// from 3 to 4 and said nothing about which property moved or in which direction.
check(
  'vocabulary: the declared-unverifiable members are named, exactly',
  Object.entries(VOCABULARY)
    .filter(([, v]) => v.classification === 'declared-unverifiable')
    .map(([k]) => k)
    .sort()
    .join(','),
  'author_is_bypass_actor,code_owner_review_required,dependabot_security_updates,organisation_plan',
);
// THE COMPLEMENT, pinned for the same reason. Without it the set above can be
// satisfied by moving a property OUT of `verifiable` into nothing at all, and
// `verifiable` is the classification that makes a live assertion — so it is the
// one whose membership matters most.
check(
  'vocabulary: the verifiable members are named, exactly',
  Object.entries(VOCABULARY)
    .filter(([, v]) => v.classification === 'verifiable')
    .map(([k]) => k)
    .sort()
    .join(','),
  'repository_visibility',
);
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
