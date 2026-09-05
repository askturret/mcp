#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Stage 1 of the mutation audit (#428): measure which failure sites have a
 * witness, and report. It does NOT fail on unwitnessed sites.
 *
 * ## What a "site" is, and why it is not `errors.push`
 *
 * The proposal keyed on `errors.push`. Measured against this tree that covers
 * 47 of 113 failure sites and 6 of 24 scripts, while reporting that "the guards
 * are mutation-audited" — #428's own defect shape inside its fix. **18 of 24
 * scripts contain no `errors.push` at all.**
 *
 * So the key is the failure OUTCOME — a guard fails by exiting non-zero — and
 * the enumeration below is the set of routes to it:
 *
 *   errors.push(...)          deferred, drained by `if (errors.length) exit(1)`
 *   throw ...                 uncaught, exits non-zero
 *   process.exit(<non-zero>)  direct
 *   return <non-zero int>     from a `main()` whose result is passed to exit
 *
 * That list is still a CLAIM. `completenessProbe` below is what turns it into
 * an observation.
 *
 * ## What this measures, and what it cannot
 *
 * A site is WITNESSED when neutralising it turns its guard's self-test red. The
 * honest limit: witnessed **relative to what that self-test exercises**. A
 * failure path the self-test never triggers stays invisible — but such a path
 * is unwitnessed by definition, so the blind spot points the same way as the
 * finding rather than against it.
 *
 * ## The mutation traps, and the one that INVERTS here
 *
 * `docs/TESTING.md` catalogues five. Applied to an automated runner:
 *
 *   1  edit breaks the file    THE DANGEROUS ONE. Here RED = PASS, so a
 *                              syntax-broken mutation reddens the self-test and
 *                              the site records as WITNESSED. The audit becomes
 *                              silently too PERMISSIVE — the opposite of the
 *                              failure you would expect. `node --check` runs
 *                              before EVERY self-test run; a parse failure is an
 *                              audit error, never a pass.
 *   2  mutation lands elsewhere  No textual `String.replace` anywhere. Sites are
 *                              byte offsets found in MASKED source, so a match
 *                              cannot be inside a comment or string, and the
 *                              exact original text at the offset is asserted
 *                              before splicing.
 *   3  residue                 Every run restores the file from the original
 *                              bytes and verifies the restore.
 *   4  status-only assertion   Exit status IS this audit's signal, so the newly
 *                              failing assertion NAMES are reported alongside it.
 *   5  vacuous green           A non-green baseline is CANNOT CHECK, never
 *                              "witnessed".
 *
 * ## Usage
 *
 *   node .github/scripts/check-mutation-audit.mjs [rootDir] [--write]
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  symlinkSync,
  readlinkSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, relative, isAbsolute, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isProcessEntryPoint } from './lib/entry-point.mjs';

import { didNotStart, spawnFailureDetail } from './sdk-upgrade-drill.mjs';

export const SCRIPTS_REL = '.github/scripts';
export const INVENTORY_REL = '.operum/audit/mutation-audit-inventory.md';

/** Where a site's neutralisation is spliced, and what it becomes. */
export const SITE_KINDS = Object.freeze([
  'errors-push',
  'throw',
  'process-exit',
  'return-code',
  'result-code',
]);

/* -------------------------------------------------------------------------
 * Masking — the whole defence against trap 2
 *
 * Every byte that is not executable code becomes a space, and offsets are
 * preserved exactly. A site found in the masked text is therefore in real code
 * by construction, which is what makes "anchor by offset" meaningful rather
 * than a restatement of "replace the first occurrence".
 * ---------------------------------------------------------------------- */

/** Chars after which a `/` opens a regex rather than dividing. */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '+', '-', '*', '%', '<', '>', '~', '^']);

export function maskCode(src) {
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = src[i];

  const blank = (from, to) => {
    for (let i = from; i < to && i < src.length; i += 1) {
      out[i] = src[i] === '\n' ? '\n' : ' ';
    }
  };

  let i = 0;
  let lastSignificant = '\n';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      blank(i, Math.min(j + 2, src.length));
      i = j + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j += 1;
      }
      // Keep the quotes so the token stream still balances; blank the inside.
      blank(i + 1, j);
      lastSignificant = c;
      i = j + 1;
      continue;
    }
    if (c === '/' && REGEX_PRECEDERS.has(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') break;
        j += 1;
      }
      blank(i + 1, j);
      lastSignificant = '/';
      i = j + 1;
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }

  return out.join('');
}

/** 1-indexed line of a byte offset. */
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/**
 * The site's own source line, whitespace-normalised (#532).
 *
 * THE LEDGER'S IDENTITY KEY, and the reason it is text rather than a number.
 * An exemption names ONE site, and `script + kind` names dozens —
 * `check-concealment-captures.mjs` alone holds 15 `errors-push` sites. A line
 * NUMBER identifies one, but it drifts on any edit above it, and the danger is
 * not that it goes stale: it is that it silently re-points at a DIFFERENT site
 * of the same kind, so the exemption comes to cover code nobody examined.
 *
 * The site's own text goes stale exactly when THAT code changes — which is when
 * the exemption should be re-examined — and survives unrelated edits elsewhere.
 * It is also legible in review, which a hash would not be, and 46 dispositions
 * (#533) are written and read through this field.
 */
export const siteSource = (src, index) => {
  const start = src.lastIndexOf('\n', index - 1) + 1;
  const end = src.indexOf('\n', index);
  return src.slice(start, end === -1 ? src.length : end).trim().replace(/\s+/g, ' ');
};

/* -------------------------------------------------------------------------
 * The exemption ledger (#532, conditions 3-6)
 * ---------------------------------------------------------------------- */

/**
 * Sites this audit cannot witness, each with what would change that.
 *
 * ## EMPTY BY DESIGN, and that is a statement rather than a gap
 *
 * Dispositioning the 46 unwitnessed sites is #533, and it is deliberately not
 * done here: the method requirement is that no exemption may be written until
 * MASKING is excluded for that site, which is per-site work against the #349
 * prior. Bulk-seeding this from the audit's own unwitnessed list would produce
 * 46 entries that assert exactly what the audit already said, and would launder
 * a measurement into a set of claims nobody checked.
 *
 * So the machinery ships with nothing in it, the count prints every run
 * (condition 6), and the entries arrive one at a time with their evidence.
 *
 * ## Both directions, and the second is the one that gets skipped
 *
 *   covered site   neutralise it -> self-test goes RED
 *                  if not: unwitnessed. REPORTED here, not failed — the
 *                  fail-closed flip is #434 and is NOT discharged by this.
 *
 *   exempt site    neutralise it -> self-test stays GREEN
 *                  if not: THE EXEMPTION IS FALSE, and this fails.
 *
 * A one-directional ledger cannot notice decay: someone adds a fixture, the
 * site becomes witnessed, the exemption silently becomes a lie, and nothing
 * says so. Stage 1 hit that exact shape in `WIRING_EXEMPT`. The decay direction
 * is the reason this exists at all.
 *
 * ## What an entry must carry
 *
 *   script            basename of the guard
 *   kind              one of SITE_KINDS
 *   source            the site's own source line, whitespace-normalised.
 *                     See `siteSource` for why identity is text, not a number.
 *   reason            why the self-test cannot witness it
 *   unblockedBy       what would have to CHANGE to witness it (condition 4).
 *                     An exemption that cannot name this is almost always
 *                     "nobody tried", which is why the field is required rather
 *                     than encouraged.
 *   maskingExcluded   how masking was ruled out for THIS site. The method
 *                     requirement from the #434 ruling: a hidden failure route
 *                     can make a genuinely witnessed site RECORD as unwitnessed
 *                     (QA demonstrated it with `process.exitCode = 1`), and an
 *                     exemption written over one of those is false the day it
 *                     lands — born wrong rather than gone stale, so the decay
 *                     check above would never catch it.
 */
export const MUTATION_EXEMPT = Object.freeze([
  // THE FIRST TWO ENTRIES THIS LEDGER HAS EVER CARRIED (#558). Both come from
  // check-concealment-templates' fifteen, and they are exempt for DIFFERENT
  // reasons — one cannot be reached, the other cannot be mutated. Writing them
  // as one category would have hidden that.
  {
    script: 'check-concealment-templates.mjs',
    kind: 'throw',
    source: `if (s[i] !== '"') throw new TomlError(\`line \${lineNo}: expected a '"'-quoted string\`);`,
    reason:
      'UNREACHABLE from the module\'s public surface. `readBasicString` has exactly two call sites and both ' +
      'establish the precondition first: the array reader throws its own "arrays hold quoted strings only" ' +
      'immediately above its call, and the value parser only calls it under `rest.startsWith(\'"\')`. So no ' +
      'document can enter this function with a non-quote at `i`. This names the INVARIANT rather than a ' +
      'neighbouring guard that happens to sit in front of a different path — the distinction #543 turned on.',
    unblockedBy:
      'Exporting `readBasicString` and calling it directly with a non-quote would witness it, and is ' +
      'deliberately NOT done: it reaches through the invariant that makes the branch unreachable, which is ' +
      'the fabricated witness #543 declined. A THIRD call site that does not pre-check would make it ' +
      'genuinely reachable, and is what should re-open this entry.',
    maskingExcluded:
      'Instrumented the branch and ran the full self-test: 0 entries across 164 passing assertions. The same ' +
      'instrumentation on line 249 — a site the corpus does reach — records 1, so the zero is a measurement ' +
      'rather than a probe that cannot see. A suppressed red would still have executed the branch.',
  },
  {
    script: 'check-concealment-templates.mjs',
    kind: 'throw',
    source: 'if (idx >= lines.length) throw new TomlError(`line ${lineNo}: unterminated array`);',
    // READ BY `auditGuard`, which does not mutate this site at all (#558).
    // Without it the audit neutralises the throw and never returns — measured:
    // the same neutralisation terminates in ~2s against the PREVIOUS self-test
    // and does not terminate against the one this change ships. The
    // non-termination is a property of SITE x FIXTURE, and this ledger entry
    // described it as a property of the site alone.
    mutationDoesNotTerminate: true,
    reason:
      'NOT MUTATABLE, which is different from not reachable — a fixture reaches it easily and the self-test ' +
      'has one. This throw is the ONLY exit from `while (!rest.trimEnd().endsWith(\']\'))`. Neutralised, `idx` ' +
      'runs past `lines.length`, `lines[idx]` is undefined, and `rest` grows by "\\nundefined" forever. The ' +
      'mutant does not compute a wrong answer; it does not terminate, so no assertion is ever reached to redden.',
    unblockedBy:
      'A second bound on that loop — a maximum line count, or hoisting the length test into the condition — ' +
      'would make the mutant terminate and the existing fixture would then witness it. The fixture is already ' +
      'written ("an array that never closes"), so this entry is about the mutation, not about coverage.',
    maskingExcluded:
      'Masking is a red that gets swallowed; here no red is produced because the process never completes. ' +
      'Measured with a 25s cap: the mutant does not terminate, while the unmutated self-test finishes in ' +
      'under a second. Non-termination is observable from outside, unlike a suppressed exit code.',
  },
]);

/** Fields every entry must carry, non-empty. */
const EXEMPT_FIELDS = Object.freeze(['script', 'kind', 'source', 'reason', 'unblockedBy', 'maskingExcluded']);

/**
 * Evaluate the ledger against what the audit actually measured.
 *
 * Returns `{ errors, counts }`. Every error here is an INTEGRITY failure of the
 * ledger — a claim that does not survive contact with the measurement — which
 * is why they join `report.errors` and fail the run, while unwitnessed sites
 * themselves stay reported-only.
 */
export function evaluateExemptions(report, exempt = MUTATION_EXEMPT) {
  const errors = [];
  const measuredScripts = new Set(report.guards.map((g) => g.name));

  // Index every measured site by its identity key, keeping the verdicts. A key
  // may address more than one site, which is refused rather than resolved.
  const byKey = new Map();
  for (const g of report.guards) {
    for (const r of g.results) {
      const key = `${g.name}\u0000${r.kind}\u0000${r.source ?? ''}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
  }

  // DUPLICATES ARE REFUSED, NOT DEDUPLICATED (#541), and the choice is
  // deliberate rather than incidental.
  //
  // The ledger already refuses the mirror case: ONE entry matching SEVERAL
  // sites is AMBIGUOUS, because it "would silently cover ones nobody examined".
  // SEVERAL entries matching ONE site was accepted without comment — the same
  // reasoning was simply never carried across.
  //
  // Refusing rather than quietly collapsing them, because two entries for one
  // site can carry CONTRADICTORY evidence: different `unblockedBy`, different
  // `maskingExcluded`. Deduplication would pick one arbitrarily and hide the
  // disagreement, and a disagreement about which claim was actually checked is
  // exactly the thing this ledger exists to surface.
  const entryKey = (e) => `${e.script}\u0000${e.kind}\u0000${e.source}`;
  const seenAt = new Map();
  for (const [i, e] of exempt.entries()) {
    if (typeof e.script !== 'string' || typeof e.kind !== 'string' || typeof e.source !== 'string') continue;
    const k = entryKey(e);
    if (!seenAt.has(k)) seenAt.set(k, []);
    seenAt.get(k).push(i + 1);
  }

  let honoured = 0;
  // Counted as DISTINCT SITES, not as accepted entries. Belt and braces with
  // the refusal above: the printed figure has to be right even if that refusal
  // is ever bypassed, because #533 writes 48 entries against it and condition 6
  // exists so growth is visible without going to look. A count that inflates is
  // a growth signal that under-reports, which is worse than no signal.
  const honouredSites = new Set();
  const gatedSites = new Set();
  for (const [i, entry] of exempt.entries()) {
    const where = `exemption ${i + 1} (${entry.script ?? '?'} / ${entry.kind ?? '?'})`;

    const missing = EXEMPT_FIELDS.filter((f) => typeof entry[f] !== 'string' || entry[f].trim() === '');
    if (missing.length > 0) {
      errors.push(
        `${where}: missing or empty ${missing.join(', ')}. An exemption that cannot say what would ` +
          `unblock it, or how masking was excluded for it, is a claim with no evidence attached — ` +
          `which is the shape this ledger exists to refuse.`,
      );
      continue;
    }
    if (!SITE_KINDS.includes(entry.kind)) {
      errors.push(`${where}: kind is not one of ${SITE_KINDS.join(', ')}.`);
      continue;
    }

    const twins = seenAt.get(entryKey(entry)) ?? [];
    if (twins.length > 1) {
      errors.push(
        `${where}: DUPLICATE — exemptions ${twins.join(', ')} all name the same site. One site takes ` +
          `one entry: two can carry different \`unblockedBy\` or \`maskingExcluded\`, and there is no ` +
          `way to tell which claim was the one actually checked. Refused rather than collapsed, for ` +
          `the same reason AMBIGUOUS refuses one entry spanning several sites — and because a ` +
          `duplicate silently inflates the honoured count, making the undispositioned figure ` +
          `under-report by one per copy. Keep the entry whose evidence is true and delete the rest.`,
      );
      continue;
    }

    // A script that was not measured cannot support any claim about its sites.
    // Distinguished from "site gone" because the remedies differ.
    if (!measuredScripts.has(entry.script)) {
      errors.push(
        `${where}: STALE — ${entry.script} was not measured this run, so nothing here confirms or ` +
          `denies the exemption. Remove the entry, or find out why the script is no longer audited.`,
      );
      continue;
    }

    const matches = byKey.get(`${entry.script}\u0000${entry.kind}\u0000${entry.source}`) ?? [];


    if (matches.length === 0) {
      errors.push(
        `${where}: STALE — no ${entry.kind} site in ${entry.script} now reads \`${entry.source}\`. ` +
          `The code it exempted has changed, so the exemption no longer describes anything. Re-examine ` +
          `the site and write a fresh entry, or delete this one. Removal happens by this refusal rather ` +
          `than by anyone remembering (condition 5).`,
      );
      continue;
    }

    if (matches.length > 1) {
      errors.push(
        `${where}: AMBIGUOUS — ${String(matches.length)} ${entry.kind} sites in ${entry.script} read ` +
          `\`${entry.source}\` (lines ${matches.map((m) => m.line).join(', ')}). One entry cannot exempt ` +
          `several sites: it would silently cover ones nobody examined. Refused rather than guessed.`,
      );
      continue;
    }

    // Read defensively, because this is an error CHANNEL and a channel that
    // throws reports nothing. Found by mutation rather than by review:
    // bypassing the stale branch above turned this line into a TypeError that
    // killed the whole run, so the ledger crashed instead of reporting — #443
    // finding 2 in miniature, inside the thing built to make claims fail
    // loudly. The stale branch still produces the useful message; this only
    // makes its absence degrade to a report.
    const site = matches[0];
    if (site === undefined) {
      errors.push(`${where}: STALE — the site could not be resolved from this run's measurement.`);
      continue;
    }
    if (site.verdict === 'witnessed') {
      errors.push(
        `${where}: THE EXEMPTION IS FALSE — ${entry.script} line ${String(site.line)} IS witnessed. ` +
          `Neutralising it turns the self-test red, so the claim that it cannot be witnessed is untrue ` +
          `today whatever it was when written. Delete the entry. This is the decay direction, and it is ` +
          `the one a one-directional ledger cannot see.`,
      );
      continue;
    }
    // A LEDGER-GATED SITE IS HONOURED, not queried. It was deliberately not
    // mutated because its mutation does not terminate, so there is no verdict
    // to compare and demanding one would fail every such entry by construction
    // (#558).
    if (site.verdict === 'not-mutatable' && entry.mutationDoesNotTerminate === true) {
      honoured += 1;
      // TRACKED APART FROM `honouredSites` DELIBERATELY. That set feeds the
      // undispositioned subtraction, whose non-negativity (#541) rests on every
      // honoured site also being UNWITNESSED. A ledger-gated site is not
      // unwitnessed — it was never measured — so counting it there subtracts
      // from a population it is not in and drives the figure negative. Measured:
      // it produced undispositioned = -1 on the first version of this change,
      // which is the very defect #541 fixed, reintroduced by a new verdict.
      gatedSites.add(`${entry.script}\u0000${site.line}\u0000${entry.kind}`);
      continue;
    }
    if (site.verdict !== 'unwitnessed') {
      errors.push(
        `${where}: CANNOT CONFIRM — ${entry.script} line ${String(site.line)} recorded \`${site.verdict}\`, ` +
          `which is neither witnessed nor unwitnessed, so this run is no evidence either way. "I could ` +
          `not check" is not "the exemption holds".`,
      );
      continue;
    }

    honoured += 1;
    honouredSites.add(`${entry.script}\u0000${site.line}\u0000${entry.kind}`);
  }

  return {
    errors,
    counts: {
      entries: exempt.length,
      // DISTINCT SITES (#541). `honoured` counted accepted ENTRIES, so two
      // copies of one entry counted twice and drove `undispositioned` to -1.
      // Sites cannot double-count, and because an honoured site is unwitnessed
      // by construction the subtraction below can no longer go negative.
      honoured: honouredSites.size + gatedSites.size,
      // Unwitnessed sites carrying no entry. The growth signal #533 works
      // against, and the reason the count is printed rather than fetched.
      undispositioned: report.unwitnessed.length - honouredSites.size,
    },
  };
}

/** Offset of the `)` matching the `(` at `open`, or -1. */
function matchParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every route to a non-zero exit, as byte ranges with their replacement.
 *
 * `start`/`end` bound the text to be replaced; `token` is what must be there
 * (asserted before splicing, per trap 2); `replacement` is the neutralisation.
 */
export function enumerateSites(src) {
  const masked = maskCode(src);
  const sites = [];

  // errors.push(...) -> (()=>{})(...). Arguments still evaluate, so a mutation
  // cannot mask a crash inside them; only the recording is removed.
  for (const m of masked.matchAll(/\berrors\.push\s*\(/g)) {
    const start = m.index;
    const end = start + 'errors.push'.length;
    sites.push({ kind: 'errors-push', start, end, token: 'errors.push', replacement: '(()=>{})', line: lineOf(src, start), source: siteSource(src, start) });
  }

  // throw X -> void X. Still constructs the value, then discards it.
  for (const m of masked.matchAll(/\bthrow\b/g)) {
    const start = m.index;
    sites.push({ kind: 'throw', start, end: start + 5, token: 'throw', replacement: 'void', line: lineOf(src, start), source: siteSource(src, start) });
  }

  // process.exit(<arg>) -> process.exit(0). Replacing the ARGUMENT rather than
  // the call keeps control flow identical, which `(()=>{})` would not.
  for (const m of masked.matchAll(/\bprocess\.exit\s*\(/g)) {
    const open = masked.indexOf('(', m.index);
    const close = matchParen(masked, open);
    if (close < 0) continue;
    const arg = src.slice(open + 1, close).trim();
    if (arg === '0' || arg === '') continue; // a success exit is not a failure site
    sites.push({
      kind: 'process-exit',
      start: open + 1,
      end: close,
      token: src.slice(open + 1, close),
      replacement: '0',
      line: lineOf(src, open),
      source: siteSource(src, open),
    });
  }

  // return <non-zero int>; from a main() whose value is passed to process.exit.
  for (const m of masked.matchAll(/\breturn\s+([1-9]\d*)\s*;/g)) {
    const numStart = m.index + m[0].indexOf(m[1]);
    sites.push({
      kind: 'return-code',
      start: numStart,
      end: numStart + m[1].length,
      token: m[1],
      replacement: '0',
      line: lineOf(src, numStart),
      source: siteSource(src, numStart),
    });
  }

  // `code: <non-zero>` in a returned result object (#455).
  //
  // The fifth route, and by now the DOMINANT one among the guards that are
  // testable at all: the `check()` seam returns `{ code, message }` and the
  // entry point passes `result.code` to `process.exit`. Without this kind, such
  // a guard's real failure sites are invisible to the audit and only the single
  // `process.exit(result.code)` in its entry point is enumerated.
  //
  // That is not hypothetical and it is not new. It is why `check-doc-types`,
  // `check-sdk-boundary` and `check-audit-append-only` each measured as exactly
  // one site, unwitnessed: their only enumerated route was an exit call their
  // in-process self-tests never execute, while the `return { code: 1 }` that
  // actually reports failure was never counted. The audit was reporting a
  // silent subset of its own input — #428's defect shape, inside #428.
  //
  // Neutralising the number to 0 turns "report failure" into "report success",
  // which is the same semantics as every other kind here.
  for (const m of masked.matchAll(/\bcode:\s*([1-9]\d*)\b/g)) {
    const numStart = m.index + m[0].indexOf(m[1]);
    sites.push({
      kind: 'result-code',
      start: numStart,
      end: numStart + m[1].length,
      token: m[1],
      replacement: '0',
      line: lineOf(src, numStart),
      source: siteSource(src, numStart),
    });
  }

  return sites.sort((a, b) => a.start - b.start);
}

/**
 * Splice neutralisations in, asserting each lands where it was found.
 *
 * Descending order so an earlier replacement cannot shift a later offset, and
 * the token assertion is what makes "it landed" an observation rather than an
 * assumption (trap 2).
 */
export function applyMutations(src, sites) {
  let out = src;
  for (const site of [...sites].sort((a, b) => b.start - a.start)) {
    const found = out.slice(site.start, site.end);
    if (found !== site.token) {
      throw new Error(
        `mutation would not land: expected ${JSON.stringify(site.token)} at offset ${site.start} ` +
          `(line ${site.line}), found ${JSON.stringify(found)}`,
      );
    }
    out = out.slice(0, site.start) + site.replacement + out.slice(site.end);
  }
  return out;
}

/**
 * Assertion NAMES that failed, when the self-test's format exposes them.
 *
 * The trailing `(expected X, got Y)` is stripped, and that is not cosmetic.
 * Comparing whole lines makes the SAME assertion read as a different string
 * under two different mutations — `(expected 1, got 2)` versus
 * `(expected 1, got 0)` — so a set difference over lines reports a failure
 * route that does not exist. The first run of this audit produced nine such
 * false "unknown failure path" reports before the suffix was stripped.
 */
export function failingAssertions(output) {
  return [...output.matchAll(/^\s*(?:FAIL|not ok)\s*-?\s*(.+)$/gm)].map((m) =>
    m[1].replace(/\s*\(expected\s[\s\S]*?,\sgot\s[\s\S]*?\)\s*$/, '').trim(),
  );
}

/**
 * Every assertion name the run REACHED, passing or failing.
 *
 * Needed because "absent from the failing list" is not "passed" — it is also
 * what a run that never got there looks like. Neutralising every site at once
 * can leave a guard in a state that aborts its self-test partway, so later
 * assertions never execute. Treating those as passing produced eight false
 * "unknown failure path" reports on this repo's own tree.
 *
 * Same principle as the rest of this file, one level in: "I could not check"
 * is not "it passed".
 */
export function reachedAssertions(output) {
  return [...output.matchAll(/^\s*(?:ok|FAIL|not ok)\s*-?\s*(.+)$/gm)].map((m) =>
    m[1].replace(/\s*\(expected\s[\s\S]*?,\sgot\s[\s\S]*?\)\s*$/, '').trim(),
  );
}

function runNodeCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
  // A `node` that never RAN is not a parse failure, and reporting it as one
  // names the wrong defect (#443). Both routes are non-ok, so the audit still
  // errors rather than recording a false witness — but "the mutated file does
  // not parse" and "node could not be started" ask for different actions, and
  // trap 1 is the one place this audit must not be vague.
  if (didNotStart(r)) {
    return { ok: false, out: `node --check COULD NOT RUN: ${spawnFailureDetail(r)}` };
  }
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * How long a mutated self-test may run before the audit stops waiting (#558).
 *
 * A NEUTRALISED SITE CAN REMOVE A LOOP'S ONLY EXIT, and the result is not a
 * wrong answer but a program that never ends. Without a bound the audit blocks
 * forever on a single-runner CI, which is what this PR's own fixture caused:
 * the same neutralised site terminates in ~2s against the previous self-test
 * and never terminates against the new one.
 *
 * Generous on purpose. The slowest legitimate self-test here is the audit's own
 * at ~11s, so 90s is far outside normal variance — a run that reaches it has
 * not run slowly, it has stopped ending.
 */
const SELF_TEST_TIMEOUT_MS = 90_000;

function runSelfTest(testPath, cwd, timeoutMs = SELF_TEST_TIMEOUT_MS) {
  const r = spawnSync(process.execPath, [testPath], {
    encoding: 'utf-8',
    cwd,
    timeout: timeoutMs,
  });
  // A TIMED-OUT RUN IS NOT A FAILING RUN, and conflating them is the trap in
  // the obvious fix. `spawnSync` reports a killed child with a non-zero-ish
  // status, so a bare timeout would record the site as WITNESSED — and the
  // ledger would then raise "THE EXEMPTION IS FALSE" against an entry that is
  // true. Red instead of hung is the same defect, louder.
  if (r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT') {
    return {
      code: null,
      timedOut: true,
      out: `self-test DID NOT TERMINATE within ${String(timeoutMs / 1000)}s`,
    };
  }
  // `code: null` propagated into "baseline self-test is not green (exit null)",
  // which reads as a self-test that FAILED rather than one that never ran. The
  // routing was already right — trap 5 makes a non-green baseline CANNOT CHECK
  // — so this repairs the sentence, not the verdict (#443).
  if (didNotStart(r)) {
    return { code: null, out: `self-test COULD NOT RUN: ${spawnFailureDetail(r)}` };
  }
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Repoint every symlink that escapes back into the real tree.
 *
 * `cpSync` with `dereference: false` does NOT preserve a relative symlink
 * verbatim — it resolves the target and writes an ABSOLUTE link. So npm's
 * workspace links, `../../packages/x` in the real tree, arrive in the replica
 * pointing at the REAL `packages/x`. npm then sees no workspace installed
 * where the manifest says one should be, and reports every other package as
 * `extraneous`.
 *
 * The size of that effect is why this is worth a walk (#652, second round). In
 * the real tree `npm ls --all --json --omit=dev` exits 0 with 57KB of output;
 * with escaping links it exits 1 with `ELSPROBLEMS` and 510KB. `generate-notice`
 * TOLERATES a non-zero exit by design — `npm ls` exits non-zero on peer
 * complaints while still emitting a complete tree — so it parsed that tree,
 * `--omit=dev` pruned nothing, and NOTICE regenerated with ~470 runtime
 * entries against ~180. Its self-test failed its own control, and the audit
 * correctly refused to report on a guard whose baseline was not green.
 *
 * Note what that near-miss was: a copy that LOOKED complete — every file
 * present, byte-identical — and was wrong only in where its links pointed.
 * Sampling seven guards did not catch it, because only one guard shells out to
 * npm.
 *
 * Links are rewritten RELATIVE, so the replica does not encode its own path
 * and a link cannot silently re-escape if the directory is ever moved.
 */
function repointEscapingLinks(realRoot, replicaRoot) {
  // BOTH forms of the root, and the target resolved where it can be. On macOS
  // `/var` is itself a symlink to `/private/var`, so a temp-directory root
  // compared in only one form silently fails to match — the containment test
  // then says "does not escape" about a link that plainly does. Caught by the
  // fixture case below, which lives in exactly that directory.
  const roots = [...new Set([realpathSync(realRoot), resolve(realRoot)])];
  const escapes = (target) => {
    let resolved = target;
    try {
      resolved = realpathSync(target);
    } catch {
      // A dangling link still has a target worth testing for containment.
    }
    for (const base of roots) {
      for (const candidate of [resolved, target]) {
        const rel = relative(base, candidate);
        if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
      }
    }
    return null;
  };

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const raw = readlinkSync(p);
          const abs = isAbsolute(raw) ? raw : resolve(dir, raw);
          const rel = escapes(abs);
          if (rel === null) continue;
          const inReplica = join(replicaRoot, rel);
          unlinkSync(p);
          symlinkSync(relative(dir, inReplica) || '.', p);
        } catch {
          // A link that cannot be repaired is left as it is. The guard that
          // depends on it fails its own baseline and is reported CANNOT CHECK
          // — loudly wrong beats quietly wrong.
        }
      } else if (entry.isDirectory()) {
        walk(p);
      }
    }
  };

  walk(replicaRoot);
}

/**
 * A throwaway, faithful copy of the tree, for mutating.
 *
 * FAITHFUL is the whole requirement — see the note in `audit`. A partial copy
 * silently changes what the self-tests measure, in the direction that makes the
 * audit over-report its own coverage.
 *
 * ## `node_modules` IS COPIED FOR REAL. DO NOT SYMLINK IT.
 *
 * That is the expensive part — measured at 109MB of a 124MB replica, 88% of it,
 * and most of the ~3.9s build — so it is exactly what a later reader will want
 * to optimise. It was tried, and it is the defect this file already had once
 * (#652, second round):
 *
 * npm links each workspace as a RELATIVE symlink, `../../packages/x`. Reach
 * `node_modules` through one link and those resolve against the REAL tree, so
 * npm sees no workspace installed where the manifest says one should be and
 * reports every other package `extraneous`. `npm ls --omit=dev` went from
 * exit 0 / 57KB to exit 1 / 510KB, `generate-notice` regenerated NOTICE with
 * ~470 runtime entries against ~180, its self-test failed its own control, and
 * the audit reported CANNOT CHECK and failed on its own integrity in CI.
 *
 * So the cost is deliberate and the cheaper design is known-broken. If the 4s
 * has to go, the thing to attack is the COPY MECHANISM — a reflink or hardlink
 * clone preserves real directory semantics — never the link-vs-copy decision.
 *
 * `.git` is skipped entirely: no self-test needs it, and a shared `.git` would
 * give a read-only tool a path to the real index.
 *
 * @returns {{root: string, cleanup: () => void}}
 */
export function createReplica(rootDir) {
  const root = mkdtempSync(join(tmpdir(), 'mutation-audit-'));
  cpSync(rootDir, root, {
    recursive: true,
    // `dereference: false` is LOAD-BEARING, not a default worth keeping by
    // habit. npm links each workspace into `node_modules/<scope>/<name>` as a
    // RELATIVE symlink — `../../packages/x` — so copying the links AS LINKS
    // makes them resolve against the replica. Dereferencing would copy the
    // package contents in their place, and npm would no longer see a workspace
    // where it expects one.
    dereference: false,
    // `.git` only. No self-test needs it, and sharing it is how a read-only
    // tool acquires the ability to corrupt an index.
    filter: (src) => basename(src) !== '.git',
  });

  repointEscapingLinks(rootDir, root);

  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // The replica lives under the OS temp directory, outside the
        // repository. Failing to remove it leaves litter, never residue in the
        // tracked tree — so it must not fail the audit.
        //
        // "Litter" is ~124MB a time, and a KILLED run never reaches this line
        // at all, so it accumulates: QA measured 150MB across six strays in a
        // single session. Outside the repository and reaped by the OS, so it is
        // still the right side of the trade — but it is not the trivial cost
        // the word suggests, and an earlier note put it at ~15MB.
      }
    },
  };
}

/**
 * Every verdict a site can carry, and therefore every bucket the partition sums.
 *
 * DERIVED FROM `auditGuard`, not from the totals block — the two disagreeing is
 * exactly the defect this list exists to prevent (#651). `auditGuard` emits
 * five: `witnessed` and `unwitnessed` from the self-test result, plus
 * `not-mutatable`, `unparseable` and `did-not-terminate` from the three paths
 * that reach no verdict by running the test.
 *
 * The partition summed the FIRST TWO and cannot-check sites, so the other three
 * fell through it. Only `not-mutatable` occurs today — one ledger-gated site —
 * which is why the gap read as an off-by-one rather than as a missing class.
 */
export const PARTITION_VERDICTS = new Set([
  'witnessed',
  'unwitnessed',
  'not-mutatable',
  'unparseable',
  'did-not-terminate',
]);

/**
 * The partition identity, WRITTEN FROM THE SET THE CODE ACTUALLY SUMS.
 *
 * Both the failure message and the inventory used to spell these terms out by
 * hand. Adding the three missing buckets fixed the arithmetic and left the
 * inventory's copy still reading `witnessed + unwitnessed + cannot-check sites
 * = failure sites` — an artifact stating an identity its own totals contradict
 * (167 + 17 + 0 against 185), printed one line below them.
 *
 * That is #651 one level up, and hand-editing a second copy is what produced it,
 * so the second copy is removed rather than corrected: a sixth verdict added to
 * the set above now updates both sentences, and cannot leave a stale one behind.
 */
function partitionTerms() {
  return `${[...PARTITION_VERDICTS].join(' + ')} + cannot-check sites`;
}

export function partitionIdentity() {
  return `${partitionTerms()} = failure sites`;
}

/**
 * Sites the partition cannot account for, NAMED.
 *
 * Two ways a site escapes, and they are reported apart because the remedies
 * differ: a site with no result at all means a path through `auditGuard`'s loop
 * emitted nothing, while a result whose verdict is not in `PARTITION_VERDICTS`
 * means a SIXTH verdict was added without being given a bucket. The second is
 * the one that will happen again, and it is why this checks membership rather
 * than counting five known names.
 *
 * Guards with status `cannot-check` are skipped: their sites are counted
 * wholesale by `cannotCheckSites`, since the run reached no per-site verdict
 * for any of them.
 */
/** Sites carrying a given verdict, across measured guards. */
function countVerdict(measured, verdict) {
  return measured.reduce((n, g) => n + g.results.filter((r) => r.verdict === verdict).length, 0);
}

export function unaccountedSites(guards) {
  const orphans = [];
  for (const g of guards) {
    if (g.status === 'cannot-check') continue;
    const verdictAt = new Map();
    for (const r of g.results) verdictAt.set(`${r.line}\u0000${r.kind}`, r.verdict);
    for (const s of g.sites) {
      const verdict = verdictAt.get(`${s.line}\u0000${s.kind}`);
      if (verdict === undefined) {
        orphans.push({ name: g.name, line: s.line, kind: s.kind, reason: 'no verdict was recorded for it' });
      } else if (!PARTITION_VERDICTS.has(verdict)) {
        orphans.push({
          name: g.name,
          line: s.line,
          kind: s.kind,
          reason: `verdict \`${verdict}\` belongs to no bucket — add it to PARTITION_VERDICTS and to the totals`,
        });
      }
    }
  }
  return orphans;
}

/**
 * Audit one guard.
 *
 * The guard is mutated in place WITHIN THE REPLICA and restored from the
 * original bytes in a `finally`, with the restore verified. `guardPath` is a
 * replica path on every production route (`audit` builds it), so the restore
 * and the signal handler below protect the replica's consistency across sites
 * — they are no longer what stands between an interrupt and a disarmed guard in
 * the tracked tree. Nothing writes to the tracked tree at all (#652).
 *
 * They are kept because `auditGuard` is exported and takes an arbitrary
 * `guardPath`: a caller that hands it a tracked file still gets the restore.
 * Belt and braces, where the braces are structural.
 *
 * ## The `mutate` seam
 *
 * Overrides how a site is neutralised. It exists so the `node --check` gate can
 * be WITNESSED, and that is not a convenience: none of the four enumerated
 * mutations can produce unparseable output by construction — `errors.push` ->
 * `(()=>{})`, `throw` -> `void`, and both numeric replacements are valid
 * wherever the original was. Measured, not assumed: zero `unparseable` verdicts
 * across all 111 sites.
 *
 * So the gate defends against a mutation kind that does not exist YET, and
 * without a seam its assertion could only ever pass vacuously — which is
 * exactly what QA found: removing the gate entirely left the suite at 48/0.
 * Production callers pass nothing.
 */
export async function auditGuard({
  guardPath,
  testPath,
  rootDir,
  onProgress = () => {},
  mutate = applyMutations,
  exempt = MUTATION_EXEMPT,
  // A SEAM, for the same reason `mutate` is one (#558). Witnessing the
  // did-not-terminate verdict otherwise costs the full 90s cap per assertion,
  // which is why that verdict shipped unwitnessed: the mechanism that prevents
  // a false "THE EXEMPTION IS FALSE" could be deleted with the suite green.
  selfTestTimeoutMs = SELF_TEST_TIMEOUT_MS,
}) {
  const original = readFileSync(guardPath, 'utf-8');
  const sites = enumerateSites(original);
  const name = basename(guardPath);

  if (sites.length === 0) {
    // #63: "all clean" and "there is nothing here" must not render identically.
    return { name, status: 'no-sites', sites: [], results: [] };
  }

  const baseline = runSelfTest(testPath, rootDir, selfTestTimeoutMs);
  if (baseline.code !== 0) {
    // "Red under mutation" is meaningless without a green baseline.
    return {
      name,
      status: 'cannot-check',
      reason: `baseline self-test is not green (exit ${baseline.code})`,
      sites,
      results: [],
    };
  }
  const baselineFailures = new Set(failingAssertions(baseline.out));

  // AN INTERRUPTED RUN MUST NOT LEAVE A DISARMED GUARD ON DISK (#428 QA).
  //
  // A mutated guard is on disk for roughly 28% of this audit's runtime — QA
  // measured 17 of 60 polls. The run is minutes long (322s on this machine at
  // 151 sites; the ~197s figure this comment used to carry predates #435 and no
  // longer describes it), so Ctrl-C inside that window is the expected
  // interaction.
  //
  // WHERE THAT TIME GOES IS NOT WHERE THE PR THAT ADDED IT SAID. Read the COST
  // note at the yield below before optimising anything in this loop.
  //
  // Node runs no `finally` on an unhandled signal,
  // so Ctrl-C inside that window left, for example:
  //
  //   M .github/scripts/check-adr-citations.mjs   process.exit(1) -> process.exit(0)
  //
  // A one-character diff that DISARMS a CI guard, parses, lints, and may leave
  // its own self-test green — which is this audit's entire premise, produced by
  // the audit. Ctrl-C on a three-minute tool is the expected interaction.
  //
  // The interaction with a dirty tree is what makes it dangerous rather than
  // merely untidy: a normal run preserves uncommitted work byte-for-byte
  // (the original is read from disk), but INTERRUPTED plus dirty means the
  // user cannot tell their own edit from the residue, and `git checkout --`
  // then destroys their work.
  //
  // HONEST LIMIT: SIGKILL cannot be caught, so `kill -9` still leaves residue.
  // Nothing in a single process can fix that. What is fixed is the signal a
  // human actually sends.
  const onSignal = (signal) => {
    writeFileSync(guardPath, original, 'utf-8');
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.kill(process.pid, signal); // re-raise with default disposition
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Sites the ledger says must not be mutated at all (#558).
  const siteKey = (st) => `${name}\u0000${st.kind}\u0000${st.source ?? ''}`;
  const skipMutation = new Set(
    exempt
      .filter((e) => e.mutationDoesNotTerminate === true)
      .map((e) => `${e.script}\u0000${e.kind}\u0000${e.source}`),
  );

  const results = [];
  let probe = null;
  try {
    for (const [i, site] of sites.entries()) {
      // YIELD TO THE EVENT LOOP so a queued signal can actually be delivered.
      //
      // Without this the loop is one unbroken synchronous block — `spawnSync`
      // throughout — and Node cannot run a signal handler until the stack
      // unwinds. Registering a handler would then only SUPPRESS SIGINT's
      // default disposition: the run would continue to completion and restore
      // via `finally`, so the file would be safe, but Ctrl-C would do nothing
      // at all for up to three minutes. Measured, not reasoned — the first
      // version of this fix exited code 0 with `signal: null` under SIGINT.
      //
      // Safe file, uncancellable tool is a worse trade than the defect. One
      // yield per site costs nothing and makes the handler genuinely reachable.
      //
      // COST — MEASURED, BECAUSE THIS LINE WAS BILLED FOR SOMETHING IT DID NOT
      // DO (#437). PR #435 reported the audit slowing 197s -> 266s and
      // attributed it here. That attribution is WRONG, and this is the line a
      // reader reclaiming runtime would delete first, so the correction lives
      // where the temptation is rather than only in an issue nobody reads.
      //
      //   this yield, 151 sites   ~3 ms      (measured directly: 113 setImmediate
      //                                       round-trips took 2.51 ms)
      //   the audit's own self-test  ~300 s  (~15.2 s x 20 runs — see the
      //                                       self-test header, and re-measure:
      //                                       this pair was ~113 s when written
      //                                       and both factors have since moved)
      //   whole audit                 322 s  (also pre-#652; the replica adds
      //                                       ~3.9 s once per run)
      //
      // Roughly one part in a hundred thousand. QA reached the same conclusion
      // from the other direction, differencing two ~99 s runs at 99.0 vs 98.8;
      // that method can only ever bound the cost from above, since nothing
      // below about a second survives the noise. Measuring the primitive is
      // what shows the true figure is three milliseconds rather than 0.2 s.
      //
      // DELETING THIS LINE BUYS NOTHING AND COSTS CANCELLABILITY. The guard
      // catches it — the assertion pinning exit on the re-raised signal goes
      // red — but a wasted attempt the prose actively invited is cheaper to
      // prevent than to detect. The real bill is the self-test multiplier
      // documented in `check-mutation-audit.test.mjs`.
      await new Promise((resolve) => setImmediate(resolve));

      // THE LEDGER GATES THE MUTATION (#558). A site declared
      // `mutationDoesNotTerminate` is NOT mutated, because neutralising it
      // removes a loop's only exit and the run never comes back.
      //
      // Narrow on purpose: this skips only entries carrying that flag, never
      // exempt sites generally. An `unreachable` entry is still mutated, so the
      // ledger's decay direction — an exemption that has become false must FAIL
      // — keeps working for it.
      //
      // The cost, stated because it is real: for a skipped site that decay
      // check is gone. It is unavoidable rather than a concession — you cannot
      // measure a mutation that does not terminate — and it is why the flag is
      // per-entry and justified rather than a blanket skip over the ledger. The
      // entry's `unblockedBy` names what would restore mutability, and the flag
      // comes off when someone does it.
      if (skipMutation.has(siteKey(site))) {
        results.push({ ...site, verdict: 'not-mutatable' });
        onProgress(`${name} ${i + 1}/${sites.length} (line ${site.line}, ${site.kind}) — ledger-gated, not mutated`);
        continue;
      }

      onProgress(`${name} ${i + 1}/${sites.length} (line ${site.line}, ${site.kind})`);
      writeFileSync(guardPath, mutate(original, [site]), 'utf-8');

      const parsed = runNodeCheck(guardPath);
      if (!parsed.ok) {
        // TRAP 1, INVERTED. A broken file reddens the self-test and would
        // record as WITNESSED. This is an audit error, never a pass.
        results.push({ ...site, verdict: 'unparseable', detail: parsed.out.trim().split('\n')[0] ?? '' });
        continue;
      }

      const run = runSelfTest(testPath, rootDir, selfTestTimeoutMs);
      const newly = failingAssertions(run.out).filter((a) => !baselineFailures.has(a));
      results.push({
        ...site,
        // A run that DID NOT TERMINATE gets its own verdict. It is neither
        // witnessed nor unwitnessed: nothing was learned, and calling it
        // witnessed would make the ledger raise a false "THE EXEMPTION IS
        // FALSE" against a true entry (#558).
        verdict: run.timedOut === true ? 'did-not-terminate' : run.code === 0 ? 'unwitnessed' : 'witnessed',
        newlyFailing: newly,
        namesAvailable: newly.length > 0 || run.code === 0,
      });
    }

    // THE COMPLETENESS PROBE. See `interpretProbe` for why the polarity here is
    // not the one #428's review states.
    // THE PROBE MUTATES EVERY SITE AT ONCE, so a ledger-gated site has to be
    // excluded here too (#558). Skipping it per-site above and then neutralising
    // it again here would hang exactly as before — the per-site gate alone looks
    // sufficient and is not.
    const probeSites = sites.filter((st) => !skipMutation.has(siteKey(st)));
    onProgress(`${name} completeness probe`);
    writeFileSync(guardPath, mutate(original, probeSites), 'utf-8');
    const parsedAll = runNodeCheck(guardPath);
    if (!parsedAll.ok) {
      probe = { status: 'unparseable', detail: parsedAll.out.trim().split('\n')[0] ?? '' };
    } else {
      const all = runSelfTest(testPath, rootDir, selfTestTimeoutMs);
      probe = {
        status: all.code === 0 ? 'no-failure-witnesses' : 'ok',
        exitCode: all.code,
        failing: failingAssertions(all.out).filter((a) => !baselineFailures.has(a)),
        reached: reachedAssertions(all.out),
      };
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    writeFileSync(guardPath, original, 'utf-8');
    const restored = readFileSync(guardPath, 'utf-8');
    if (restored !== original) {
      // NOTE, because the audit put this line in its OWN unwitnessed list and
      // the first version of this PR did not connect the two: no fixture
      // reaches this throw, so "the audit never leaves a wrong write" rested on
      // reading the code rather than on observing it. The signal handlers above
      // are what make the claim true for the case that actually occurs; this
      // line remains the backstop for a filesystem failure, and remains
      // unwitnessed. Reading your own unwitnessed rows against your own claims
      // is the cheapest review available.
      throw new Error(`RESTORE FAILED for ${guardPath} — the working tree is dirty and must be checked by hand`);
    }
  }

  return { name, status: 'measured', sites, results, probe };
}

/**
 * What the all-sites probe means — and a DELIBERATE DEVIATION from #428's
 * review, flagged rather than silently implemented.
 *
 * The review says: neutralise every known site simultaneously, and "self-test
 * goes fully green" means the enumeration is complete.
 *
 * **That polarity cannot be right, and it inverts the signal.** With every
 * failure route neutralised the guard can no longer exit non-zero, so every
 * self-test case asserting a rejection MUST fail. Fully green is therefore not
 * achievable for any self-test that witnesses anything — and if it IS achieved,
 * it means no case in that self-test depends on the guard failing at all, which
 * is alarming rather than reassuring.
 *
 * So the reading is inverted here:
 *
 *   red   -> expected. The guard's rejections are witnessed by something.
 *   green -> `no-failure-witnesses`. Nothing in this self-test observes a
 *            failure. Reported loudly.
 *
 * The review's INTENT — catch a failure route the enumeration does not know
 * about — is kept via `unknownPathSuspected`: if a single-site mutation reddens
 * an assertion that the all-sites mutation leaves green, the two disagree about
 * what causes that assertion to fail, which is the signature of a route outside
 * the enumeration.
 */
export function interpretProbe(guard) {
  if (guard.probe === null || guard.probe === undefined) return [];
  const notes = [];
  if (guard.probe.status === 'unparseable') {
    notes.push(`${guard.name}: all-sites mutation does not parse — ${guard.probe.detail}`);
    return notes;
  }
  // NOTE what is deliberately NOT here: `no-failure-witnesses`. A self-test
  // that observes no failure at all is the aggregate of "every site in it is
  // unwitnessed" — the measurement stage 1 exists to produce, not an integrity
  // fault. Failing on it would break the rule that stage 1 never fails on
  // finding unwitnessed sites. It is reported via `noFailureWitnesses` instead.
  const probeFailing = new Set(guard.probe.failing ?? []);
  const probeReached = new Set(guard.probe.reached ?? []);
  for (const r of guard.results) {
    if (r.verdict !== 'witnessed') continue;
    // An assertion counts as contradicting the probe only if the probe RAN it
    // and it passed. One the probe never reached is inconclusive, not evidence.
    const orphaned = (r.newlyFailing ?? []).filter((a) => probeReached.has(a) && !probeFailing.has(a));
    if (orphaned.length > 0) {
      notes.push(
        `${guard.name} line ${r.line}: ${JSON.stringify(orphaned[0])} reddens for this site alone but ` +
          `not when every site is neutralised — a failure route outside the enumeration is suspected`,
      );
    }
  }
  return notes;
}

/** Non-test scripts, and the self-test beside each (or null). */
export function discoverGuards(rootDir) {
  const dir = join(rootDir, SCRIPTS_REL);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .sort()
    .map((f) => {
      const testName = `${f.slice(0, -'.mjs'.length)}.test.mjs`;
      const testPath = join(dir, testName);
      return {
        name: f,
        guardPath: join(dir, f),
        testPath: existsSync(testPath) ? testPath : null,
      };
    });
}

/**
 * The figures a revision delta compares, read back out of a rendered inventory.
 *
 * Parsed from this file's OWN output rather than stored alongside it, so there
 * is one source of truth and no second file to fall out of step. Returns `null`
 * for any figure the previous revision did not carry — a figure added later is
 * "not recorded then", which is a different fact from "unchanged".
 */
export function parseInventoryTotals(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return null;
  const num = (label) => {
    const m = new RegExp(`^- ${label}: \\*\\*(\\d+)\\*\\*`, 'm').exec(markdown);
    return m === null ? null : Number(m[1]);
  };
  const unreachable = /^- unreachable \(no self-test, #431\): \*\*(\d+)\*\* sites across (\d+) scripts/m.exec(markdown);
  const totals = {
    guards: num('measured guards'),
    sites: num('failure sites'),
    witnessed: num('witnessed'),
    unwitnessed: num('unwitnessed'),
    unreachableSites: unreachable === null ? null : Number(unreachable[1]),
    unreachable: unreachable === null ? null : Number(unreachable[2]),
    cannotCheck: num('cannot check \\(non-green baseline\\)'),
  };

  // A document carrying NONE of the expected figures is not an inventory, and
  // must not be reported as one whose figures all happen to be unknown.
  //
  // Found by the self-test rather than by design: the first version returned
  // this object regardless, so an unparseable predecessor produced "no headline
  // figure moved" — silence indistinguishable from nothing having changed,
  // which is the precise failure this section exists to prevent. It had that
  // defect while containing a paragraph explaining why it must not.
  if (Object.values(totals).every((v) => v === null)) return null;

  return totals;
}

/** Figures a delta reports on, in the order a reader wants them. */
const DELTA_FIGURES = Object.freeze([
  ['sites', 'failure sites'],
  ['witnessed', 'witnessed'],
  ['unwitnessed', 'unwitnessed'],
  ['unreachableSites', 'unreachable sites'],
  ['unreachable', 'unreachable scripts'],
  ['cannotCheck', 'cannot-check scripts'],
  ['guards', 'measured guards'],
]);

/**
 * What MOVED since the previous revision (#438).
 *
 * The inventory records state; this records change. It exists because the
 * 73 -> 74 flip was correct and had to be derived from a line-number diff, and
 * because a figure that moves without an attached explanation degrades toward
 * the state it replaced — the reader has no cheap way to tell "a fix added a
 * witness" from "the measurement drifted".
 *
 * THREE PROPERTIES, each from a way this kind of report goes wrong:
 *
 *   1. BOTH DIRECTIONS. A delta that reported only growth would have missed
 *      unreachable going 24 -> 3, which is the most consequential movement this
 *      instrument has yet recorded and the one that most changes #431's
 *      precondition. Decreases are reported with the same prominence.
 *
 *   2. RECLASSIFICATION IS NOT REGRESSION. `witnessed + unwitnessed +
 *      cannot-check sites = failure sites`. When the total holds and the parts
 *      move, sites changed CATEGORY rather than appearing or vanishing — which
 *      is exactly what a non-green baseline produces (#429), and what a naive
 *      delta between a local and a CI run would report as a phantom loss of
 *      witnesses. Named rather than left to the reader.
 *
 *   3. "COULD NOT COMPARE" IS SAID OUT LOUD. A first revision, or one whose
 *      predecessor cannot be parsed, emits a section saying so. Silence would be
 *      indistinguishable from "nothing moved", which is the failure this whole
 *      instrument exists to catch.
 */
/**
 * @param {string|null} previousMarkdown
 * @param {object} totals
 * @param {object[]} [guards] - measured guards, so the partition check can NAME
 *   the sites it cannot account for (#651). Optional: a caller with only totals
 *   still gets the arithmetic, and reports that it could not localise rather
 *   than reporting that there is nothing to localise.
 */
/**
 * Does every failure site land in exactly one bucket, and if not, WHICH?
 *
 * Separated from `inventoryDelta` because it is a property of a SINGLE run.
 * Folding it into the delta is what let it be skipped whenever there was no
 * previous inventory to compare against.
 *
 * @returns {{ok: boolean, lines: string[]}}
 */
function partitionFindings(totals, guards) {
  const lines = [];
  const partitionNow =
    totals.witnessed +
    totals.unwitnessed +
    (totals.notMutatable ?? 0) +
    (totals.unparseable ?? 0) +
    (totals.didNotTerminate ?? 0) +
    totals.cannotCheckSites;
  const orphans = guards === null ? null : unaccountedSites(guards);

  if (partitionNow === totals.sites && (orphans === null || orphans.length === 0)) return { ok: true, lines };

  lines.push('');
  lines.push(
    `**Partition does not close:** ${partitionTerms()} = ${partitionNow}, ` +
      `against ${totals.sites} failure sites. ` +
      `Treat every figure above as unexplained until that is understood.`,
  );

  if (orphans === null) {
    // "I could not localise" is not "there is nothing to localise" — the
    // distinction this repository keeps paying for. Said rather than implied.
    lines.push('');
    lines.push('The offending sites were NOT localised: this caller passed no guards.');
  } else if (orphans.length > 0) {
    lines.push('');
    lines.push(`${orphans.length} site(s) in no bucket:`);
    for (const o of orphans) lines.push(`  - ${o.name} line ${o.line} (${o.kind}) — ${o.reason}`);
  } else {
    // The sum is wrong but every site carries a counted verdict, so the fault is
    // in the arithmetic rather than in the measurement. Distinguished, because
    // "cannot localise" and "localised to nothing" are different reports.
    lines.push('');
    lines.push(
      'Every site carries a counted verdict, so the discrepancy is in this sum rather than in the ' +
        'measurement. Check the totals block against the verdicts `auditGuard` can emit.',
    );
  }
  return { ok: false, lines };
}

export function inventoryDelta(previousMarkdown, totals, guards = null) {
  const lines = [];
  const previous = parseInventoryTotals(previousMarkdown);

  // COMPUTED BEFORE THE EARLY RETURN, because it is a property of THIS run
  // alone and has nothing to do with having a predecessor (#651). It used to
  // sit after this branch, so a run with no readable previous inventory — the
  // first run on any fresh checkout — never checked its own accounting, and
  // reported "could not compare" as though that were the whole story.
  const partition = partitionFindings(totals, guards);

  if (previous === null) {
    lines.push('**Could not compare.** No previous inventory was readable, so this revision has');
    lines.push('no measured predecessor. That is not the same as "nothing moved".');
    lines.push(...partition.lines);
    return lines;
  }

  const moved = [];
  const unknown = [];
  for (const [key, label] of DELTA_FIGURES) {
    const before = previous[key];
    const after = totals[key];
    if (before === null || before === undefined) {
      unknown.push(label);
      continue;
    }
    if (before !== after) moved.push({ label, before, after, delta: after - before });
  }

  if (moved.length === 0) {
    lines.push('**No headline figure moved** since the previous revision.');
  } else {
    lines.push('| figure | before | after | change |');
    lines.push('|---|---|---|---|');
    for (const m of moved) {
      const sign = m.delta > 0 ? `+${m.delta}` : String(m.delta);
      lines.push(`| ${m.label} | ${m.before} | ${m.after} | **${sign}** |`);
    }
  }

  // The partition check. Stated whichever way it comes out: a conserved total
  // with moving parts is a reclassification, and a moving total is a real
  // change in the measured population.
  //
  // IT NAMES THE SITES (#651). Reporting only that a sum is wrong hands the
  // next reader the entire search — which is what happened: the gap stood at
  // one site across two hosts and three days, and localising it took reading
  // every verdict the audit can produce. A discrepancy you cannot localise is
  // barely better than no discrepancy at all.
  if (!partition.ok) {
    lines.push(...partition.lines);
  } else if (moved.some((m) => m.label === 'witnessed' || m.label === 'unwitnessed')) {
    const sitesMoved = moved.some((m) => m.label === 'failure sites');
    lines.push('');
    lines.push(
      sitesMoved
        ? '**The measured population changed**, so the movement above is not only a change of category.'
        : '**RECLASSIFICATION, not regression.** The failure-site total is unchanged, so sites moved ' +
          'between categories rather than appearing or vanishing. A non-green baseline does exactly ' +
          'this (#429): witnessed falls, cannot-check rises, and nothing was actually lost.',
    );
  }

  if (unknown.length > 0) {
    lines.push('');
    lines.push(
      `Not comparable: **${unknown.join(', ')}** — the previous revision did not record ${unknown.length === 1 ? 'it' : 'them'}. ` +
        'Absent then is a different fact from unchanged.',
    );
  }

  return lines;
}

/**
 * The first movement this instrument recorded, before it could record its own.
 *
 * Kept as a constant because the inventory is regenerated wholesale, so a
 * history accumulated in the file would be erased on the next run. One entry,
 * deliberately — this is a line of provenance, not a changelog system.
 */
const SEED_PROVENANCE = Object.freeze([
  'The first recorded movement predates this section and is kept so that it is not',
  'the undocumented one: **witnessed 73 -> 74** between `8bc9641` and `f2d0fda`.',
  'QA attributed it to `errors.push(...interpretProbe(g).map(...))` in `audit()`',
  'gaining a witness from the new detector fixture — a fix giving a real site a',
  'real witness, which is what should happen. It had to be derived from a',
  'line-number diff, which is why this section exists.',
]);

export function renderInventory(report, previousMarkdown = null) {
  const lines = [];
  lines.push('# Mutation-audit inventory (#428 stage 1)');
  lines.push('');
  lines.push('Generated by `.github/scripts/check-mutation-audit.mjs`. **Report-only.**');
  lines.push('A site is WITNESSED when neutralising it turns its guard\'s self-test red —');
  lines.push('witnessed *relative to what that self-test exercises*, which is the honest limit.');
  lines.push('');
  lines.push('## Read the unwitnessed count with two caveats');
  lines.push('');
  lines.push('**1. Some part of it may be MASKING rather than absence.** The unknown-route');
  lines.push('detector only examines assertions tied to sites already found WITNESSED, so a');
  lines.push('failure route outside the enumeration can make a genuinely-witnessed site');
  lines.push('record as unwitnessed while never tripping the detector — QA demonstrated');
  lines.push('exactly that with a `process.exitCode = 1` route, where a site flipped to');
  lines.push('witnessed once the hidden route was removed. So the unwitnessed figure is an');
  lines.push('upper bound on genuine absence, not a precise count of it.');
  lines.push('');
  lines.push('**2. It is environment-dependent (#429).** These numbers require a working');
  lines.push('`PATH`. This repo\'s agent environment has shipped a space-separated `PATH`, on');
  lines.push('which `env: node` fails in child processes — several guards then go');
  lines.push('`cannot check`, and the totals move. #429 has bitten three agents; it is the');
  lines.push('precondition for reproducing anything below. Re-run with a sane `PATH` before');
  lines.push('treating a difference as a real change.');
  lines.push('');
  lines.push(`- measured guards: **${report.totals.guards}**`);
  lines.push(`- failure sites: **${report.totals.sites}**`);
  lines.push(`- witnessed: **${report.totals.witnessed}**`);
  lines.push(`- unwitnessed: **${report.totals.unwitnessed}**`);
  lines.push(`- unreachable (no self-test, #431): **${report.totals.unreachableSites}** sites across ${report.totals.unreachable} scripts`);
  lines.push(`- cannot check (non-green baseline): **${report.totals.cannotCheck}** scripts`);
  lines.push(`- cannot check, as sites: **${report.totals.cannotCheckSites}**`);
  // Printed even at zero, because these are the buckets the partition used to
  // omit (#651) and a bucket that appears only when non-empty is one nobody
  // knows to look for. `not-mutatable` is the ledger-gated state — a site
  // deliberately never mutated because its mutation does not terminate (#558),
  // so it has no verdict to compare and legitimately belongs to none of the
  // other three. It is a FOURTH STATE, not an off-by-one.
  lines.push(`- not mutatable (ledger-gated, #558): **${report.totals.notMutatable}**`);
  lines.push(`- unparseable mutation: **${report.totals.unparseable}**`);
  lines.push(`- mutation did not terminate: **${report.totals.didNotTerminate}**`);
  lines.push(
    `- exemptions on the ledger (#532): **${report.exemptions?.entries ?? 0}** — ` +
      `${report.exemptions?.undispositioned ?? report.totals.unwitnessed} unwitnessed site(s) carry no entry`,
  );
  lines.push('');
  lines.push(`\`${partitionIdentity()}\`. The site-level`);
  lines.push('figure is what closes that identity, and it is what makes a fall in `witnessed`');
  lines.push('legible as a change of CATEGORY rather than a loss of coverage (#438).');
  lines.push('');
  lines.push('## What moved since the previous revision (#438)');
  lines.push('');
  lines.push('Compared against **the inventory committed in this repository**, not against the');
  lines.push('previous run. Two runs of the same code in different environments legitimately');
  lines.push('differ — see caveat 2 — so a delta between a local run and a CI one would report');
  lines.push('movement that is an artifact of where it ran. This says which it compared.');
  lines.push('');
  lines.push(...inventoryDelta(previousMarkdown, report.totals, report.guards));
  lines.push('');
  lines.push(...SEED_PROVENANCE);
  lines.push('');
  lines.push('| script | sites | witnessed | unwitnessed | status |');
  lines.push('|---|---|---|---|---|');
  for (const g of report.guards) {
    const w = g.results.filter((r) => r.verdict === 'witnessed').length;
    const u = g.results.filter((r) => r.verdict === 'unwitnessed').length;
    lines.push(`| \`${g.name}\` | ${g.sites.length} | ${w} | ${u} | ${g.status} |`);
  }
  lines.push('');
  if (report.unwitnessed.length > 0) {
    lines.push('## Unwitnessed sites');
    lines.push('');
    lines.push('Neutralising these changed nothing their self-test could see.');
    lines.push('');
    lines.push('| script | line | kind |');
    lines.push('|---|---|---|');
    for (const u of report.unwitnessed) lines.push(`| \`${u.name}\` | ${u.line} | ${u.kind} |`);
    lines.push('');
  }
  if ((report.noFailureWitnesses ?? []).length > 0) {
    lines.push('## Self-tests that observe no failure at all');
    lines.push('');
    lines.push('With EVERY failure site in these neutralised, the self-test stays green — so');
    lines.push('nothing in it depends on the guard failing. This is the aggregate of "every');
    lines.push('site here is unwitnessed", reported rather than failed, because it is the');
    lines.push('measurement and not an integrity fault.');
    lines.push('');
    for (const n of report.noFailureWitnesses) lines.push(`- \`${n}\``);
    lines.push('');
  }
  if (report.unreachable.length > 0) {
    lines.push('## Unreachable — failure sites with no self-test (#431)');
    lines.push('');
    lines.push('Reported rather than omitted: there is nothing here to turn red, so no');
    lines.push('re-keying of this audit reaches them. Separately owned by #431.');
    lines.push('');
    lines.push('| script | sites |');
    lines.push('|---|---|');
    for (const r of report.unreachable) lines.push(`| \`${r.name}\` | ${r.sites} |`);
    lines.push('');
  }
  lines.push('---');
  lines.push('*Operum Engineer · [operum.ai](https://operum.ai)*');
  return `${lines.join('\n')}\n`;
}

/**
 * `exempt` is a parameter so a run over a SUBSET of guards can say which ledger
 * applies to it (#558).
 *
 * It defaulted to the shipped ledger unconditionally, which is right for the
 * whole-tree run `main()` performs and wrong for every fixture run: the audit
 * then judges real entries against a measurement that never looked at their
 * scripts, and correctly-written entries report as stale. That stayed invisible
 * while the ledger was empty — the first two entries surfaced it immediately.
 *
 * The default is unchanged, so production behaviour is identical.
 */
export async function audit(rootDir, {
  onProgress = () => {},
  exempt = MUTATION_EXEMPT,
  mutate = applyMutations,
  selfTestTimeoutMs = SELF_TEST_TIMEOUT_MS,
  // A SEAM, for the same reason `mutate` is one. The interrupted-run test needs
  // to WITNESS that a mutation was genuinely on disk when the signal landed —
  // otherwise "the tree is clean afterwards" passes for a run that never
  // started, which is the vacuous-assertion shape
  // docs/adr/ADR-024-output-must-vary-with-the-fact.md describes. Production
  // callers pass nothing.
  onReplica = () => {},
} = {}) {
  // EVERY MUTATION HAPPENS IN A REPLICA, NEVER IN THE TRACKED TREE (#652).
  //
  // The audit neutralises a guard, runs its self-test, and restores it. Doing
  // that to the tracked file put a DISARMED GUARD on disk for ~28% of a
  // five-minute run, and interrupting a five-minute tool is the expected
  // interaction, not an unusual one. The residue is a plausible-looking
  // one-character edit to a real guard — `process.exit(1)` -> `process.exit(0)`
  // — which parses, lints, and can ride along into a commit unnoticed.
  //
  // The signal handler in `auditGuard` narrows that window. It does not close
  // it: `SIGKILL` cannot be caught, `SIGHUP` was never handled, and a handler
  // cannot run at all while `spawnSync` holds the loop. A replica closes it,
  // because there is no longer anything to restore — the tracked file is never
  // written, by any path, including the ones no handler can reach.
  //
  // ## Why the earlier rejection was right, and why it no longer applies
  //
  // This was previously rejected on the grounds that "several self-tests assert
  // against real repository state, so a copy changes what is being measured".
  // That is TRUE, measured, and it is the trap: copying only `.github/scripts/`
  // to a temp directory takes check-runners.test.mjs from 74/0 to 68/6,
  // check-sdk-boundary from 24/0 to 22/2, and crashes check-codeowners outright.
  //
  // AND THOSE FAILURES POINT THE WRONG WAY. A self-test that fails for an
  // environmental reason is indistinguishable, to this audit, from one that
  // CAUGHT THE MUTATION — so a partial copy makes the audit report better
  // coverage than it has. That is the same defect class the audit exists to
  // find, produced by the audit.
  //
  // The reasoning does not survive a FAITHFUL replica, because then the copy IS
  // real repository state. Measured against the same self-tests: check-runners
  // 74/0, check-codeowners 52/0, check-sdk-boundary 24/0, check-guards 160/0,
  // check-audit-append-only 40/0, check-concealment-captures 133/0 — identical
  // to the tracked tree in every case.
  //
  // Cost is one tree copy per RUN, not per guard: ~3.9s and ~124MB against a
  // ~322s audit. `node_modules` is COPIED FOR REAL and is 109MB of that 124MB
  // — symlinking it is the known-broken design that made this audit report
  // CANNOT CHECK, and `createReplica`'s docblock says why before anyone
  // optimises it back. `.git` is skipped — no self-test needs it, and sharing
  // it with the real repository is how a read-only tool acquires the ability
  // to corrupt an index.
  const replica = createReplica(rootDir);
  onReplica(replica.root);
  try {
    return await auditIn(replica.root, { onProgress, exempt, mutate, selfTestTimeoutMs });
  } finally {
    replica.cleanup();
  }
}

/**
 * The audit proper, against whatever root it is handed.
 *
 * Split from `audit` so the replica is created exactly once per run rather than
 * once per guard, and so the mutation logic below has no way to name the
 * tracked tree even by mistake — it only ever sees the root it was given.
 */
async function auditIn(rootDir, { onProgress, exempt, mutate, selfTestTimeoutMs }) {
  const guards = discoverGuards(rootDir);
  const errors = [];
  const measured = [];
  const unreachable = [];
  let noSites = 0;

  for (const g of guards) {
    if (g.testPath === null) {
      const sites = enumerateSites(readFileSync(g.guardPath, 'utf-8'));
      if (sites.length > 0) unreachable.push({ name: g.name, sites: sites.length });
      else noSites += 1;
      continue;
    }
    const result = await auditGuard({ ...g, rootDir, onProgress, exempt, mutate, selfTestTimeoutMs });
    if (result.status === 'no-sites') { noSites += 1; continue; }
    measured.push(result);
  }

  // #63 — refuse to render "all clean" and "nothing here" identically.
  if (measured.length === 0) {
    errors.push('no guard produced a single failure site — the enumeration is broken, not the tree clean');
  }

  const unwitnessed = [];
  const noFailureWitnesses = [];
  for (const g of measured) {
    if (g.probe?.status === 'no-failure-witnesses') noFailureWitnesses.push(g.name);
    for (const r of g.results) {
      if (r.verdict === 'unparseable') {
        errors.push(`${g.name} line ${r.line}: mutation does not parse — ${r.detail}`);
      } else if (r.verdict === 'unwitnessed') {
        unwitnessed.push({ name: g.name, line: r.line, kind: r.kind });
      }
    }
    if (g.status === 'cannot-check') {
      errors.push(`${g.name}: CANNOT CHECK — ${g.reason}`);
    }
    errors.push(...interpretProbe(g).map((n) => `unknown failure path: ${n}`));
  }

  const totals = {
    guards: measured.length,
    sites: measured.reduce((n, g) => n + g.sites.length, 0),
    witnessed: measured.reduce((n, g) => n + g.results.filter((r) => r.verdict === 'witnessed').length, 0),
    unwitnessed: unwitnessed.length,
    unreachable: unreachable.length,
    unreachableSites: unreachable.reduce((n, r) => n + r.sites, 0),
    cannotCheck: measured.filter((g) => g.status === 'cannot-check').length,
    // SITES, not scripts (#438). The scripts figure cannot close the partition:
    // witnessed + unwitnessed + cannotCheckSites = sites is what makes a drop in
    // `witnessed` legible as a RECLASSIFICATION rather than a regression, and
    // that distinction is the whole difference between a real movement and the
    // #429 environment artifact.
    cannotCheckSites: measured
      .filter((g) => g.status === 'cannot-check')
      .reduce((n, g) => n + g.sites.length, 0),
    // THE THREE VERDICTS THE PARTITION USED TO OMIT (#651).
    //
    // A site reaching one of these has a verdict — it is measured, and the
    // ledger reads `not-mutatable` to honour a gated entry — but none of them
    // was in the sum, so each was silently outside the accounting. Only
    // `not-mutatable` occurs today, at exactly one site, which is why the gap
    // presented as an off-by-one rather than as a missing class of three.
    notMutatable: countVerdict(measured, 'not-mutatable'),
    unparseable: countVerdict(measured, 'unparseable'),
    didNotTerminate: countVerdict(measured, 'did-not-terminate'),
    noSites,
  };

  // The ledger is evaluated against THIS run's measurement (#532). Its failures
  // are audit-integrity failures — a claim that did not survive contact with the
  // measurement — which is why they join `errors` and fail, while unwitnessed
  // sites themselves stay reported-only.
  const report = { guards: measured, unreachable, unwitnessed, noFailureWitnesses, errors, totals };
  const ledger = evaluateExemptions(report, exempt);
  errors.push(...ledger.errors);
  report.exemptions = ledger.counts;
  return report;
}

async function main(argv) {
  const args = argv.slice(2).filter((a) => a !== '--write');
  const write = argv.includes('--write');
  const root = resolve(args[0] ?? '.');

  const report = await audit(root, { onProgress: (m) => process.stderr.write(`  ... ${m}\n`) });

  // The COMMITTED inventory is the comparison point (#438), read once and used
  // for both the printed and the written copy so they cannot disagree. Read
  // failures are not swallowed: `parseInventoryTotals` treats an unreadable
  // predecessor as "could not compare", which the delta says out loud.
  const inventoryPath = join(root, INVENTORY_REL);
  let previousMarkdown = null;
  try {
    previousMarkdown = readFileSync(inventoryPath, 'utf-8');
  } catch {
    previousMarkdown = null;
  }

  console.log(renderInventory(report, previousMarkdown));

  if (write) {
    writeFileSync(inventoryPath, renderInventory(report, previousMarkdown), 'utf-8');
    console.log(`wrote ${INVENTORY_REL}`);
  }

  if (report.errors.length > 0) {
    console.error(`\ncheck-mutation-audit: ${report.errors.length} AUDIT-INTEGRITY problem(s)\n`);
    for (const e of report.errors) console.error(`  - ${e}`);
    console.error('\nStage 1 fails only on its own integrity — never on finding unwitnessed');
    console.error('sites, which are the measurement it exists to produce.');
    return 1;
  }

  console.log(
    `check-mutation-audit: OK — ${report.totals.witnessed}/${report.totals.sites} sites witnessed, ` +
      `${report.totals.unwitnessed} unwitnessed (reported, not failed), ` +
      `${report.exemptions.entries} exemption(s) on the ledger.`,
  );
  return 0;
}

if (isProcessEntryPoint(import.meta.url)) {
  process.exit(await main(process.argv));
}
