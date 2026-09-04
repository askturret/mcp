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
import { join, resolve } from 'node:path';
import { isProcessEntryPoint } from './lib/entry-point.mjs';

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

/** Public workspace package names, discovered rather than hardcoded. */
export function discoverPublicPackages(repoRoot) {
  const dir = join(repoRoot, 'packages');
  if (!existsSync(dir)) return new Set();
  const names = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(dir, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const m = JSON.parse(readFileSync(manifest, 'utf-8'));
      if (m.private !== true && typeof m.name === 'string') names.add(m.name);
    } catch {
      // Unreadable manifests are reported by the packaging guards, not here.
    }
  }
  return names;
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
  for (const value of [contract.matrixVersion, contract.appliesToRelease, ...comparable]) {
    if (typeof value !== 'string' || value === '') continue;
    if (!md.includes(value)) {
      divergences.push(
        `docs/compatibility.md does not mention '${value}', which docs/compatibility.json states — ` +
          `the two copies are hand-maintained and must be edited together`,
      );
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
