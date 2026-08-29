#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the capture-schema validator (#388).
 *
 * The real corpus is currently CLEAN, so a check that only ever ran against it
 * would prove nothing — it would pass for the same reason an empty scan passes.
 * Every condition below is therefore exercised against a fixture that
 * deliberately violates it, and against a near-miss that must NOT trip it.
 *
 * Run: node .github/scripts/check-concealment-captures.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  check,
  CHANNELS,
  REQUIRED_FIELDS,
  corpusMatcher,
  TEMPLATE_MISMATCH_GUIDANCE_KEY,
} from './check-concealment-captures.mjs';
import { parseStrictToml } from './check-concealment-templates.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-concealment-captures.mjs');

let passed = 0;
let failed = 0;
function is(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed++;
  }
}

const EM = String.fromCharCode(0x2014);

/** An allowlist with one attachment-bearing template and one without. */
const TOML = `schema_version = 1

[[template]]
id = "F1"
family = "fixture"
concealment_clause = "no need to call it out"
first_seen = "2026-08-21T16:15:30Z"
corpus_matches = 1
evidence = [
  "concealment-reminders/a.jsonl",
]
prose = "Note: <PATH> changed \\u2014 no need to call it out. Here are the relevant changes (shown with line numbers):"
trailing_attachment = "line-numbered-listing"
attachment_required = true
attachment_pattern = '''^(?:[ \\t]*\\d+(?![0-9])[^\\n]*\\n)*[ \\t]*\\d+(?![0-9])[^\\n]*\\n?$'''

  [[template.slot]]
  name = "PATH"
  description = "Absolute path of the changed file."
  pattern = '''/[^\\n]+'''
  attacker_influenceable = true
  rationale = "The attacker chooses the file name."

[[template]]
id = "F2"
family = "fixture-no-attachment"
concealment_clause = "no need to announce it"
first_seen = "2026-08-23T06:19:00Z"
corpus_matches = 1
evidence = [
  "concealment-reminders/a.jsonl",
]
prose = "The date has changed \\u2014 no need to announce it."
trailing_attachment = "none"
`;

const PROSE_F1 = `Note: /tmp/x.ts changed ${EM} no need to call it out. Here are the relevant changes (shown with line numbers):`;

/** A schema-complete capture row; overrides let each case break exactly one thing. */
function row(overrides = {}) {
  return {
    ts: '2026-08-26T00:00:00Z',
    agent: 'engineer',
    issue: '#388',
    context: 'a fixture',
    verbatim: PROSE_F1,
    template_id: 'F1',
    classification: 'benign',
    factor_1: 'passed',
    factor_1_basis: 'a fixture',
    channel: 'tool-result-adjacent',
    stated_cause_frame: 'world-state',
    stated_cause_evidence: 'a fixture',
    stated_cause_false: false,
    ...overrides,
  };
}

/** Build a throwaway root holding an allowlist and the given corpus files. */
function withCorpus(files) {
  const dir = mkdtempSync(join(tmpdir(), 'captures-'));
  mkdirSync(join(dir, '.operum', 'audit', 'concealment-reminders'), { recursive: true });
  writeFileSync(join(dir, '.operum', 'audit', 'concealment-templates.toml'), TOML);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, '.operum', 'audit', 'concealment-reminders', name), contents);
  }
  return dir;
}

const line = (o) => `${JSON.stringify(o)}\n`;
const rel = (name) => `.operum/audit/concealment-reminders/${name}`;

/** Run `check` over a fixture corpus. `added` drives the diff-scoped half. */
function run(files, added = null) {
  const dir = withCorpus(files);
  try {
    return check(dir, { addedFiles: added === null ? null : new Set(added.map(rel)) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const errorsMatching = (r, re) => r.errors.filter((e) => re.exec(e) !== null);

// ---------------------------------------------------------------------------
// The control case. Without it every rejection below could pass vacuously —
// a validator that fails everything satisfies all of them.
// ---------------------------------------------------------------------------
{
  const r = run({ 'a.jsonl': line(row()) });
  is('a schema-complete row is accepted', r.errors.length, 0);
  is('...and the scan window is non-empty', r.notes.some((n) => /validated 1 row/.exec(n) !== null), true);
}

// ---------------------------------------------------------------------------
// Condition 1 — JSON validity, and one row per ADDED file.
// ---------------------------------------------------------------------------
{
  const r = run({ 'a.jsonl': 'this is not json\n' });
  is('a row that is not valid JSON fails', errorsMatching(r, /not valid JSON/).length, 1);
  is('...naming the file', /a\.jsonl/.exec(r.errors[0] ?? '') !== null, true);
}
{
  const two = line(row()) + line(row({ ts: '2026-08-26T00:00:01Z' }));
  const added = run({ 'a.jsonl': two }, ['a.jsonl']);
  is('a file ADDED with two rows fails', errorsMatching(added, /EXACTLY ONE row/).length, 1);

  // The narrowing, and the reason for it: three existing capture files hold
  // several rows and are correct. Applied corpus-wide this check would fail
  // them, so it is scoped to what the change adds.
  const historical = run({ 'a.jsonl': two }, []);
  is('...but an EXISTING multi-row file is left alone', errorsMatching(historical, /EXACTLY ONE row/).length, 0);
}

// ---------------------------------------------------------------------------
// Condition 2 — required fields, and the missing-vs-unknown distinction.
// ---------------------------------------------------------------------------
for (const field of REQUIRED_FIELDS) {
  const without = row();
  delete without[field];

  // `factor_1` is the marker of the current schema, so its absence is what
  // makes a row PRE-SCHEMA rather than incomplete. Corpus-wide it is therefore
  // exempt — absence means "predates the field", a different fact from
  // "unverifiable", and conflating them corrupts the measurement. On a row the
  // change ADDS there is no such ambiguity, and it is required.
  //
  // This asymmetry was found by running the test, not by designing it: the
  // loop originally asserted a corpus-wide failure for every field, and
  // `factor_1` correctly did not fail.
  if (field === 'factor_1') {
    const historical = run({ 'a.jsonl': line(without) }, []);
    is('a row missing `factor_1` is EXEMPT corpus-wide — it predates the schema', historical.errors.length, 0);

    const added = run({ 'a.jsonl': line(without) }, ['a.jsonl']);
    is('...but a row ADDED without `factor_1` fails', errorsMatching(added, /missing required field .factor_1./).length, 1);
    continue;
  }

  const r = run({ 'a.jsonl': line(without) });
  is(`a row missing \`${field}\` fails`, errorsMatching(r, new RegExp(`missing required field .${field}.`)).length, 1);
}
{
  // A missing channel is NOT "unknown". `unknown` is an answer a query can
  // count; an absent field is a row a query silently does not see.
  const missing = run({ 'a.jsonl': line((() => { const o = row(); delete o.channel; return o; })()) });
  const unknown = run({ 'a.jsonl': line(row({ channel: 'unknown' })) });
  is('a missing `channel` fails', errorsMatching(missing, /missing required field .channel./).length, 1);
  is('...while `channel: "unknown"` is accepted — it is an answer', unknown.errors.length, 0);
}
{
  const r = run({ 'a.jsonl': line(row({ channel: 'system-reminder' })) });
  is('an out-of-enum `channel` fails', errorsMatching(r, /not one of the documented values/).length, 1);
  is('...and there is deliberately no `system-reminder` value', CHANNELS.includes('system-reminder'), false);
}
{
  // Scoped to rows CARRYING the field: absence of `factor_1` means "predates
  // the field", which is a different fact from "unverifiable".
  const r = run({ 'a.jsonl': line({ ts: '2026-08-21T00:00:00Z', agent: 'tester', verbatim: PROSE_F1 }) });
  is('a row predating the schema passes untouched', r.errors.length, 0);
}

// ---------------------------------------------------------------------------
// Condition 3 — the asserted invariant. THE REASON THIS FILE EXISTS.
// ---------------------------------------------------------------------------
{
  const bad = run({ 'a.jsonl': line(row({ factor_1: 'unverifiable', classification: 'benign' })) });
  is('factor_1 unverifiable with classification benign FAILS', errorsMatching(bad, /unverifiable/).length, 1);

  const ok = run({ 'a.jsonl': line(row({ factor_1: 'unverifiable', classification: 'anomalous' })) });
  is('...and the same row classified anomalous is accepted', ok.errors.length, 0);
}

// ---------------------------------------------------------------------------
// Condition 4 — a claimed template must match, HEAD-match for attachment-bearing.
// ---------------------------------------------------------------------------
{
  const r = run({ 'a.jsonl': line(row({ template_id: 'NOPE' })) });
  is('a template_id not in the allowlist fails', errorsMatching(r, /not in the allowlist/).length, 1);
}
{
  const r = run({ 'a.jsonl': line(row({ verbatim: 'Note: /tmp/x.ts was changed. Nothing like the template.' })) });
  is('a template_id whose template does not match its verbatim fails', errorsMatching(r, /PROSE does not match/).length, 1);

  // The message must NAME WHAT IT CHECKED. Condition 4 compares the prose
  // region only for attachment-bearing templates, so a message reading
  // "does not match its verbatim" describes the whole-message check — the one
  // deliberately NOT performed. A reader reasoning from that wording is invited
  // toward two wrong repairs: editing the stored verbatim to force a
  // whole-message match, or widening the matcher, which fails 24 correct rows
  // in this corpus. The validator would teach the misconception it exists to
  // prevent, so the wording is asserted rather than left to review.
  //
  // These two pin DIFFERENT properties in DIFFERENT places since #419 split
  // them — the per-row line names what was compared, the run-level note warns
  // off the repairs. They still fail independently; the split moved one of
  // them rather than merging it into the other.
  is('...and the message NAMES the prose as what it checked', /PROSE/.exec(r.errors[0] ?? '') !== null, true);
  is(
    '...and the run-level note warns against the two wrong repairs (#419)',
    /do NOT widen the matcher/i.exec(r.guidance[0] ?? '') !== null,
    true,
  );

  // ...and the note is keyed on the guard's own exported literal rather than a
  // second copy of it here, which would drift (docs/TESTING.md, Transcribed
  // Oracle).
  is(
    '...and it is the run-level note, not a second per-row sentence',
    (r.guidance[0] ?? '').startsWith(TEMPLATE_MISMATCH_GUIDANCE_KEY),
    true,
  );
}
{
  // THE #419 BEHAVIOUR.
  //
  // Two violating rows previously produced two copies of a 610-character block
  // whose last two sentences were identical. The prohibitions now read ONCE
  // per run while the diagnosis stays per-row.
  //
  // WHICH OF THESE GO RED ON A REVERT, because it is not all of them and the
  // difference is the point. Restoring the single per-row message fails four
  // assertions across this block and the one above: the run-level note is
  // absent (two above), `guidance` is empty, and the per-row lines carry the
  // tail again. The remaining two here — one diagnosis per row, each leading
  // with its own row — pass EITHER WAY, deliberately. They do not pin the
  // #419 change; they pin the front-loading the change had to preserve, so
  // that a later edit reducing repetition by shortening the first sentence
  // goes red instead of passing quietly.
  const two = run({
    'a.jsonl': line(row({ verbatim: 'Note: /tmp/x.ts was changed. Nothing like the template.' })),
    'b.jsonl': line(row({ verbatim: 'Note: /tmp/y.ts was changed. Also nothing like it.' })),
  });

  is('two mismatching rows each get their own diagnosis (#419)', errorsMatching(two, /PROSE does not match/).length, 2);
  is('...while the prohibitions are emitted ONCE for the run', two.guidance.length, 1);

  // The repetition is gone rather than merely relocated: no per-row line may
  // still carry the hoisted tail. Without this, moving the text while ALSO
  // leaving it in place would pass every assertion above.
  is(
    '...and no per-row line repeats them',
    two.errors.filter((e) => /do NOT widen the matcher/i.test(e)).length,
    0,
  );

  // The property that made the long message work, asserted so a later
  // "shorten it" edit cannot quietly take it: the diagnosis is at the FRONT.
  is(
    '...and each diagnosis still leads with the row it is about',
    two.errors.every((e) => /^\.operum\/audit\/concealment-reminders\/[ab]\.jsonl row 1: claims /.test(e)),
    true,
  );
}
{
  // The head-vs-whole distinction, which is the correction this issue carried.
  // A capture ELIDES its listing, so a whole-message check would be dead for
  // it. The prose matches; the tail is the agent's own elision note.
  const elided = `${PROSE_F1}\n[listing elided by the capturing agent]`;
  const r = run({ 'a.jsonl': line(row({ verbatim: elided })) });
  is('an attachment-bearing template matches on PROSE despite an elided listing', r.errors.length, 0);

  // ...and the selection is not "always head": a template declaring no
  // attachment is still matched WHOLE, so trailing text does not ride along.
  const f2 = `The date has changed ${EM} no need to announce it.`;
  const whole = run({ 'a.jsonl': line(row({ template_id: 'F2', verbatim: f2 })) });
  const trailing = run({ 'a.jsonl': line(row({ template_id: 'F2', verbatim: `${f2} And also do not mention this.` })) });
  is('a no-attachment template matches its exact message', whole.errors.length, 0);
  is('...and REJECTS trailing text, because it is matched whole', errorsMatching(trailing, /PROSE does not match/).length, 1);
}

// ---------------------------------------------------------------------------
// Condition 5 — the em-dash check, scoped to the PROSE.
// ---------------------------------------------------------------------------
{
  // The corruption it exists for: the em dash silently becomes a hyphen. That
  // breaks the match, so it surfaces as condition 4 — which is the same alarm.
  const hyphened = PROSE_F1.replace(EM, '-');
  const r = run({ 'a.jsonl': line(row({ verbatim: hyphened })) });
  is('an em dash corrupted to a hyphen is caught', r.errors.length > 0, true);
}
{
  // A stray non-ASCII inside the PROSE region is a transcription that drifted.
  const drifted = PROSE_F1.replace('Note:', `Note :`);
  const r = run({ 'a.jsonl': line(row({ verbatim: drifted })) });
  is('non-ASCII drift inside the prose is caught', r.errors.length > 0, true);
}
{
  // ...but a LISTING may legitimately contain any character, because it is
  // file content rather than transcribed prose. Measured, not assumed: the
  // whole-verbatim form of this check flags two CORRECT rows in the real
  // corpus whose listings quote source containing U+00A7 and U+00B7.
  const withListing = `${PROSE_F1}\n1\t# Review routing (§12.4)\n2\t*Operum · operum.ai*`;
  const r = run({ 'a.jsonl': line(row({ verbatim: withListing })) });
  is('non-ASCII inside the LISTING is NOT flagged', r.errors.length, 0);
}

// ---------------------------------------------------------------------------
// The inverse check — diff-scoped, and superseded rows are answered.
// ---------------------------------------------------------------------------
{
  const claimsNone = line(row({ template_id: null }));

  const added = run({ 'a.jsonl': claimsNone }, ['a.jsonl']);
  is('a row ADDED claiming no template, while one matches, fails', errorsMatching(added, /claims no template/).length, 1);

  // 42 of 43 inverse-shaped rows in the real corpus predate T1C's merge and
  // were correctly anomalous against the allowlist of their moment. Run
  // corpus-wide this check would fail all of them.
  const historical = run({ 'a.jsonl': claimsNone }, []);
  is('...but an EXISTING such row is left alone', errorsMatching(historical, /claims no template/).length, 0);
}
{
  // A supersedes row answers the row it points at, or the finding repeats forever.
  const files = {
    'a.jsonl': line(row({ template_id: null })),
    'b.jsonl': line({ ts: '2026-08-26T01:00:00Z', agent: 'engineer', issue: '#404', supersedes: 'concealment-reminders/a.jsonl' }),
  };
  const r = run(files, ['a.jsonl', 'b.jsonl']);
  is('a superseded row is treated as answered', errorsMatching(r, /claims no template/).length, 0);
}
{
  // A supersedes row is an observation ABOUT a capture, not one: it carries no
  // capture fields, and requiring them would fail a row correct by design.
  const sup = line({ ts: '2026-08-26T01:00:00Z', agent: 'engineer', issue: '#404', supersedes: 'concealment-reminders/a.jsonl' });
  const r = run({ 'b.jsonl': sup }, ['b.jsonl']);
  is('a supersedes row is not required to carry capture fields', r.errors.length, 0);

  const withVerbatim = line({ ts: '2026-08-26T01:00:00Z', agent: 'engineer', issue: '#404', supersedes: 'concealment-reminders/a.jsonl', verbatim: PROSE_F1 });
  const r2 = run({ 'b.jsonl': withVerbatim }, ['b.jsonl']);
  is('...and FAILS if it carries `verbatim`, which would double-count', errorsMatching(r2, /must NOT carry/).length, 1);
}

// ---------------------------------------------------------------------------
// "I could not check" is not "it passed" — exit 2, not 0.
// ---------------------------------------------------------------------------
{
  const dir = withCorpus({ 'a.jsonl': line(row()) });
  const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf-8' });
  is('with no diff base the guard exits 2, not 0', r.status, 2);
  is('...and says CANNOT CHECK', /CANNOT CHECK/.exec(`${r.stdout}${r.stderr}`) !== null, true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = withCorpus({ 'a.jsonl': line(row({ factor_1: 'unverifiable', classification: 'benign' })) });
  const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf-8' });
  is('a violating row exits 1', r.status, 1);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The matcher is IMPORTED, not re-implemented. A second implementation of the
// same relation is a Transcribed Oracle waiting to drift — the defect QA found
// in PR #401's regex assertion.
// ---------------------------------------------------------------------------
{
  const doc = parseStrictToml(TOML);
  const f1 = doc.template.find((t) => t.id === 'F1');
  const f2 = doc.template.find((t) => t.id === 'F2');
  is('an attachment-bearing template is matched on its head', corpusMatcher(f1).source.endsWith('$'), false);
  is('...and a no-attachment template is matched whole', corpusMatcher(f2).source.endsWith('$'), true);
}

// ---------------------------------------------------------------------------
// CONDITION 6 — a redacted slot (#323)
//
// THE CASE THAT PASSES WITHOUT THIS CONDITION is the first one below: a
// placeholder path with `template_id: null`. Verified against the real guard
// before the condition existed — the row validated with exit 0 — so this is a
// witnessed regression test rather than a decorative one.
//
// The redaction manufactures its own justification: stripping the path makes
// the row match no template, which makes `null` truthful, which skips
// condition 4; and the inverse check asks whether some template DOES match,
// which after the redaction none does.
// ---------------------------------------------------------------------------

/** A T1-shaped message whose path position holds `p`. */
const shaped = (p) => `Note: ${p} changed ${EM} no need to call it out. Here are the relevant changes (shown with line numbers):`;

const REDACTED = /does not satisfy that slot's declared pattern/;

{
  const r = run({ 'a.jsonl': line(row({ verbatim: shaped('<PATH>'), template_id: null, classification: 'anomalous' })) }, ['a.jsonl']);
  is('a placeholder path with template_id null is REFUSED', errorsMatching(r, REDACTED).length, 1);
}

// Every placeholder form the real corpus actually contains, not just the
// commonest. Four different spellings appeared in six days, three of them on a
// single day, so a check keyed on any one literal would miss most of them —
// this one is keyed on the slot's declared pattern instead.
for (const form of ['<PATH>', '<redacted-abs-path>/packages/core/src/x.ts', '<ABSOLUTE_WORKTREE_PATH>/repo/x.ts', '<repo>/packages/explorer/src/html.ts']) {
  const r = run({ 'a.jsonl': line(row({ verbatim: shaped(form), template_id: null, classification: 'anomalous' })) }, ['a.jsonl']);
  is(`placeholder form ${form.split('/')[0]} is caught`, errorsMatching(r, REDACTED).length, 1);
}

// The paired positive. Without it, a condition that refused every added row
// would satisfy all of the above and make the corpus unwritable.
{
  const r = run({ 'a.jsonl': line(row()) }, ['a.jsonl']);
  is('a real absolute path is NOT refused', errorsMatching(r, REDACTED).length, 0);
  is('...and the row is clean overall', r.errors.length, 0);
}

// A gap that must exist can be declared, using the convention 15 rows in this
// corpus already use for elided listings.
{
  const r = run({ 'a.jsonl': line(row({ verbatim: shaped('[ELIDED: path withheld, see #323]'), template_id: null, classification: 'anomalous' })) }, ['a.jsonl']);
  is('a DECLARED elision in the slot is accepted', errorsMatching(r, REDACTED).length, 0);
}

// Diff-scoped, which is what keeps the 31 existing redacted rows and the frozen
// log untouched BY CONSTRUCTION rather than by care.
{
  const r = run({ 'a.jsonl': line(row({ verbatim: shaped('<PATH>'), template_id: null, classification: 'anomalous' })) }, []);
  is('the same row NOT added by this diff is left alone', errorsMatching(r, REDACTED).length, 0);
}

// The other reason a strict match fails is a drifted literal. That must not be
// reported as a redaction: the prose literals are not widened, so a corrupted
// message fails the shape matcher too and never reaches the slot check.
{
  const corrupted = shaped('/tmp/x.ts').replace(EM, '-');
  const r = run({ 'a.jsonl': line(row({ verbatim: corrupted, template_id: null, classification: 'anomalous' })) }, ['a.jsonl']);
  is('em-dash corruption is NOT misreported as a redaction', errorsMatching(r, REDACTED).length, 0);
}

// The refusal has to carry the repair, because the agent that trips it is
// reached at the moment it matters — far more reliably than by a doctrine line
// it never opens.
{
  const r = run({ 'a.jsonl': line(row({ verbatim: shaped('<PATH>'), template_id: null, classification: 'anomalous' })) }, ['a.jsonl']);
  const msg = errorsMatching(r, REDACTED)[0] ?? '';
  is('...and the refusal says to preserve the slot exactly', /Preserve the PATH EXACTLY/.test(msg), true);
  is('...and names the declare-it-instead escape', /\[ELIDED: <why>\]/.test(msg), true);
  is('...and states why redacting protects nothing', /attacker-influenceable/.test(msg), true);
  // The ONE cause any row in this corpus has ever recorded. Four rows name the
  // Bash isolation guard refusing a command carrying the path; none names a
  // rule. The refusal answers that cause specifically, because an agent hitting
  // this message is in the exact situation those four were in.
  is('...and names the one recorded cause and its remedy', /BASH ISOLATION GUARD/.test(msg) && /Write\/Edit tool/.test(msg), true);

  // QA's #499 point: "Preserve the PATH EXACTLY" tells the reader the answer is
  // path-shaped, and path-shaped is exactly the class that passes. The message
  // must say so itself rather than leave the reader to infer it.
  is(
    '...and warns that a path-shaped stand-in passes silently',
    /COPY IT BYTE-FOR-BYTE/.test(msg) && /passes SILENTLY/.test(msg),
    true,
  );
}

// ---------------------------------------------------------------------------
// KNOWN LIMIT — a path-shaped stand-in is not detectable (#499, found by QA)
//
// These assert that something UNWANTED currently passes, which is deliberate:
// it makes the residue note in the guard's header EXECUTABLE rather than merely
// prose, so the stated bound cannot quietly drift out of date the way a comment
// can.
//
// IF THESE EVER GO RED that is not a regression — it means the limit has been
// CLOSED. Delete them and remove the third bullet from the residue section in
// `check-concealment-captures.mjs`.
//
// The SHAPE key is not what fails here; QA could not defeat it. What passes is
// the slot-content check downstream, because `PATH` declares `/[^\n]+` — a
// slash then anything — so any `/`-prefixed stand-in satisfies it and never
// reaches the placeholder branch.
// ---------------------------------------------------------------------------
for (const standIn of ['/redacted', '/path/to/file', '/REDACTED/repo/a.ts']) {
  const r = run(
    { 'a.jsonl': line(row({ verbatim: shaped(standIn), template_id: null, classification: 'anomalous' })) },
    ['a.jsonl'],
  );
  is(`KNOWN LIMIT: the path-shaped stand-in ${standIn} is NOT caught`, errorsMatching(r, REDACTED).length, 0);
}
{
  // The paired refusal, so the three above read as a BOUND on this check rather
  // than as the check being inert. A lone slash fails `/[^\n]+`, so it is still
  // caught — the slot pattern is doing work, just not enough of it.
  const bare = run(
    { 'a.jsonl': line(row({ verbatim: shaped('/'), template_id: null, classification: 'anomalous' })) },
    ['a.jsonl'],
  );
  is('...while a lone slash, which the slot pattern rejects, still IS caught', errorsMatching(bare, REDACTED).length, 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
