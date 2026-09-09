#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The published compatibility contract is RE-DERIVED, not trusted (#612).
 *
 * ## What this exists to catch
 *
 * `docs/compatibility.md` published `@modelcontextprotocol/sdk` as `^0.5.0`,
 * tested `0.5.0`, ✅ Supported — while the root and `packages/transports` both
 * declared `^1.24.0`, because `^0.5.0` is the range excluded for
 * GHSA-w48q-cv73-mx4w (#140). A security-relevant row in the most
 * consumer-facing versioned document in this repository, contradicting the code,
 * with nothing able to notice. It surfaced only because #603's acceptance item
 * asked whether one phantom symbol was alone.
 *
 * ## Why a re-derived comparison, and why that is the whole design
 *
 * A comparison that RECOMPUTES is TIME-INDIFFERENT. It does not care whether a
 * row was wrong when written or became wrong later, because it never cached the
 * answer — so one assertion covers both species and no separate decay watcher is
 * needed. That is the load-bearing property here: ADR-023 says a decaying claim
 * needs something whose job is to notice, and the cheapest such thing is not a
 * scheduled re-read but an assertion that re-derives.
 *
 * ## What it does NOT do
 *
 * It does not read the `.md`'s prose. The hand-written call-outs are the most
 * valuable thing in that file — the Express 5 note is the model instance of a
 * bound naming its own expiry — and they are deliberately not machine-checked.
 * Generating one file from the other was explicitly rejected for the same
 * reason: it would destroy exactly what is worth keeping.
 *
 * ## The checks
 *
 *   A  SOURCE REQUIRED   every entry carrying `declared` must name where the
 *                        authoritative value lives. A missing `source` FAILS.
 *   B  DECLARED = TRUTH  `declared` must equal the value at `source`.
 *   C  TESTED = INSTALLED  `tested` must equal the version the lockfile installs.
 *   D  SUPPORTED ENTRY POINT  a framework with any `supported` row must name an
 *                        entry point this repository actually publishes.
 *   E  MD AGREES        every machine-comparable value in the JSON must appear
 *                        in the `.md`.
 *   F  NO ROW ESCAPES   every row carrying a `version` must declare HOW it is
 *                        verified — a `source` on its parent, or its own
 *                        `verifiedBy`. Declaring neither FAILS. (#618)
 *   G  SUPPORTED = INSTALLED  an adapter row marked `supported` must cover the
 *                        major the lockfile actually installs. (#618)
 *   H  THE TEST EXISTS  a `verifiedBy` must name a file that is there. (#618)
 *   I  ENFORCEMENT = CHECKS  `contract.enforcement` must enumerate the same
 *                        check letters this guard defines — set equality and
 *                        the count, not a reading of the prose. (#630)
 *   J  ONE STATUS VOCABULARY  the statuses `statusLegend` defines and the ones
 *                        the `.md`'s vocabulary table lists must be the same
 *                        SET. Names, not descriptions — the two documents are
 *                        different registers by design. (#775)
 *
 * CHECK A IS THE ONE THAT KEEPS THE REST HONEST. Without it the guard silently
 * covers only the entries somebody remembered to annotate — which is the opt-in
 * failure #612 is about, reproduced one level down inside its own fix.
 *
 * AND CHECK F IS THE SAME LESSON, ONE LEVEL FURTHER DOWN. A closed the door on
 * a row omitting `source`; it could not close the door on a row carrying no
 * `declared` at all, and SEVEN did — four adapter rows and three OpenAPI source
 * rows, invisible to A, B and C alike (#618). So enrolment is no longer "has a
 * `declared` key", which is a property of whether someone remembered to
 * annotate the row; it is "carries a version", which is a property of the row.
 *
 * The vocabulary is deliberately two members, and they are NOT equal strength:
 * a `source` row is re-derived every run and is time-indifferent, while a
 * `verifiedBy` row is only as good as the test it names. The schema states that
 * asymmetry rather than hiding it behind a single "checked" flag.
 *
 * WHY `verifiedBy` EXISTS AT ALL, rather than forcing a `source` everywhere:
 * the OpenAPI rows have no manifest field to point at. Acceptance is a literal
 * inside a conditional in `from-openapi.ts`, so a `source` there could only
 * point at a line of TypeScript. Matching literals out of source is a pattern
 * matcher standing in for a parser, and it would keep passing after someone
 * rewrote the predicate as a regex or a Set. The semantic check therefore lives
 * in that package's own test, where the real code can simply be imported and
 * run; this guard asserts only that the named test still exists.
 *
 * ## What check E is and is not
 *
 * A value-presence comparison, not a semantic one. It catches the imminent
 * class — one copy fixed and the other not — and it would have been GREEN on the
 * SDK bug, because that row drifted IDENTICALLY in both files. Recorded here so
 * nobody later mistakes it for the check that catches synchronised drift. B and
 * C are what catch that, because they compare against the CODE rather than
 * against the other copy.
 *
 * Exit codes: 0 pass, 1 divergence, 2 could not check.
 *
 * Zero dependencies and no network, so it runs as a step in an existing job
 * rather than costing a runner slot — this repository has ONE self-hosted
 * runner and CI is strictly serial, so a new job is a permanent tax on the
 * critical path.
 *
 * Run: node .github/scripts/check-compatibility-contract.mjs [repoRoot]
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessEntryPoint } from './lib/entry-point.mjs';
import { publicPackages } from './lib/public-packages.mjs';

/** Number words this guard can read back out of the enforcement prose. */
const WORD_TO_NUMBER = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
});

/**
 * The check letters this guard actually defines, read from its own source.
 *
 * `fileURLToPath`, never `new URL(...).pathname` — the latter percent-encodes,
 * so a checkout path containing a space resolves to a file that does not exist
 * (#110, which this repository keeps rediscovering).
 *
 * Reading its own source is the point rather than a shortcut: the alternative
 * is a hand-maintained list of letters inside the guard, which is the same
 * unenumerated-set defect one level down — a second copy to go stale.
 */
export function definedCheckLetters(guardPath = fileURLToPath(import.meta.url)) {
  let text;
  try {
    text = readFileSync(guardPath, 'utf-8');
  } catch {
    return [];
  }
  return [...new Set([...text.matchAll(/^\s*\/\/ --- ([A-Z]): /gm)].map((m) => m[1]))].sort();
}

export const EXIT_OK = 0;
export const EXIT_DIVERGENCE = 1;
export const EXIT_CANNOT_CHECK = 2;

/**
 * Resolve a `source` string such as:
 *
 *   package.json#engines.node
 *   package.json#peerDependencies["@modelcontextprotocol/sdk"]
 *
 * Bracket syntax exists because npm package names contain dots and slashes, so
 * a dotted path alone cannot address them. Returns `{ value }` or `{ error }` —
 * never a bare undefined, because "the path resolved to nothing" and "the path
 * was malformed" are different failures and the caller must be able to say
 * which.
 */
export function resolveSource(repoRoot, source) {
  if (typeof source !== 'string' || !source.includes('#')) {
    return { error: `malformed source (expected 'file#path'): ${JSON.stringify(source)}` };
  }
  const [file, path] = [source.slice(0, source.indexOf('#')), source.slice(source.indexOf('#') + 1)];
  const abs = join(repoRoot, file);
  if (!existsSync(abs)) return { error: `source file does not exist: ${file}` };

  let doc;
  try {
    doc = JSON.parse(readFileSync(abs, 'utf-8'));
  } catch (err) {
    return { error: `source file is not readable JSON: ${file} (${err && err.message})` };
  }

  const segments = [];
  const re = /\["([^"]+)"\]|\['([^']+)'\]|([^.[\]]+)/g;
  let m;
  while ((m = re.exec(path)) !== null) segments.push(m[1] ?? m[2] ?? m[3]);
  if (segments.length === 0) return { error: `source names no path: ${source}` };

  let node = doc;
  for (const seg of segments) {
    if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, seg)) {
      return { error: `source path not found in ${file}: ${path}` };
    }
    node = node[seg];
  }
  return { value: node };
}

/** Every entry in the contract that carries a `declared` value. */
export function declaredEntries(contract) {
  const found = [];
  (function walk(node, path) {
    if (node === null || typeof node !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(node, 'declared')) {
      found.push({
        path: path || '(root)',
        declared: node.declared,
        source: node.source,
        tested: node.tested,
        package: node.package,
      });
    }
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  })(contract, '');
  return found;
}

/**
 * Public workspace package names, discovered rather than hardcoded.
 *
 * The walk is shared (#711). The POLICY stays here: an unreadable manifest is
 * skipped, because unreadable manifests are reported by the packaging guards
 * and not by this one — and an absent `packages/` yields an empty set rather
 * than a refusal, because this guard only consults the set when a support claim
 * needs holding to it.
 */
export function discoverPublicPackages(repoRoot) {
  const { packages } = publicPackages(repoRoot);
  return new Set((packages ?? []).map((p) => p.name));
}

/** The version the lockfile actually installs for a package, or null. */
export function installedVersion(lock, pkgName) {
  const packages = lock && lock.packages;
  if (!packages || typeof packages !== 'object') return null;
  const entry = packages[`node_modules/${pkgName}`];
  return entry && typeof entry.version === 'string' ? entry.version : null;
}

/**
 * Every row carrying a `version`, with the object that owns its `entries` list.
 *
 * Check A stopped a row escaping coverage by omitting `source`. It could not
 * stop a row escaping by carrying no `declared` at all — and seven did (#618).
 * The walk below is what makes those rows addressable: enrolment stops being
 * "has a `declared` key" and becomes "carries a version", which is a property
 * of the thing itself rather than of whether someone remembered to annotate it.
 *
 * The owning object matters because verification lives at different levels for
 * different kinds of row. An adapter has ONE peer range and TWO rows
 * partitioning it by CI coverage, so `source` belongs to the adapter; a row
 * whose authority is code rather than data carries its own `verifiedBy`.
 */
export function versionBearingRows(contract) {
  const found = [];
  (function walk(node, path, owner) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, owner));
      return;
    }
    if (typeof node.version === 'string') found.push({ path, row: node, owner });
    for (const [k, v] of Object.entries(node)) {
      // The object holding an `entries` array is the owner for those rows.
      walk(v, path ? `${path}.${k}` : k, k === 'entries' ? node : owner);
    }
  })(contract, '', null);
  return found;
}

/**
 * The MAJOR versions a row's human notation names.
 *
 * Row versions are prose, not semver ranges — "4.18.x - 4.x", "2.0 (Swagger)".
 * Comparing them to a peer range as STRINGS would fail on day one and get
 * weakened to nothing by the second person to hit it, so the comparison is
 * containment of a concrete installed version's major instead.
 *
 * Major granularity is deliberate and is the honest reading of what these rows
 * assert: "4.18.x - 4.x" claims the 4 line, and an upgrade within it is not a
 * contract change. An upgrade ACROSS it is exactly what must be caught.
 */
export function majorsNamedBy(versionText) {
  if (typeof versionText !== 'string') return new Set();
  const tokens = versionText.match(/\d+(?:\.[0-9x]+)*/g) ?? [];
  return new Set(tokens.map((t) => Number(t.split('.')[0])).filter((n) => Number.isFinite(n)));
}

/** Every `status` value appearing anywhere under a node. */
function statusesUnder(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (typeof node.status === 'string') out.push(node.status);
  for (const v of Object.values(node)) statusesUnder(v, out);
  return out;
}

export function main(argv) {
  const repoRoot = resolve(argv[2] || '.');
  const jsonPath = join(repoRoot, 'docs', 'compatibility.json');
  const mdPath = join(repoRoot, 'docs', 'compatibility.md');
  const lockPath = join(repoRoot, 'package-lock.json');

  const cannotCheck = [];
  const divergences = [];

  for (const [label, p] of [['contract', jsonPath], ['rendering', mdPath], ['lockfile', lockPath]]) {
    if (!existsSync(p)) cannotCheck.push(`the ${label} does not exist at ${p.slice(repoRoot.length + 1)}`);
  }
  if (cannotCheck.length > 0) return report(divergences, cannotCheck, 0);

  let contract;
  let md;
  let lock;
  try {
    contract = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    md = readFileSync(mdPath, 'utf-8');
    lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch (err) {
    cannotCheck.push(`the contract could not be parsed: ${err && err.message}`);
    return report(divergences, cannotCheck, 0);
  }

  const entries = declaredEntries(contract);

  // Guards the guard. An empty set would make every case below vacuously true,
  // which is how a check rots into decoration.
  if (entries.length === 0) {
    cannotCheck.push('no entry in the contract carries a `declared` value — either the schema changed or this walk is broken');
    return report(divergences, cannotCheck, 0);
  }

  const comparable = [];

  for (const entry of entries) {
    // --- A: SOURCE REQUIRED ------------------------------------------------
    // The check that keeps the others honest. An entry with no `source` is not
    // skipped, because skipping is how coverage silently becomes opt-in.
    if (typeof entry.source !== 'string' || entry.source === '') {
      divergences.push(
        `${entry.path}: declares '${entry.declared}' but carries no \`source\` — nothing says where the ` +
          `authoritative value lives, so this row cannot be re-derived and would be covered by nothing`,
      );
      continue;
    }

    // --- B: DECLARED = TRUTH -----------------------------------------------
    const resolved = resolveSource(repoRoot, entry.source);
    if (resolved.error) {
      cannotCheck.push(`${entry.path}: ${resolved.error}`);
    } else if (resolved.value !== entry.declared) {
      divergences.push(
        `${entry.path}: contract declares '${entry.declared}' but ${entry.source} says ` +
          `'${resolved.value}' — the published contract and the code disagree`,
      );
    }
    comparable.push(String(entry.declared));

    // --- C: TESTED = INSTALLED ---------------------------------------------
    if (entry.tested !== undefined) {
      if (typeof entry.package !== 'string' || entry.package === '') {
        divergences.push(
          `${entry.path}: claims tested '${entry.tested}' but names no \`package\`, so the version CI ` +
            `installs cannot be looked up`,
        );
      } else {
        const installed = installedVersion(lock, entry.package);
        if (installed === null) {
          cannotCheck.push(`${entry.path}: '${entry.package}' is not in package-lock.json, so the tested version could not be confirmed`);
        } else if (installed !== entry.tested) {
          divergences.push(
            `${entry.path}: contract says tested against '${entry.tested}' but the lockfile installs ` +
              `'${installed}' — "Supported" means exercised by CI, and CI exercises the lockfile`,
          );
        }
        comparable.push(String(entry.tested));
      }
    }
  }

  // --- E's INPUT, WIDENED: DECLARED NOTE MIRRORS (#700) ----------------------
  //
  // `comparable` collected only `declared`, `tested` and `entryPoint`, so NO
  // check anywhere read a `note`. #625 aligned six note copies by hand and
  // nothing could notice the next edit separating them — the guard was green,
  // was correctly cited as the .md <-> .json comparison, and did not compare the
  // field that PR changed.
  //
  // WHY THIS IS OPT-IN RATHER THAN EVERY NOTE, WHICH IS WHAT WAS ASKED FOR.
  // Measured before building it: of the 13 `note` fields, exactly 2 appear
  // verbatim in the .md. Feeding all 13 to check E would redden main eleven
  // times on a tree everyone agrees is correct — and the eleven are not drift.
  // The two documents are written in different REGISTERS: the .md is formatted
  // markdown (`**and**`, `` `peerDependencies` ``) and the .json is plain text,
  // so most pairs are paraphrase BY DESIGN. Zero of the five statusLegend values
  // appear verbatim for exactly that reason.
  //
  // So byte-equality is not a property of notes in general, and a guard asserting
  // it would be wrong rather than strict. It IS a property of the ones #625
  // deliberately aligned, and `mirroredInMd` is where that intent is now written
  // down instead of being inferable only by diffing the two files.
  //
  // THE BOUNDARY, STATED (#700 item 4): a note carrying `mirroredInMd: true`
  // must appear byte-for-byte in the .md. Every other note is paraphrase and is
  // NOT compared. Paraphrased prose describing the same fact does not create a
  // false claim; two copies stating different MECHANISMS does, which is the
  // failure this closes. Adding the flag is how a claim becomes contractual —
  // and it is a decision someone makes, not a default that quietly widens.
  const mirroredNotes = [];
  const collectMirrored = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) collectMirrored(item);
      return;
    }
    if (node.mirroredInMd === true && typeof node.note === 'string') mirroredNotes.push(node.note);
    for (const value of Object.values(node)) collectMirrored(value);
  };
  collectMirrored(contract);

  // A flag on an object with no note is a mis-declaration, not a no-op: it reads
  // as covered and is covered by nothing. Refused rather than skipped, for the
  // same reason check A refuses a row with no `source`.
  const collectMisdeclared = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => collectMisdeclared(item, `${path}[${i}]`));
      return;
    }
    if (node.mirroredInMd === true && typeof node.note !== 'string') {
      divergences.push(
        `${path || 'contract'}: carries \`mirroredInMd: true\` but no string \`note\` — the flag declares a ` +
          `note is mirrored in docs/compatibility.md, so an object without one is covered by nothing`,
      );
    }
    for (const [k, v] of Object.entries(node)) collectMisdeclared(v, path ? `${path}.${k}` : k);
  };
  collectMisdeclared(contract, '');

  // THE INVERSE: A NOTE ALREADY MIRRORED MUST SAY SO (#776).
  //
  // The block above compares only notes carrying the flag, and the flag is
  // OPT-IN — so coverage is exactly as good as whoever remembered to set it.
  // That RELOCATES the #700 class rather than closing it: from "nobody compares
  // the copies" to "nobody flags the copies". The relocation was monotone and
  // honest, but the second half of the biconditional is what closes it.
  //
  // WHAT THIS COMPARES, AND WHY IT CAN BE EXACT WHERE BYTE-EQUALITY OF NOTES
  // CANNOT. It does not compare PROSE — the block above explains why that would
  // be wrong, since most pairs are paraphrase by design and eleven of thirteen
  // would redden a correct tree. It compares THE RELATIONSHIP between a fact and
  // its declaration: if the two documents ALREADY agree byte-for-byte, then the
  // relationship exists whether or not anyone declared it, and an undeclared one
  // is a mirror nothing is watching.
  //
  // WHY IT IS SAFE HERE IN THE GUARD, RATHER THAN IN THE SELF-TEST — and the
  // #773 precedent immediately above genuinely does not transfer, though it
  // looks like it should. #773's first draft refused a contract with NO mirrored
  // note. Absence is a LEGITIMATE STATE that most contracts are in, so refusing
  // it refused valid inputs, and ten fixtures went to cannot-check. This refuses
  // an INCONSISTENCY that is PRESENT: two documents that already agree while the
  // contract says nothing about it. No contract needs to be in that state, so
  // nothing valid is refused by forbidding it.
  //
  // Measured before choosing, the same way #773's draft was caught: with this in
  // the guard the self-test is 98/0 and the real tree is green. Zero fixtures are
  // affected, because no fixture's `.md` carries a fixture note verbatim.
  //
  // NO MINIMUM LENGTH, AND THE BOUNDARY IS MEASURED RATHER THAN ASSUMED (#776
  // question b). The worry is that a SHORT shared phrase collides innocently and
  // this demands a flag for a mirror nobody intended. Measured 2026-09-08 over
  // all 13 notes: the shortest is 23 characters — `The version CI runs on.` —
  // which is a complete sentence, occurs exactly once in the .md, and is itself
  // one of the two deliberately mirrored notes.
  //
  // So the "100+ character sentence" intuition this rule was proposed under is
  // NOT true of the tree it runs on, and a threshold set anywhere above 23 would
  // exclude a live subject and halve the rule's coverage. Collision risk belongs
  // to FRAGMENTS — `LTS` occurs twice in the .md, `supported` fourteen times —
  // and no note is a fragment. The floor is asserted against the real contract in
  // the self-test, so adding a genuinely short note re-opens this question
  // instead of silently crossing the boundary.
  //
  // And if a collision ever did occur, the remedy is free and correct: the note
  // already matches, so setting the flag costs nothing and states a true thing.
  const collectUndeclaredMirror = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => collectUndeclaredMirror(item, `${path}[${i}]`));
      return;
    }
    if (typeof node.note === 'string' && node.mirroredInMd !== true && md.includes(node.note)) {
      // NAMES THE NOTE, not just the path. The path is what a reader edits, but
      // notes here run to 736 characters, so quote a bounded excerpt: enough to
      // identify WHICH sentence without pasting a paragraph into a CI log.
      const excerpt = node.note.length > 60 ? `${node.note.slice(0, 60)}…` : node.note;
      divergences.push(
        `${path || 'contract'}: its \`note\` ("${excerpt}") appears VERBATIM in docs/compatibility.md but ` +
          `does not carry \`mirroredInMd: true\`. The two copies already agree, so the mirror exists — it ` +
          `is just not declared, which means nothing compares them and the next edit to either can ` +
          `separate them silently. Add the flag (it is free: the note already matches), or reword one ` +
          `copy if the match was not intended.`,
      );
    }
    for (const [k, v] of Object.entries(node)) collectUndeclaredMirror(v, path ? `${path}.${k}` : k);
  };
  collectUndeclaredMirror(contract, '');

  // NO VACUITY REFUSAL HERE, and the first draft had one. A contract with no
  // mirrored note is legitimate — every synthetic fixture in the self-test is
  // one, and refusing them turned ten passing cases into cannot-check. The
  // vacuity that matters is THIS repository's contract losing its flags, which
  // is asserted against the real tree in the self-test instead. A guard that
  // refuses valid inputs to catch a regression in one specific input is
  // measuring the wrong thing in the wrong place.
  for (const note of mirroredNotes) comparable.push(note);

  // --- D: SUPPORTED ENTRY POINT ---------------------------------------------
  // The aspirational species: a row may name an entry point that was intended
  // and never shipped. Do not watch the plan — assert the artifact the claim
  // presupposes. `@askturret/mcp/express` sat here as Supported while the
  // umbrella package returned 404 (#598).
  const supportedAdapters = (Array.isArray(contract.adapters) ? contract.adapters : []).filter((a) =>
    statusesUnder(a).includes('supported'),
  );

  // Only consult the workspace when there is a support claim to hold to it. A
  // contract with no supported adapter row needs no package set, and reporting
  // cannot-check for an absent one would be a complaint about nothing.
  if (supportedAdapters.length > 0) {
    const published = discoverPublicPackages(repoRoot);
    if (published.size === 0) {
      cannotCheck.push('no public workspace packages were discovered, so supported entry points could not be checked');
    }
    for (const adapter of published.size === 0 ? [] : supportedAdapters) {
      const entryPoint = adapter.entryPoint;
      if (typeof entryPoint !== 'string' || entryPoint === '') {
        divergences.push(`adapters.${adapter.framework}: has a 'supported' row but names no entryPoint`);
        continue;
      }
      const base = entryPoint.split('/').slice(0, 2).join('/');
      if (!published.has(entryPoint)) {
        divergences.push(
          `adapters.${adapter.framework}: is 'supported' with entryPoint '${entryPoint}', which this ` +
            `repository does not publish${published.has(base) ? '' : ` (nor '${base}')`} — a supported row must ` +
            `name a package a reader can install`,
        );
      }
      comparable.push(entryPoint);
    }
  }

  // --- F: NO ROW ESCAPES BY OMISSION (#618) ---------------------------------
  //
  // Check A's real principle is not "carry a source" — it is "no row escapes
  // coverage by omission". A generalises it: a row must declare HOW it is
  // verified, from a closed two-member vocabulary, and declaring nothing fails.
  //
  //   source      a machine-readable location the guard re-derives and compares
  //   verifiedBy  the test that pins the behaviour, for rows whose authority is
  //               code rather than data
  //
  // THE TWO ARE NOT EQUAL STRENGTH, and the schema says so rather than hiding
  // it: a `source` row is re-derived every run and is time-indifferent, while a
  // `verifiedBy` row is only as good as the test it names.
  const rows = versionBearingRows(contract);

  // Vacuity guard, scoped. "No rows at all" is only suspicious when the contract
  // HAS entries arrays for them to live in — otherwise this fires on any
  // minimal contract that legitimately declares none, which would make the
  // check noisy rather than protective.
  const hasEntriesArrays = (function look(node) {
    if (node === null || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(look);
    if (Array.isArray(node.entries)) return true;
    return Object.values(node).some(look);
  })(contract);

  if (hasEntriesArrays && rows.length === 0) {
    cannotCheck.push('the contract has `entries` arrays but no row carries a `version` — either the schema changed or this walk is broken');
  }

  for (const { path, row, owner } of rows) {
    const hasSource = owner !== null && typeof owner.source === 'string' && owner.source !== '';
    const hasVerifiedBy = typeof row.verifiedBy === 'string' && row.verifiedBy !== '';

    if (!hasSource && !hasVerifiedBy) {
      divergences.push(
        `${path} declares version '${row.version}' but names neither a \`source\` on its parent nor a ` +
          `\`verifiedBy\` of its own — it is invisible to every check here, which is the omission #618 closes`,
      );
      continue;
    }

    // --- H: a named test must exist -----------------------------------------
    // Weak enforcement, deliberately, and honest about being weak: it catches
    // deletion and rename. A `verifiedBy` that merely records a string would be
    // decoration — the shape #612 found in check-platform-claims, where a
    // declared-unverifiable claim is printed and never affects the exit code.
    if (hasVerifiedBy && !existsSync(join(repoRoot, row.verifiedBy))) {
      divergences.push(
        `${path} is verified by '${row.verifiedBy}', which does not exist — a row pointing at a missing ` +
          `test is not a verified row`,
      );
    }
  }

  // --- G: A SUPPORTED ROW MUST COVER WHAT CI INSTALLS (#618) ----------------
  //
  // The assertion with the deadline. #585 upgrades express 4.22.2 -> 5.2.1; if
  // it lands and nobody edits the contract, "Express 4.18.x - 4.x / Supported"
  // becomes false while CI installs 5. This is check C's idiom applied per row,
  // and it needs no new metadata: the npm package name is the last segment of
  // the adapter's own `source` path.
  for (const adapter of Array.isArray(contract.adapters) ? contract.adapters : []) {
    if (typeof adapter.source !== 'string' || !Array.isArray(adapter.entries)) continue;
    const npmName = adapter.source.split('#').pop().split('.').pop();
    const installed = installedVersion(lock, npmName);

    if (installed === null) {
      cannotCheck.push(`adapters.${adapter.framework}: '${npmName}' is not in package-lock.json, so the supported row could not be checked`);
      continue;
    }

    const installedMajor = Number(installed.split('.')[0]);
    const supported = adapter.entries.filter((e) => e.status === 'supported');
    const covered = supported.some((e) => majorsNamedBy(e.version).has(installedMajor));

    if (!covered) {
      divergences.push(
        `adapters.${adapter.framework}: CI installs ${npmName} ${installed}, but no row marked 'supported' ` +
          `covers major ${installedMajor} — supported rows name ` +
          `${supported.length === 0 ? '(none)' : supported.map((e) => `'${e.version}'`).join(', ')}. ` +
          `The contract claims support for a line CI does not exercise.`,
      );
    }
  }

  // --- E: MD AGREES ---------------------------------------------------------
  // Value presence, not semantics. See the header: this would have been GREEN
  // on the SDK bug, because that row drifted identically in both copies.
  //
  // THE TWO HEADER FIELDS ARE ASSERTED IN THEIR AUTHORITATIVE POSITION (#629).
  //
  // Bare presence could not see the divergence this check exists for. QA set the
  // .md's authoritative line back to `2.1.0` while the JSON said `2.2.0` — a
  // plain one-copy-updated-the-other-not drift — and E stayed GREEN, because
  // `2.2.0` also occurs four times in the version-history prose and any one
  // occurrence satisfied `md.includes(value)`.
  //
  // AND IT WEAKENS MONOTONICALLY, which is why this is worth changing rather
  // than noting. The version-history prose grows with every release, so every
  // version string ever published becomes permanently present in the file. Each
  // release therefore adds another string that will satisfy this assertion
  // forever, for the one field whose drift it is meant to catch. It held today
  // only because both copies happened to be right — luck, not the check.
  //
  // NO PARSER, AND NO LOOSER REGEX. The needle is the literal text of the line
  // that OWNS the value, so what is compared changes while the mechanism —
  // `md.includes` on a fixed string — does not. Extracting the value with a
  // pattern matcher instead is the #593 shape this repository has rejected, and
  // #593 is open about exactly that failure; adopting it here would be a bad
  // trade for no gain.
  for (const { field, value, position } of [
    { field: 'matrixVersion', value: contract.matrixVersion, position: (v) => `Matrix version \`${v}\`` },
    { field: 'appliesToRelease', value: contract.appliesToRelease, position: (v) => `Applies to release \`${v}\`` },
  ]) {
    if (typeof value !== 'string' || value === '') continue;

    const needle = position(value);
    if (!md.includes(needle)) {
      // Distinguish the two failures a reader can hit, because the remedy
      // differs: a value that appears elsewhere is a STALE HEADER LINE, while a
      // value absent entirely is the ordinary both-copies-must-move case.
      const elsewhere = md.includes(value);
      divergences.push(
        elsewhere
          ? `docs/compatibility.md does not carry '${needle}', though '${value}' appears elsewhere in the ` +
            `file — docs/compatibility.json states ${field} '${value}', so the AUTHORITATIVE line is stale ` +
            `while a version-history mention makes the value look present. Update the header line.`
          : `docs/compatibility.md does not carry '${needle}', which docs/compatibility.json states as ` +
            `${field} — the two copies are hand-maintained and must be edited together`,
      );
    }
  }

  // The remaining values stay a PRESENCE test, deliberately. Declared and tested
  // ranges and entry points live in table cells with no fixed owning phrase, so
  // there is no authoritative position to pin them to — inventing one would mean
  // parsing the table, which is the thing ruled out above.
  for (const value of comparable) {
    if (typeof value !== 'string' || value === '') continue;
    if (!md.includes(value)) {
      divergences.push(
        `docs/compatibility.md does not mention '${value}', which docs/compatibility.json states — ` +
          `the two copies are hand-maintained and must be edited together`,
      );
    }
  }

  // --- I: THE ENFORCEMENT FIELD DESCRIBES THIS GUARD ------------------------
  //
  // `contract.enforcement` is PROSE, and no check compared it against anything.
  // It went stale once already — it claimed a versioned row naming no `source`
  // fails the build, which check F stopped being true — and a human reading is
  // what caught that.
  //
  // MOST OF IT CANNOT BE MECHANICALLY CHECKED, and this does not pretend
  // otherwise. What CAN be is the part that goes stale the way it actually went
  // stale: the field ENUMERATES the checks by letter and states how many there
  // are, and this guard labels each of its checks with the same letter in
  // source. Those two sets must agree.
  //
  // So the assertion is set equality plus the count, NOT a reading of the
  // descriptions. Add a check without enumerating it here, remove one without
  // deleting its claim, or renumber, and this fires. Reword what check C
  // *means* and it does not — that is the bound, it is stated here rather than
  // implied, and the self-test asserts it as a bound rather than describing it.
  const enforcement = contract?.contract?.enforcement;
  if (typeof enforcement !== 'string' || enforcement === '') {
    divergences.push(
      'contract.enforcement is absent or empty — the field that states what this guard enforces is the one ' +
        'thing here with no source to re-derive from, so an empty one is a claim nobody can check rather than ' +
        'a missing nicety',
    );
  } else {
    const claimed = [...new Set([...enforcement.matchAll(/\(([A-Z])\)/g)].map((m) => m[1]))].sort();
    const defined = definedCheckLetters();

    if (defined.length === 0) {
      // The markers are how this check sees the guard. If they vanish, it must
      // say it could not look rather than report agreement with an empty set.
      cannotCheck.push(
        'no `// --- X:` check markers were found in this guard, so the enforcement field could not be ' +
          'compared against the checks that actually run',
      );
    } else {
      const missing = defined.filter((l) => !claimed.includes(l));
      const extra = claimed.filter((l) => !defined.includes(l));

      if (missing.length > 0) {
        divergences.push(
          `contract.enforcement does not enumerate check(s) ${missing.join(', ')}, which this guard runs and ` +
            'fails the build on. A check the contract does not claim is enforcement nobody was told about.',
        );
      }
      if (extra.length > 0) {
        divergences.push(
          `contract.enforcement enumerates check(s) ${extra.join(', ')}, which this guard does not run. ` +
            'That is the stale-claim shape this field has already had once.',
        );
      }

      // THE SAME ENUMERATION EXISTS TWICE. `docs/compatibility.md` carries it a
      // second time, as a `| **A** | ... |` table — so checking only the JSON
      // would leave the one-copy-updated-the-other-not defect that this entire
      // guard exists to catch, in the passage describing the guard.
      const inMd = [...new Set([...md.matchAll(/^\s*\|\s*\*\*([A-Z])\*\*\s*\|/gm)].map((m) => m[1]))].sort();
      if (inMd.length === 0) {
        cannotCheck.push(
          'docs/compatibility.md carries no `| **X** |` check table, so its copy of the enumeration could ' +
            'not be compared — it may have been restructured, which needs a human rather than a pass',
        );
      } else {
        const mdMissing = defined.filter((l) => !inMd.includes(l));
        const mdExtra = inMd.filter((l) => !defined.includes(l));
        if (mdMissing.length > 0) {
          divergences.push(
            `docs/compatibility.md's check table omits ${mdMissing.join(', ')}, which this guard runs. The ` +
              'JSON and the .md each carry this list, and both are hand-maintained.',
          );
        }
        if (mdExtra.length > 0) {
          divergences.push(
            `docs/compatibility.md's check table lists ${mdExtra.join(', ')}, which this guard does not run.`,
          );
        }
      }

      // THE COUNT IS ASSERTED AGAINST THE DERIVATION, NOT TRUSTED. A spelled
      // number in prose is the tally trap this repository keeps removing — the
      // remedy is not to delete the number but to make it re-derived, so a
      // reader still sees a figure and the figure cannot be wrong.
      const spelled = enforcement.match(/runs ([A-Z]+) checks/);
      const stated = spelled ? WORD_TO_NUMBER[spelled[1].toLowerCase()] : undefined;
      if (spelled && stated === undefined) {
        divergences.push(
          `contract.enforcement says it runs '${spelled[1]}' checks, which is not a number word this guard ` +
            'can read. Spell it in words this recognises, or the count is unverifiable.',
        );
      } else if (stated !== undefined && stated !== defined.length) {
        divergences.push(
          `contract.enforcement says it runs ${spelled[1]} checks, but this guard defines ${defined.length} ` +
            `(${defined.join(', ')}). The count and the enumeration must both come from the same place.`,
        );
      }
    }
  }

  // --- J: THE STATUS VOCABULARY IS ONE SET, NOT TWO (#775) ------------------
  //
  // `statusLegend` defines the vocabulary; the .md's "Status vocabulary" table
  // states it again for humans. They had already diverged: the legend defined
  // FIVE statuses and the table listed FOUR, with `deprecated` in one copy and
  // absent from the other. Nothing compared them, so nothing could notice.
  //
  // WHY NOT GENERATE THE TABLE FROM THE LEGEND. That is this file's own
  // recorded decision, in the header above: generating one document from the
  // other "would destroy exactly what is worth keeping". The two are written in
  // different REGISTERS on purpose — the .md carries emoji, bold and backticks
  // for a reader, the .json plain text for a machine — and check E's reasoning
  // already notes that ZERO of the statusLegend values appear verbatim in the
  // .md for precisely that reason.
  //
  // SO THE NAMES ARE COMPARED AND THE DESCRIPTIONS ARE NOT. Which statuses
  // exist is a fact and must be single-valued; how each is phrased for a human
  // is presentation. That is the line check E already draws for notes —
  // byte-equality only where `mirroredInMd` opts in, paraphrase everywhere else
  // — applied to the vocabulary instead of to prose. Byte-equality here would
  // be wrong rather than strict, and would redden a tree everyone agrees is
  // correct.
  //
  // Matching is on a SLUG, so the emoji, the bold and the comma in
  // "Declared, untested" normalise away while the row must still name the same
  // status the legend does.
  const legend = contract?.statusLegend;
  const legendStatuses =
    legend !== null && typeof legend === 'object' && !Array.isArray(legend) ? Object.keys(legend).sort() : null;

  if (legendStatuses === null || legendStatuses.length === 0) {
    cannotCheck.push(
      'docs/compatibility.json carries no `statusLegend` object, so the status vocabulary could not be ' +
        'compared against the .md — an absent legend is a claim nobody can check rather than agreement',
    );
  } else {
    // Scoped to the section that owns the vocabulary. Matching every table in
    // the file would collect version rows and report nonsense.
    // Terminates on the next `## ` heading OR on end-of-input. The end-of-input
    // arm is not hypothetical: without it a vocabulary section that happens to
    // be LAST in the file matches nothing and the check reports cannot-check on
    // a document that is perfectly correct. Found by the self-test, whose
    // fixtures append the section at the end.
    const section = /(?:^|\n)##[ \t]+Status vocabulary[ \t]*\n([\s\S]*?)(?=\n##[ \t]|$)/.exec(md);
    if (section === null) {
      cannotCheck.push(
        'docs/compatibility.md carries no `## Status vocabulary` section, so its copy of the vocabulary ' +
          'could not be located — it may have been retitled, which needs a human rather than a pass',
      );
    } else {
      const slug = (cell) =>
        cell
          .replace(/\*\*/g, '')
          .replace(/`/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');

      const inMd = [
        ...new Set(
          [...section[1].matchAll(/^\s*\|([^|]+)\|/gm)]
            .map((m) => slug(m[1]))
            // The header cell and the `|---|---|` separator are not statuses.
            .filter((s) => s !== '' && s !== 'status'),
        ),
      ].sort();

      if (inMd.length === 0) {
        cannotCheck.push(
          'the `## Status vocabulary` section carries no table rows, so the .md copy of the vocabulary ' +
            'could not be compared',
        );
      } else {
        const mdMissing = legendStatuses.filter((s) => !inMd.includes(s));
        const mdExtra = inMd.filter((s) => !legendStatuses.includes(s));
        if (mdMissing.length > 0) {
          divergences.push(
            `docs/compatibility.md's status vocabulary omits ${mdMissing.join(', ')}, which ` +
              'docs/compatibility.json defines in `statusLegend`. Both copies are hand-maintained, and this ' +
              'is the divergence #775 found.',
          );
        }
        if (mdExtra.length > 0) {
          divergences.push(
            `docs/compatibility.md's status vocabulary lists ${mdExtra.join(', ')}, which ` +
              'docs/compatibility.json does not define in `statusLegend`.',
          );
        }
      }
    }
  }

  return report(divergences, cannotCheck, entries.length, rows.length);
}

function report(divergences, cannotCheck, checked, rowCount = 0) {
  console.log(
    `check-compatibility-contract: re-derived ${checked} declared entr${checked === 1 ? 'y' : 'ies'} and ${rowCount} version-bearing row(s); ` +
      `${divergences.length} divergence(s), ${cannotCheck.length} cannot-check.`,
  );

  if (divergences.length > 0) {
    console.error('\n❌ THE PUBLISHED CONTRACT DISAGREES WITH THE CODE:');
    for (const d of divergences) console.error(`   ${d}`);
    console.error('\n   docs/compatibility.{md,json} is a versioned contract adopters rely on.');
    console.error('   Fix the contract, or fix the code — but they may not disagree.');
  }
  if (cannotCheck.length > 0) {
    console.error('\n⚠️  CANNOT CHECK — these rows were NOT verified:');
    for (const c of cannotCheck) console.error(`   ${c}`);
    console.error('   This is NOT a pass.');
  }

  if (divergences.length > 0) {
    console.error(`\n::error::${divergences.length} compatibility-contract divergence(s).`);
    return EXIT_DIVERGENCE;
  }
  if (cannotCheck.length > 0) {
    console.error(`\n::error::CANNOT CHECK — ${cannotCheck.length} row(s) could not be verified.`);
    return EXIT_CANNOT_CHECK;
  }

  console.log(
    'check-compatibility-contract: OK — every declared range, tested version and supported entry point matches ' +
      'the code, and every version-bearing row declares how it is verified.',
  );
  return EXIT_OK;
}

if (isProcessEntryPoint(import.meta.url)) {
  process.exit(main(process.argv));
}
