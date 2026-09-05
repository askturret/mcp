#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Every version-bearing literal in published source declares what it mirrors (#601).
 *
 * ## Why this exists
 *
 * `VERSION = '0.1.0'` shipped from a 0.1.1 package. The v0.1.2 release then
 * hand-corrected version literals in FIVE places, and FOUR of the five were
 * found by SEARCHING rather than by enumeration. One of them — `GATEWAY_VERSION`
 * — would otherwise have shipped `0.1.0` from a `0.1.2` package on the built
 * public surface.
 *
 * The failure mode is not carelessness. It is that a hand-maintained set has no
 * member list anyone can check against. So the list is a committed artifact,
 * `.github/version-literals.json`, and this guard compares it to the tree.
 *
 * ## TWO DIRECTIONS, NOT THE SAME STRENGTH
 *
 *   REGISTRY -> TREE   EXHAUSTIVE over the registry. Every entry is checked: the
 *                      file must exist, the declared source line must still be
 *                      present, and where the entry names a canonical source the
 *                      literal must equal it. Nothing declared here escapes.
 *
 *   TREE -> REGISTRY   BEST-EFFORT. It fails on the undeclared literals it finds
 *                      and is SILENT on the ones it does not.
 *
 * THE TREE -> REGISTRY BOUND IS `discoverLiterals`, NOT THIS PARAGRAPH. Read it.
 * As it stands it matches a quoted `N.N.N` in non-test `.ts` files under
 * `packages/<pkg>/src`, so these are NOT found:
 *
 *   - a version built by concatenation or a template string
 *   - a two-component version, or one carrying a prerelease or build suffix
 *   - a literal in a file type that is not `.ts`, or outside `packages/<pkg>/src`
 *   - a version read from a constant defined elsewhere and re-exported
 *
 * Each of those is pinned as an executable assertion in the self-test, so
 * widening the pattern REDDENS the assertion that says the shape is missed and
 * forces this list to be corrected in the same change. A described bound is what
 * goes stale; an asserted one cannot.
 *
 * ## `mirrors` IS THE WHOLE DESIGN, AND THE EXCLUSION IS STRUCTURAL
 *
 * Each entry names its OWN canonical source, and this guard only ever compares a
 * literal to the source THAT ENTRY names. Entries whose `mirrors` is `none`
 * therefore have no comparison performed at all — there is no path by which a
 * plugin `apiVersion` could be measured against a package manifest.
 *
 * That matters because only some of these are package versions. Others are the
 * PLUGIN API version, which `docs/compatibility-policy.md` states moves
 * INDEPENDENTLY of the package version. "Derive them all from package.json" was
 * proposed, refuted from source and withdrawn: it would break a published
 * compatibility guarantee. The `none` entries are not omissions, and they are not
 * a skip list — they are declarations with a stated reason, which is what makes
 * them reviewable.
 *
 * ## IDENTITY IS THE SOURCE LINE, NEVER A LINE NUMBER
 *
 * A line number goes stale on the next edit above it, silently. The registry
 * carries the line's TEXT and this guard matches on that — the same choice the
 * mutation-audit ledger made, for the same reason.
 *
 * ## EXIT CODES
 *
 *   0  the registry and the tree agree
 *   1  DIVERGENCE — a literal disagrees with its declared source, an entry is
 *      stale, or an undeclared literal was found
 *   2  CANNOT CHECK — the registry or the package tree could not be read
 *
 * Never exit 0 when the comparison did not happen (#281).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isProcessEntryPoint } from './lib/entry-point.mjs';

export const REGISTRY_REL = '.github/version-literals.json';

export const EXIT_OK = 0;
export const EXIT_DIVERGENCE = 1;
export const EXIT_CANNOT_CHECK = 2;

/** Fields every entry must carry, non-empty. */
const REQUIRED_FIELDS = Object.freeze(['id', 'path', 'source', 'mirrors', 'reason']);

/**
 * A quoted three-component version, as it appears in source.
 *
 * Deliberately narrow. A looser pattern would collect every quoted number in the
 * tree and drown the real members — the discovery pass exists to FIND CANDIDATES
 * for declaration, and a candidate list nobody can read is not one.
 */
const VERSION_LITERAL = /['"](\d+\.\d+\.\d+)['"]/g;

/** Whitespace-normalised, so indentation changes do not break identity. */
export function normaliseSource(line) {
  return String(line).trim().replace(/\s+/g, ' ');
}

/**
 * Every version-bearing literal this guard can see, as {path, source, literal}.
 *
 * THE BOUND OF TREE -> REGISTRY. Test files are excluded because fixtures name
 * versions constantly and none of them ship; `__tests__` directories and
 * `.test.ts` files are both skipped.
 */
export function discoverLiterals(repoRoot) {
  const found = [];
  const problems = [];
  const packagesDir = join(repoRoot, 'packages');

  let packages;
  try {
    packages = readdirSync(packagesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (err) {
    problems.push(`cannot read packages/ (${err?.message ?? err})`);
    return { found, problems };
  }
  if (packages.length === 0) problems.push('packages/ contains no directories to scan');

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      problems.push(`cannot read ${dir} (${err?.message ?? err})`);
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(abs);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;

      let text;
      try {
        text = readFileSync(abs, 'utf-8');
      } catch (err) {
        problems.push(`cannot read ${abs} (${err?.message ?? err})`);
        continue;
      }
      text.split('\n').forEach((line) => {
        for (const m of line.matchAll(VERSION_LITERAL)) {
          found.push({
            // `relative`, not a slice of the absolute path: with `repoRoot` of
            // '.' a slice removes one real character and every path silently
            // fails to match its registry entry.
            path: relative(repoRoot, abs).split(sep).join('/'),
            source: normaliseSource(line),
            literal: m[1],
          });
        }
      });
    }
  };

  for (const pkg of packages) {
    const src = join(packagesDir, pkg.name, 'src');
    if (existsSync(src)) walk(src);
  }
  return { found, problems };
}

/**
 * Resolve a `path/to/file.json#field` reference to its value.
 *
 * Returns `{ value }` or `{ error }` — never a bare `undefined`, because an
 * unresolvable reference comparing equal to an absent literal would report
 * agreement between two nothings.
 */
export function resolveCanonical(repoRoot, ref) {
  if (typeof ref !== 'string' || !ref.includes('#')) {
    return { error: `'${ref}' is not a 'file#field' reference` };
  }
  const [rel, field] = ref.split('#');
  const abs = join(repoRoot, rel);
  if (!existsSync(abs)) return { error: `${rel} does not exist` };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf-8'));
  } catch (err) {
    return { error: `${rel} is not valid JSON (${err?.message ?? err})` };
  }
  const value = parsed?.[field];
  if (typeof value !== 'string' || value === '') return { error: `${rel} has no string '${field}'` };
  return { value };
}

export function main(argv) {
  const repoRoot = argv[2] ?? '.';
  const registryPath = join(repoRoot, REGISTRY_REL);

  if (!existsSync(registryPath)) {
    console.error(`check-version-literals: CANNOT CHECK — ${REGISTRY_REL} does not exist, so nothing could be compared.`);
    return EXIT_CANNOT_CHECK;
  }

  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch (err) {
    console.error(`check-version-literals: CANNOT CHECK — ${REGISTRY_REL} is not valid JSON (${err?.message ?? err}).`);
    return EXIT_CANNOT_CHECK;
  }
  if (!Array.isArray(registry?.literals)) {
    console.error(`check-version-literals: CANNOT CHECK — ${REGISTRY_REL} has no \`literals\` array.`);
    return EXIT_CANNOT_CHECK;
  }

  const { found, problems } = discoverLiterals(repoRoot);
  if (problems.length > 0) {
    console.error('check-version-literals: CANNOT CHECK — the package tree could not be scanned:');
    for (const p of problems) console.error(`   ${p}`);
    console.error('   Nothing was compared. This is NOT a pass.');
    return EXIT_CANNOT_CHECK;
  }

  const divergences = [];
  const declared = new Set();
  let compared = 0;

  // --- REGISTRY -> TREE, the exhaustive direction and the one that decays. ---
  for (const [i, entry] of registry.literals.entries()) {
    const missing = REQUIRED_FIELDS.filter((f) => typeof entry?.[f] !== 'string' || entry[f].trim() === '');
    if (missing.length > 0) {
      divergences.push(`entry ${i} is missing required field(s): ${missing.join(', ')}`);
      continue;
    }

    const key = `${entry.path} ${normaliseSource(entry.source)}`;
    if (declared.has(key)) divergences.push(`${entry.path}: the same source line is declared twice`);
    declared.add(key);

    const sites = found.filter((f) => f.path === entry.path && f.source === normaliseSource(entry.source));
    if (sites.length === 0) {
      divergences.push(
        `${entry.id}: no version literal in ${entry.path} now reads \`${normaliseSource(entry.source)}\`. ` +
          'Either the line changed and this entry is stale, or the literal was removed and the entry should be too.',
      );
      continue;
    }
    if (sites.length > 1) {
      // Refused rather than resolved: one entry covering several sites would
      // silently cover ones nobody examined.
      divergences.push(
        `${entry.id}: \`${normaliseSource(entry.source)}\` matches ${sites.length} sites in ${entry.path}. ` +
          'One entry addresses one site; give the lines distinguishable text or split the entry.',
      );
      continue;
    }

    // THE COMPARISON, AND ONLY AGAINST THE SOURCE THIS ENTRY NAMES.
    if (entry.mirrors === 'none') continue;

    const canonical = resolveCanonical(repoRoot, entry.mirrors);
    if (canonical.error) {
      divergences.push(`${entry.id}: declared canonical source '${entry.mirrors}' could not be read — ${canonical.error}`);
      continue;
    }
    compared += 1;
    if (sites[0].literal !== canonical.value) {
      divergences.push(
        `${entry.id}: ${entry.path} carries '${sites[0].literal}' but ${entry.mirrors} is '${canonical.value}'. ` +
          'These are hand-maintained together and must move together.',
      );
    }
  }

  // --- TREE -> REGISTRY, best-effort. A literal nobody declared. ---
  for (const site of found) {
    if (declared.has(`${site.path} ${site.source}`)) continue;
    divergences.push(
      `${site.path}: \`${site.source}\` is a version-bearing literal that is NOT declared in ${REGISTRY_REL}. ` +
        'Declare what it mirrors — or `none` with the reason, if it is not a package version.',
    );
  }

  if (divergences.length > 0) {
    console.error('check-version-literals: FAIL\n');
    for (const d of [...new Set(divergences)].sort()) console.error(`  - ${d}`);
    console.error(`\n${divergences.length} problem(s).`);
    return EXIT_DIVERGENCE;
  }

  console.log(
    `check-version-literals: OK — ${registry.literals.length} declared literal(s), ${found.length} found in the tree, ` +
      `${compared} compared against a canonical source, and they agree.`,
  );
  return EXIT_OK;
}

if (isProcessEntryPoint(import.meta.url)) {
  process.exit(main(process.argv));
}
