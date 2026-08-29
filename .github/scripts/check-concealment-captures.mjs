#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Capture-schema validator for the concealment corpus (#388).
 *
 * The doctrine states an invariant — `factor_1 == "unverifiable"` implies
 * `classification == "anomalous"` — and names a checker that enforces it. That
 * checker did not exist in this repository. The invariant held by discipline
 * alone, which is the shape the corpus exists to catch, one level up.
 *
 * This FAILS, never warns. A warn is a log line, and an unread log line is
 * precisely what these fields were introduced to replace.
 *
 * ## What it does NOT do
 *
 * It does not replace review. It mechanises the half a script can decide, so a
 * QA cycle is spent on the half it cannot: whether `factor_1_basis` is honest,
 * and whether `stated_cause_evidence` was actually performed.
 *
 * ## THE RESIDUE, stated because a restated condition 4 reads as full coverage
 *
 * Condition 4 checks that a claimed `template_id` matches its `verbatim`. For
 * an attachment-bearing template it can only compare the PROSE, because a
 * capture legitimately elides its listing — so the stored bytes can never
 * exhibit what the attachment requires.
 *
 * T1 and T1C share `prose` BYTE-FOR-BYTE. The attachment therefore decides
 * exactly two things, and they are exactly the two a capture cannot show:
 *
 *   1. T1 vs T1C. Confusing the siblings is bookkeeping.
 *   2. benign vs anomalous. **This one is a real residue.** A row claiming a
 *      template whose attachment its true message would NOT have satisfied can
 *      be wrongly BENIGN, and nothing here sees it.
 *
 * That residue is CONTAINED rather than eliminated, and the containment is
 * Factor 1: it is an independent gate, so a wrongly-passing Factor 2 only
 * reaches "benign" on a row whose Factor 1 also passed. Contained is not
 * closed. Do not read condition 4 as covering it.
 *
 * ## Two conditions are narrower than the issue that specified them, on evidence
 *
 * Both were measured against the real corpus rather than reasoned about, and
 * both would have FAILED CORRECT ROWS as filed:
 *
 *   - "exactly one line per file" is enforced only on files this PR adds.
 *     THREE existing capture files hold several rows each (#328 holds three),
 *     and they are correct. Applied corpus-wide the check would fail them.
 *   - The full required-field set is enforced only on rows this PR adds. Older
 *     rows predate the schema and use different field names; absence of
 *     `factor_1` means "predates the field", which is a different fact from
 *     `unverifiable`, and conflating them corrupts the measurement.
 *
 * Corpus-wide, every check is scoped to rows CARRYING the field it is about.
 *
 * ## The inverse check is diff-scoped, and that is a decision with evidence
 *
 * A row claiming NO template while one matches is a defect — but only if the
 * template existed when the row was written. Of 43 inverse-shaped rows in the
 * corpus, 42 PREDATE T1C's merge and were correctly anomalous against the
 * allowlist of their moment. Run corpus-wide this check would fail 42 correct
 * rows, and the cheapest way to green the build would be to re-classify history
 * — corrupting the corpus the measurement depends on.
 *
 * Scoped to rows this PR ADDS, "the template existed at capture time" is true
 * by construction. Scope by what is knowable.
 *
 * ## Condition 6, and the residue it does NOT cover (#323)
 *
 * A redaction manufactures its own justification. Stripping the path makes the
 * row match no template, which makes `template_id: null` TRUTHFUL, which skips
 * condition 4; and the inverse check asks whether some template DOES match,
 * which after the redaction none does. Verified by running the guard, not
 * reasoned: the same row is REFUSED claiming `T1C` and PASSES with exit 0
 * claiming `null`. Condition 6 is therefore keyed on the message's SHAPE, which
 * is the only key the redaction cannot erase.
 *
 * Measured against the 31 redacted rows in the corpus at the time of writing,
 * had each been offered as an added row: **16 caught, 15 not.** The 15 divide
 * into two groups, and neither is a defect in this condition:
 *
 *   - **11 also carry the em-dash-to-hyphen corruption.** Their prose literals
 *     drifted, so the shape matcher declines them — deliberately. Reporting a
 *     corrupted message as a redaction would name the wrong defect.
 *   - **4 are not messages.** Their `verbatim` opens with the capturing agent's
 *     own summary ("Three notices, identical in prose apart from the path…"),
 *     so there is no message shape to match.
 *
 * The first group is a REAL residue: a row that is both redacted AND corrupted
 * is caught by neither condition. It is not closed here because closing it
 * means matching a message whose literals have drifted, which is the widening
 * that condition 4's guidance exists to forbid. Stated rather than fixed.
 *
 * ### The third class, which no row in the corpus exhibits (found by QA on #499)
 *
 * The two groups above bound what this condition misses AMONG THE 31. They are
 * not the whole bound, and reading them as one would be the mistake this
 * section exists to prevent:
 *
 *   - **A PATH-SHAPED placeholder is not detectable, and very likely cannot
 *     be.** The SHAPE key holds — QA could not defeat it. What it defeated is
 *     the slot-content check downstream. `PATH` declares `/[^\n]+`, a slash
 *     then anything, so ANY `/`-prefixed stand-in satisfies it and never
 *     reaches the placeholder branch. Verified end-to-end through `check()`
 *     against the real allowlist: `/redacted`, `/path/to/file` and
 *     `/REDACTED/repo/a.ts` all PASS, while `<PATH>` and a lone `/` are
 *     refused and a declared elision is accepted.
 *
 * This one is not "stated rather than fixed" in the same sense as the corrupted
 * group — it is stated because **closing it appears to require the answer**:
 * telling a fabricated absolute path from a real one means knowing the real
 * one, which is precisely what the row is supposed to be carrying. A stricter
 * slot pattern would only move the bar, since any rule describing a real path
 * also describes a stand-in built to satisfy it.
 *
 * Note the sharp edge, and do not sand it off: the refusal message below says
 * "Preserve the PATH EXACTLY", and **path-shaped is exactly the class that
 * passes** — so the instruction can steer an agent into the evasion while it
 * believes it has complied. The message therefore says explicitly that a
 * substituted stand-in is undetectable here, rather than relying on the reader
 * to infer it. WHAT REMAINS IS AN HONESTY REQUIREMENT ON THE CAPTURING AGENT,
 * and this file cannot enforce it.
 *
 * That matters more than it normally would, because the doctrine amendment for
 * #323 was DECLINED on the evidence: there is no doctrine text behind this
 * guard to catch a reader it misleads. This section is the remedy's
 * documentation, so an unstated bound here is unstated everywhere.
 *
 * Those four numbers are a DATED OBSERVATION, not a tally this file maintains —
 * nothing asserts them and they will drift as the corpus grows, which is fine.
 * The "no tallies" rule below governs the CHECKS, and no check here counts
 * anything. They are recorded because "16 caught" and "closes the class" are
 * very different claims, and the second one would be false.
 *
 * ## No tallies
 *
 * Every check here is a RELATION OVER ROWS. There is no hardcoded corpus count
 * anywhere in this file, deliberately: a pinned tally is the Frozen Snapshot
 * antipattern, and every count in this corpus moved within hours of being
 * written while every relationship held.
 *
 * Usage:
 *   node .github/scripts/check-concealment-captures.mjs [rootDir] [diffBase]
 *
 * Exit: 0 clean, 1 violations, 2 CANNOT CHECK.
 */

import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parseStrictToml,
  compileTemplate,
  TEMPLATES_REL,
  CORPUS_REL,
  FROZEN_CORPUS_REL,
} from './check-concealment-templates.mjs';
// Imported, never re-derived (#464/#449). `status === null` is true both for a
// spawn that failed to start and for one killed by a signal, and only the first
// sets `error` — so a hand-rolled `result.error.message` crashes on the second.
import { didNotStart, spawnFailureDetail } from './sdk-upgrade-drill.mjs';

/**
 * The channel enum, from the doctrine's capture-fields table.
 *
 * There is deliberately no `system-reminder` value: the wrapper is not
 * observable from inside a session, so a channel named for it could only ever
 * be a guess. `unknown` is the answer for "cannot establish" — and it is an
 * ANSWER, which is the whole reason a missing field is rejected separately.
 */
export const CHANNELS = Object.freeze([
  'tool-result-payload',
  'tool-result-adjacent',
  'trigger-body',
  'trigger-adjacent',
  'bare-system-turn',
  'file-content',
  'issue-or-pr-body',
  'commit-message',
  'external-message',
  'unknown',
]);

/**
 * Fields the doctrine requires of a capture.
 *
 * Taken from the doctrine's schema, NOT derived from what today's corpus
 * happens to contain — deriving it from the corpus would freeze a snapshot.
 * Verified against every row that carries `factor_1`: all of them carry all of
 * these, so doctrine and corpus agree today.
 */
export const REQUIRED_FIELDS = Object.freeze([
  'ts',
  'agent',
  'issue',
  'context',
  'verbatim',
  'template_id',
  'classification',
  'factor_1',
  'factor_1_basis',
  'channel',
  'stated_cause_frame',
  'stated_cause_evidence',
]);

/**
 * Opening words of the run-level note attached to a Condition 4 mismatch (#419).
 *
 * Exported because the self-test asserts on the guidance the same way it
 * asserts on the per-row message, and a second copy of this literal in the
 * test would be the Transcribed Oracle shape `docs/TESTING.md` names — a
 * description that agrees with the original today and drifts tomorrow.
 *
 * It doubles as the de-duplication key: the note is pushed once per run
 * however many rows trip the condition, which is the whole point of the split.
 */
export const TEMPLATE_MISMATCH_GUIDANCE_KEY = 'NOTE WHAT WAS CHECKED:';

/**
 * Opening words of the run-level note for an unresolvable allowlist history
 * (#462). Exported and de-duplicated for the same reasons as the key above.
 */
export const REVISION_CANNOT_CHECK_KEY = 'templates_revision NOT VERIFIED:';

/**
 * Required on rows a change ADDS, but NOT corpus-wide (#462).
 *
 * `templates_revision` records which revision of the allowlist a row was
 * classified against — the coordinate that makes a past classification
 * re-derivable, and the one #410 was filed about when a stale checkout produced
 * a confidently wrong Factor 2.
 *
 * It is separate from `REQUIRED_FIELDS` because those are enforced on any row
 * carrying `factor_1`, and 125 of 160 corpus rows lack this field. Enforcing it
 * there would fail history that cannot be repaired: the frozen log is never
 * rewritten and rows are never backfilled, so a backfilled coordinate would be
 * a guess presented as a record.
 *
 * Scoped to added rows it is exactly the `factor_1` bargain already struck in
 * this file — absence corpus-wide means "PREDATES THE FIELD", absence on a new
 * row is a defect — and it is what makes the corpus README's `## Required
 * fields` heading true rather than aspirational. Doc and validator disagreeing
 * is sufficient to produce divergence with no author error, which is the
 * mechanism #462 was filed about.
 */
export const REQUIRED_ON_ADDED_FIELDS = Object.freeze(['templates_revision']);

/** The allowlist path, relative to the repo root. */
const TEMPLATES_PATH = TEMPLATES_REL;

/** Shortest abbreviation git will resolve; below this a prefix means nothing. */
const MIN_ABBREV = 7;

/**
 * Every blob `.operum/audit/concealment-templates.toml` has ever had.
 *
 * WHY HISTORY RATHER THAN TODAY'S VALUE: six corpus rows record EARLIER
 * revisions (`3e1c4604` x4, `acd7bac3` x2). They are not noise around a correct
 * answer — they truthfully record what those agents actually read, which is the
 * field doing its job. The question is "is this the hash of that file's content
 * at SOME point", never "does it equal today's".
 *
 * The working-tree blob is included too: a change that edits the allowlist and
 * adds captures classified against the edit is recording something real that no
 * commit contains yet.
 *
 * Returns `{ blobs: Set<string> }` or `{ blobs: null, reason }`. NEVER an empty
 * set on failure — an empty set would fail every row, and "I could not check"
 * is not "they are all wrong" any more than it is "it passed".
 */
export function allowlistBlobHistory(rootDir) {
  const git = (args, opts = {}) => spawnSync('git', args, { cwd: rootDir, encoding: 'utf-8', ...opts });

  // A shallow clone has almost no history, so nearly every correct row would
  // look unresolvable. That is a property of the CHECKOUT, not of the rows.
  const shallow = git(['rev-parse', '--is-shallow-repository']);
  if (didNotStart(shallow)) {
    return { blobs: null, reason: `git could not run: ${spawnFailureDetail(shallow)}` };
  }
  if (shallow.status !== 0) {
    return { blobs: null, reason: `not a git repository, or git failed: ${(shallow.stderr || '').trim()}` };
  }
  if ((shallow.stdout || '').trim() === 'true') {
    return {
      blobs: null,
      reason:
        'the repository is a SHALLOW clone, so the allowlist\'s history is absent and a correct ' +
        'revision would look unresolvable. Actions needs `fetch-depth: 0`',
    };
  }

  const log = git(['log', '--all', '--format=%H', '--', TEMPLATES_PATH]);
  if (didNotStart(log)) return { blobs: null, reason: `git could not run: ${spawnFailureDetail(log)}` };
  if (log.status !== 0) return { blobs: null, reason: `git log failed: ${(log.stderr || '').trim()}` };

  const commits = (log.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);

  const blobs = new Set();

  // One batch call rather than one spawn per commit: this runs on every CI
  // invocation, and the file has a dozen revisions today but need not stay that
  // way.
  if (commits.length > 0) {
    const batch = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
      input: `${commits.map((c) => `${c}:${TEMPLATES_PATH}`).join('\n')}\n`,
    });
    if (didNotStart(batch)) return { blobs: null, reason: `git could not run: ${spawnFailureDetail(batch)}` };
    if (batch.status !== 0) return { blobs: null, reason: `git cat-file failed: ${(batch.stderr || '').trim()}` };
    for (const line of (batch.stdout || '').split('\n')) {
      const [name, type] = line.trim().split(/\s+/);
      if (type === 'blob' && /^[0-9a-f]{40}$/.test(name ?? '')) blobs.add(name);
    }
  }

  const working = git(['hash-object', '--', TEMPLATES_PATH]);
  if (working.status === 0) {
    const name = (working.stdout || '').trim();
    if (/^[0-9a-f]{40}$/.test(name)) blobs.add(name);
  }

  if (blobs.size === 0) {
    return { blobs: null, reason: `no blob of ${TEMPLATES_PATH} could be resolved from this checkout` };
  }
  return { blobs };
}

/** A row that supersedes another is an OBSERVATION about a capture, not one. */
const isSupersedes = (row) => typeof row.supersedes === 'string' && row.supersedes !== '';

/** Every corpus file, from both sources (#405). */
export function corpusFiles(rootDir) {
  const files = [];
  const frozen = join(rootDir, FROZEN_CORPUS_REL);
  if (existsSync(frozen)) files.push({ path: frozen, rel: FROZEN_CORPUS_REL, frozen: true });
  const dir = join(rootDir, CORPUS_REL);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.jsonl')) files.push({ path: join(dir, f), rel: `${CORPUS_REL}/${f}`, frozen: false });
    }
  }
  return files;
}

/**
 * The corpus-side relation, reusing the templates guard's own selection.
 *
 * An attachment-bearing template is compared on its PROSE, because captures
 * elide the attachment — the same rule `check-concealment-templates.mjs`
 * already applies in evidence binding and in `corpus_matches`. That selection
 * is imported rather than restated: a second implementation of the same
 * relation is a Transcribed Oracle waiting to drift.
 */
export function corpusMatcher(template) {
  const compiled = compileTemplate(template);
  const wholeRequired = (template.trailing_attachment ?? 'none') === 'none';
  return wholeRequired ? compiled.whole : compiled.head;
}

/**
 * The same relation as `corpusMatcher`, but with every slot widened to "any
 * text on one line" and CAPTURING.
 *
 * This exists to separate two failures that `corpusMatcher` collapses into one.
 * When a capture's path is replaced by a placeholder the message stops matching
 * its template — indistinguishably, from the strict matcher's side, from a
 * message that was never that template at all. Widening the slots recognises
 * the message's SHAPE, so the slot's CONTENT can then be judged on its own.
 *
 * The prose literals are NOT widened. That is what keeps this from
 * mis-reporting the other failure: a row that fails the strict match because a
 * literal drifted (the em-dash-to-hyphen corruption) fails this matcher too,
 * and never reaches the slot check.
 *
 * Returns the slot names in prose order alongside the regex, so capture group
 * `i + 1` is the content of `names[i]`.
 */
export function slotShapeMatcher(template) {
  const widened = {
    ...template,
    slot: (template.slot ?? []).map((s) => ({ ...s, pattern: '([^\\n]+)' })),
  };
  const compiled = compileTemplate(widened);
  const wholeRequired = (template.trailing_attachment ?? 'none') === 'none';
  return { names: compiled.names, re: wholeRequired ? compiled.whole : compiled.head };
}

/**
 * Slot content that DECLARES its own elision.
 *
 * The corpus already has this convention and agents already follow it — 15 rows
 * annotate an elided listing in-band as `[ELIDED: ...]`, `[ATTACHMENT ELIDED:
 * ...]` or `[ELIDED BY THE CAPTURING AGENT: ...]`. What none of them did was
 * use it for a redacted PATH, which is the gap this reuses it to close: the
 * shape is accepted anywhere a slot is, so a gap that must exist can be
 * self-describing instead of silent.
 *
 * Anchored, and deliberately not a substring test: a bare `<PATH>` sitting next
 * to an unrelated bracketed aside must not read as a declaration.
 */
export const DECLARED_ELISION = /^\[[^\]]*ELIDED[^\]]*\]$/;

/** Code points above ASCII in `s`, as a sorted list of unique escapes. */
function nonAscii(s) {
  const out = new Set();
  for (const ch of s) if (ch.codePointAt(0) > 0x7f) out.add(ch);
  return [...out].sort();
}

/** Files under the corpus directory that this diff ADDS or MODIFIES. */
function changedCorpusFiles(rootDir, base) {
  const r = spawnSync('git', ['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`, '--', CORPUS_REL], {
    cwd: rootDir,
    encoding: 'utf-8',
  });
  if (r.status !== 0) return null;
  return new Set(
    r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.jsonl')),
  );
}

export function check(rootDir, { diffBase = null, addedFiles = null } = {}) {
  const errors = [];
  const notes = [];
  const cannotCheck = [];
  // Run-level guidance: advice about an error CLASS, emitted ONCE however many
  // rows trip it (#419). Kept out of `errors` so it never inflates the problem
  // count — it is not itself a problem.
  const guidance = [];

  const tomlPath = join(rootDir, TEMPLATES_REL);
  if (!existsSync(tomlPath)) {
    return { errors, notes, guidance, cannotCheck: [`${TEMPLATES_REL} does not exist, so no row's template_id can be checked`] };
  }

  let templates;
  try {
    const doc = parseStrictToml(readFileSync(tomlPath, 'utf-8'));
    templates = new Map((doc.template ?? []).map((t) => [t.id, t]));
  } catch (e) {
    return { errors, notes, guidance, cannotCheck: [`${TEMPLATES_REL} does not parse: ${e.message}`] };
  }
  if (templates.size === 0) {
    return { errors, notes, guidance, cannotCheck: ['the allowlist declares no templates'] };
  }

  const files = corpusFiles(rootDir);
  if (files.length === 0) {
    // Not an error: a checkout may legitimately have no captures yet. But say
    // so — "nothing to check" and "all clean" must not render identically.
    notes.push('no corpus files found; nothing to validate');
    return { errors, notes, guidance, cannotCheck };
  }

  // Diff scope. Null means "could not determine", which is NOT "nothing was
  // added" — those must not collapse.
  //
  // `addedFiles` is an injection point for the self-test, which needs to drive
  // the diff-scoped conditions without standing up a git fixture. The diff-scoped
  // conditions are extra rather than a bypass, so an OVER-reporting value makes
  // the guard stricter.
  //
  // An UNDER-reporting value makes it WEAKER, and says nothing about it. An
  // empty set — or one naming paths that do not exist — drops the diff-scoped
  // checks, AND suppresses the `cannotCheck` note that would report their
  // absence, because that note is only reached when `added === null`. Stating
  // this in one direction and implying both is the compensating-control shape
  // this validator exists to catch, one level down in its own justification.
  //
  // What actually contains it is narrower than "stricter, not weaker" and is
  // worth naming precisely: `main()` never passes the parameter, so on every
  // invocation that VALIDATES THE REAL CORPUS, `added` comes from git or is
  // null.
  //
  // NOT "every path CI takes", which is what this said and was false. CI also
  // runs the self-test, which injects `addedFiles` deliberately — that is the
  // point of the parameter. The narrower claim is also the STRONGER one: it
  // covers exactly the invocations whose integrity matters, instead of a wider
  // set that happens to be untrue. It survives the self-test because the
  // self-test drives `check` over a temporary fixture corpus and never over
  // this repository's.
  //
  // THIS SENTENCE HAS NOW BEEN CORRECTED TWICE FOR THE SAME SHAPE — first for
  // stating one direction and implying both, then for claiming a scope wider
  // than it holds. That is the shape described in the paragraph above, and
  // this justification keeps reproducing it. Worth knowing before editing it a
  // third time: check the claim against `main()` and the self-test rather than
  // against how reasonable it reads.
  let added = addedFiles;
  if (added === null) {
    if (diffBase !== null) {
      added = changedCorpusFiles(rootDir, diffBase);
      if (added === null) cannotCheck.push(`could not diff against '${diffBase}', so no diff-scoped check ran`);
    } else {
      cannotCheck.push('no diff base supplied, so no diff-scoped check ran');
    }
  }

  const supersededPaths = new Set();
  const rows = [];

  for (const file of files) {
    const text = readFileSync(file.path, 'utf-8');
    const lines = text.split('\n');
    const nonBlank = lines.filter((l) => l.trim() !== '');

    const isAdded = added !== null && added.has(file.rel);

    // CONDITION 1a — one row per file, on files this PR adds. Three existing
    // files hold several rows and are correct, so this is not retroactive.
    if (isAdded && !file.frozen && nonBlank.length !== 1) {
      errors.push(
        `${file.rel}: a capture file added by this change must hold EXACTLY ONE row, found ${nonBlank.length}. ` +
          `One file per entry is what keeps two agents capturing at the same moment from colliding.`,
      );
    }

    for (const [i, line] of nonBlank.entries()) {
      // CONDITION 1b — valid JSON, corpus-wide.
      let row;
      try {
        row = JSON.parse(line);
      } catch (e) {
        errors.push(`${file.rel} row ${i + 1}: not valid JSON — ${e.message}`);
        continue;
      }
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        errors.push(`${file.rel} row ${i + 1}: not a JSON object`);
        continue;
      }
      if (isSupersedes(row)) supersededPaths.add(row.supersedes);
      rows.push({ file, row, index: i + 1, isAdded });
    }
  }

  // Resolved ONCE per run rather than per row: it costs three git spawns, and
  // 40 rows carry the field today across only three distinct values.
  const blobHistory = allowlistBlobHistory(rootDir);

  for (const { file, row, index, isAdded } of rows) {
    const where = `${file.rel} row ${index}`;

    // A supersedes row is an observation ABOUT a capture. It deliberately
    // carries no `verbatim` — that is what keeps it out of every template's
    // denominator — so requiring capture fields of it would fail a row that is
    // correct by design, and the natural fix would reintroduce the double-count.
    if (isSupersedes(row)) {
      if ('verbatim' in row) {
        errors.push(
          `${where}: a \`supersedes\` row must NOT carry \`verbatim\`. With one it enters a template's live ` +
            `denominator and double-counts against the row it supersedes.`,
        );
      }
      continue;
    }

    // CONDITION 2 — required fields.
    //
    // Corpus-wide this is scoped to rows carrying `factor_1`, the marker of the
    // current schema. On rows this PR ADDS it applies in full: a new capture
    // that omits both `factor_1` and `channel` would otherwise escape entirely.
    const inSchema = 'factor_1' in row;
    if (inSchema || isAdded) {
      for (const field of REQUIRED_FIELDS) {
        if (!(field in row)) {
          errors.push(
            `${where}: missing required field \`${field}\`. An ABSENT field is not an answer — ` +
              `\`unknown\` is a value a query can count, a missing field is a row a query silently does not see.`,
          );
        }
      }
    }

    // CONDITION 2a — required only on ADDED rows (#462).
    //
    // The doc/validator disagreement is the mechanism: the corpus README lists
    // `templates_revision` under `## Required fields` while `REQUIRED_FIELDS`
    // omits it, so a row omitting it is simultaneously wrong by the docs and
    // fine by the check — divergence with NO author error required. This is the
    // half of the repair that lives in the validator; the README's own wording
    // is amended alongside it.
    if (isAdded) {
      for (const field of REQUIRED_ON_ADDED_FIELDS) {
        if (!(field in row)) {
          errors.push(
            `${where}: missing required field \`${field}\`. It records WHICH REVISION of the allowlist ` +
              `this row was classified against, which is what makes the classification re-derivable later ` +
              `(#410: a stale checkout yields a confidently wrong Factor 2, and nothing else in the row ` +
              `reveals it). Record it with \`git hash-object ${TEMPLATES_PATH}\` — the BLOB hash of the ` +
              `allowlist you actually read, not the commit that last changed it. Absence is required only ` +
              `on rows a change ADDS; corpus-wide it means "predates the field", so history is untouched.`,
          );
        }
      }
    }

    // CONDITION 2c — a recorded revision must RESOLVE (#462).
    //
    // A FORMAT CHECK IS THE OBVIOUS WRONG REACH, and it is why the one bad value
    // ever written survived. `af6100c4` is a commit SHA; `b6ab2b98` is a blob
    // hash; both are hex abbreviations of a git object and nothing about their
    // SHAPE distinguishes them. Only resolving the object does. That value even
    // named the RIGHT revision — the commit that last modified the allowlist —
    // by a route that is not content-addressed, so it cannot answer "was my
    // allowlist the same as main's?" by string comparison, which is the field's
    // only purpose. It passed this validator twice and was caught by a human.
    if ('templates_revision' in row) {
      const raw = row.templates_revision;
      const value = typeof raw === 'string' ? raw.trim().toLowerCase() : null;

      if (value === null || !/^[0-9a-f]+$/.test(value) || value.length < MIN_ABBREV) {
        errors.push(
          `${where}: \`templates_revision\` is ${JSON.stringify(raw)}, which is not a resolvable git object ` +
            `id (expected at least ${MIN_ABBREV} hex characters). Record it with ` +
            `\`git hash-object ${TEMPLATES_PATH}\`.`,
        );
      } else if (blobHistory.blobs === null) {
        // NEVER a pass, and never a fail either: the rows may be perfectly
        // correct and this checkout simply cannot tell. Reported once per run.
        if (!cannotCheck.some((c) => c.startsWith(REVISION_CANNOT_CHECK_KEY))) {
          cannotCheck.push(
            `${REVISION_CANNOT_CHECK_KEY} ${blobHistory.reason}. No row's \`templates_revision\` was ` +
              `resolved, so this run did not verify any of them.`,
          );
        }
      } else if (![...blobHistory.blobs].some((b) => b.startsWith(value))) {
        const detail =
          `${where}: \`templates_revision\` ${JSON.stringify(raw)} does not resolve to any blob of ` +
          `${TEMPLATES_PATH} in this repository's history. The likely cause is recording a COMMIT SHA — ` +
          `the commit that last changed the allowlist — instead of the hash of the file's CONTENT. Both ` +
          `are hex object ids and both may name the same revision, but only the blob hash is ` +
          `content-addressed, which is the field's entire purpose. Use \`git hash-object ${TEMPLATES_PATH}\`.`;

        if (isAdded) {
          errors.push(detail);
        } else {
          // A PRE-EXISTING ROW CANNOT BE REPAIRED. The frozen log is never
          // rewritten and rows are never backfilled, so failing here would
          // demand an action no one is permitted to take — a permanently red
          // build with no legal remedy, which is how a guard gets switched off.
          // Surfaced as a note so it is visible without being actionable-looking.
          notes.push(`${detail} NOT FAILED: this row predates the check and cannot be rewritten.`);
        }
      }
    }

    // CONDITION 2b — channel enum.
    if ('channel' in row && !CHANNELS.includes(row.channel)) {
      errors.push(
        `${where}: \`channel\` is ${JSON.stringify(row.channel)}, which is not one of the documented values ` +
          `(${CHANNELS.join(', ')}).`,
      );
    }

    // CONDITION 3 — the asserted invariant. Fails, never warns.
    if (row.factor_1 === 'unverifiable' && row.classification !== 'anomalous') {
      errors.push(
        `${where}: \`factor_1: "unverifiable"\` with \`classification: ${JSON.stringify(row.classification)}\`. ` +
          `Either factor being unverifiable routes ANOMALOUS regardless of the other — "I could not check" is never "it passed".`,
      );
    }

    const claimed = row.template_id ?? null;
    const verbatim = typeof row.verbatim === 'string' ? row.verbatim : null;

    // CONDITION 4 — a claimed template must match its verbatim.
    //
    // HEAD-match for attachment-bearing templates, because a capture elides its
    // listing. See the residue note in this file's header before reading this
    // as full coverage.
    if (claimed !== null && verbatim !== null) {
      const template = templates.get(claimed);
      let matched = null;
      if (template === undefined) {
        errors.push(`${where}: claims \`template_id: ${JSON.stringify(claimed)}\`, which is not in the allowlist.`);
      } else if ((matched = corpusMatcher(template).exec(verbatim)) === null) {
        // SPLIT PER-ROW DIAGNOSIS FROM RUN-LEVEL PROHIBITIONS (#419).
        //
        // The whole 610-character block used to be emitted per violating row,
        // so N violations produced N copies of a tail that is identical every
        // time. The tail is advice about the error CLASS — what the matcher
        // compared, and the two repairs not to attempt — so it belongs once
        // per run, not once per row.
        //
        // WHAT DELIBERATELY DID NOT CHANGE: the first sentence. The measured
        // reason the long message worked is that the actionable diagnosis is
        // at the FRONT, which is where the failure mode of a long warning does
        // not bite. Shortening it to reduce repetition would have traded the
        // property that makes the message work for the one that makes it
        // shorter. The per-row line now carries only what differs between
        // rows; hoisting the tail leaves the diagnosis first and alone.
        errors.push(
          `${where}: claims \`template_id: ${JSON.stringify(claimed)}\` but that template's PROSE does not match ` +
            `the row's \`verbatim\`. Either the row cites the wrong template, or a literal drifted from the captured ` +
            `message (the em-dash-to-hyphen corruption is the observed case).`,
        );
        if (!guidance.some((g) => g.startsWith(TEMPLATE_MISMATCH_GUIDANCE_KEY))) {
          guidance.push(
            `${TEMPLATE_MISMATCH_GUIDANCE_KEY} for a template declaring a trailing attachment this compares ` +
              `the PROSE ONLY, because a capture elides its listing by doctrine. Do NOT "fix" this by editing ` +
              `the stored \`verbatim\` to force a whole-message match, and do NOT widen the matcher — ` +
              `whole-message matching fails 24 correct rows in this corpus.`,
          );
        }
      } else {
        // CONDITION 5 — the em-dash check, scoped to the PROSE.
        //
        // The doctrine says "non-ASCII in `verbatim` beyond those the cited
        // template's prose contains". Applied to the WHOLE verbatim that is
        // wrong, and the corpus says so: two correct rows quote source lines
        // containing U+00A7 and U+00B7 inside their LISTING. An attachment is
        // file content and may legitimately hold any character; only the prose
        // is transcribed, so only the prose can drift.
        //
        // The matched region IS the prose region — that is what a head-match
        // returns — so it is taken from the match rather than re-derived.
        const prose = matched[0];
        const allowed = new Set(nonAscii(template.prose ?? ''));
        const stray = nonAscii(prose).filter((ch) => !allowed.has(ch));
        if (stray.length > 0) {
          const rendered = stray
            .map((ch) => `${JSON.stringify(ch)} (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`)
            .join(', ');
          errors.push(
            `${where}: \`verbatim\` contains non-ASCII not present in template ${claimed}'s prose: ${rendered}. ` +
              `A reviewer cannot tell an em dash from a hyphen at a glance; this corpus has lost one eleven times.`,
          );
        }
      }
    }

    // THE INVERSE CHECK — diff-scoped, and skipping superseded rows.
    //
    // A row claiming NO template while one matches is a defect only if that
    // template existed when the row was written. On a row this PR adds, it did,
    // by construction.
    if (isAdded && claimed === null && verbatim !== null && !supersededPaths.has(file.rel.replace(/^\.operum\/audit\//, ''))) {
      const matching = [...templates.values()].filter((t) => corpusMatcher(t).exec(verbatim) !== null).map((t) => t.id);
      if (matching.length > 0) {
        errors.push(
          `${where}: claims no template, but ${matching.join(' / ')} matches its \`verbatim\`. ` +
            `A row added now is classified against the current allowlist, so "no template covers this" is checkable.`,
        );
      }
    }

    // CONDITION 6 — a slot whose content was replaced by a placeholder (#323).
    //
    // REDACTION MANUFACTURES ITS OWN JUSTIFICATION, and every check above it
    // is thereby skipped. Verified by running, not reasoned: a real T1C row
    // whose path is replaced by `<PATH>` is REFUSED while it still claims
    // `template_id: "T1C"` (condition 4), and the SAME row PASSES with exit 0
    // once it claims `template_id: null`. Stripping the path makes the row
    // match no template, which makes `null` truthful, which skips condition 4;
    // and the inverse check cannot fire either, because it asks whether some
    // template DOES match — and after the redaction none does.
    //
    // So this condition is keyed on the message's SHAPE rather than on any
    // claimed template, which is the only key the redaction cannot erase.
    //
    // Diff-scoped for the same reason as the inverse check: the 31 redacted
    // rows already in the corpus predate this, they are not retroactively
    // fixable (the original text is gone), and the frozen log and existing
    // per-entry files are NEVER rewritten or backfilled. Scoping by `isAdded`
    // makes that hold by construction rather than by care.
    if (isAdded && verbatim !== null) {
      for (const template of templates.values()) {
        const { names, re } = slotShapeMatcher(template);
        const shaped = re.exec(verbatim);
        if (shaped === null) continue;

        for (let i = 0; i < names.length; i++) {
          const slot = (template.slot ?? []).find((s) => s.name === names[i]);
          const content = shaped[i + 1];
          if (slot === undefined || typeof content !== 'string') continue;
          if (new RegExp(`^(?:${slot.pattern})$`).test(content)) continue;
          if (DECLARED_ELISION.test(content)) continue;

          // Diagnosis FIRST, then the repair — the ordering this file's
          // condition-4 note records as the measured reason a long message
          // still works.
          errors.push(
            `${where}: the <${slot.name}> slot holds ${JSON.stringify(content.slice(0, 80))}, which does not satisfy ` +
              `that slot's declared pattern — it reads as a placeholder substituted for the captured content. ` +
              `Preserve the ${slot.name} EXACTLY as the harness rendered it: it is what whole-message matching anchors ` +
              `on, it is not sensitive data (it is a message the harness sent you), and it is already declared ` +
              `attacker-influenceable — so redacting it protects nothing the anchoring does not already contain, ` +
              `while making the row unusable as Factor 2 evidence. ` +
              `COPY IT BYTE-FOR-BYTE: do not retype it, shorten it, or substitute a plausible-looking stand-in. ` +
              `A stand-in that merely LOOKS like a path satisfies this check and passes SILENTLY — the slot's ` +
              `declared pattern is a slash followed by anything, and telling a fabricated path from a real one ` +
              `would require already knowing the real one. So this refusal is the last point at which a ` +
              `substitution is visible to anyone, and past it the corpus simply believes you. ` +
              `IF YOU GOT HERE BECAUSE THE BASH ISOLATION GUARD REFUSED A COMMAND CARRYING THE PATH: that is the ` +
              `only cause any row in this corpus has ever recorded for a redaction (4 of them name it). Do not drop ` +
              `the path to get past it — write the capture with the Write/Edit tool instead, which routes no content ` +
              `through a shell and has no such refusal. ` +
              `If it genuinely must be elided, declare it IN THE SLOT using this corpus's existing convention — a ` +
              `bracketed note naming the elision, e.g. "[ELIDED: <why>]" — so the gap describes itself instead of ` +
              `being silent.`,
          );
        }
        // One shape-match is enough: T1/T1C/T1B share the PATH slot and its
        // pattern, so a second match would re-report the same slot.
        break;
      }
    }
  }

  notes.push(`validated ${rows.length} row(s) across ${files.length} corpus file(s)`);
  if (added !== null) notes.push(`${added.size} corpus file(s) added or modified by this change`);
  return { errors, notes, guidance, cannotCheck };
}

function main(argv) {
  const root = resolve(argv[2] ?? '.');
  const diffBase = argv[3] ?? null;
  const { errors, notes, guidance, cannotCheck } = check(root, { diffBase });

  for (const n of notes) console.log(`  note: ${n}`);

  if (errors.length > 0) {
    console.error(`\ncheck-concealment-captures: ${errors.length} problem(s) in the capture corpus\n`);
    for (const e of errors) console.error(`  - ${e}`);
    // Run-level advice, printed once between the rows and the closing note
    // (#419). It sits AFTER the errors because it explains a class the reader
    // has just seen instances of; before them it would be context for nothing.
    for (const g of guidance) console.error(`\n  ${g}`);
    console.error('\nThese rows are the evidence base for the Factor 2 allowlist and for every');
    console.error('measurement made over the classifier. A row that is wrong in a machine-read');
    console.error('field is worse than a missing row, because it is counted.');
    return 1;
  }

  if (cannotCheck.length > 0) {
    console.error('\ncheck-concealment-captures: CANNOT CHECK\n');
    for (const c of cannotCheck) console.error(`  - ${c}`);
    console.error('\n"I could not check" is not "it passed", so this exits 2 rather than 0.');
    return 2;
  }

  console.log('check-concealment-captures: OK — every capture row satisfies the schema and its stated invariant.');
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  process.exit(main(process.argv));
}
