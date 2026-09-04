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
 *
 * CHECK A IS THE ONE THAT KEEPS THE REST HONEST. Without it the guard silently
 * covers only the entries somebody remembered to annotate — which is the opt-in
 * failure #612 is about, reproduced one level down inside its own fix.
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
import { pathToFileURL } from 'node:url';

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

  return report(divergences, cannotCheck, entries.length);
}

function report(divergences, cannotCheck, checked) {
  console.log(
    `check-compatibility-contract: re-derived ${checked} declared entr${checked === 1 ? 'y' : 'ies'}; ` +
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

  console.log('check-compatibility-contract: OK — every declared range, tested version and supported entry point matches the code.');
  return EXIT_OK;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exit(main(process.argv));
}
