#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Every `npx @askturret/<pkg>` names a package this workspace publishes (#738/#755).
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 *
 * `@askturret/mcp` does not exist. It returns 404 from the registry, it is not a
 * workspace package, and it never has been. It was nonetheless named in **33
 * places** across 10 files — including the shipped CLI's own `--help` output, so
 * a user who correctly ran `npx @askturret/mcp-cli doctor` was told BY THE
 * WORKING TOOL to use a package that does not exist. That is worse than a broken
 * doc, because it arrives from the thing that just worked.
 *
 * Nothing caught it. A 404 is invisible to every check in this repository: the
 * string is well-formed, the docs build, the tests pass, and the only way to
 * discover it is for a human to run the command.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS DERIVED, AND WHY IT NEEDS NO NETWORK
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation asks the registry. That is the wrong instrument
 * here, and this repository has already ruled on the shape: a networked check on
 * the PR path has no good failure mode — cannot-read as failure reddens every PR
 * during a registry outage, cannot-read as pass is the silent-pass this project
 * spends its time removing (see check-release-registry-reconcile.mjs, which is
 * deliberately a SCHEDULED observer for exactly that reason).
 *
 * So the authority is LOCAL: the non-private packages in each
 * `packages/<name>/package.json`.
 * That set cannot drift from what the workspace publishes, because it IS what the
 * workspace publishes — the same reasoning as `discoverPublicPackages()` in the
 * reconciler. `@askturret/mcp` is not among them, which is the whole finding.
 *
 * It runs offline, on every PR, and cannot be reddened by anyone else's outage.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STILL VERIFIED BY NOTHING: INSTALL, AND EXECUTE (#766)
 * ---------------------------------------------------------------------------
 *
 * The section above names a SCHEDULED OBSERVER as where the networked question
 * gets answered. It is easy to finish that paragraph believing the registry
 * side is therefore covered. IT IS NOT — and this block is here so that a
 * reader of this guard learns it FROM the guard, rather than from a closed
 * issue.
 *
 * `check-release-registry-reconcile.mjs` asks whether a version is PRESENT: one
 * metadata GET per package against the registry. It never runs an install, and
 * it never executes what an install would produce. Neither does anything else
 * in this repository. What each check actually proves:
 *
 *     an invocation names a package this workspace publishes  ->  this guard
 *     a released version is PRESENT on the registry           ->  the reconciler
 *     the README's inlined spec SERVES once mounted           ->  the quick-start guards
 *     the documented install SUCCEEDS, and the result RUNS    ->  NOTHING
 *
 * The last row is the residual, and #766 retires WITHOUT it being built. This
 * paragraph IS that record. A residual whose only home is a merged pull-request
 * body is one no future reader ever meets — which is the failure #766 was filed
 * about, one level up.
 *
 * It is not speculative. QA observed on 2026-09-08 that the CLI PUBLISHED to
 * the registry prints a different policy-summary wording from the one
 * `README.md` documents, under the SAME version string, because a rename merged
 * without a version bump. The workspace half of that is verified here: the
 * renderer and both READMEs agree with each OTHER, so the divergence is
 * reachable ONLY by installing from the registry and running it. The renderer's
 * own test asserts against the workspace copy, so it is green and structurally
 * cannot see this.
 *
 * The missing check is install-and-execute. Its open question is CADENCE rather
 * than mechanism: it cannot sit on the PR path, for the same reason the
 * reconciler does not, so it belongs with whoever next touches the release
 * schedule.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CHECKS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * It checks INVOCATIONS — `npx`, `npm install`, `npm i`, `yarn add`, `pnpm add`
 * followed by an `@askturret/…` specifier. That is the form that tells a reader
 * to go and fetch something, so it is the form where a non-existent name costs
 * someone real time.
 *
 * It deliberately does NOT check bare mentions. `@askturret/mcp-core` appears
 * hundreds of times as an import specifier, a workspace dependency and prose, and
 * an import of a first-party package is a different claim from "go install this".
 * Widening to bare mentions would flag `package-lock.json` and every import in
 * the tree, which is how a guard becomes something people switch off.
 *
 * A version suffix is tolerated and ignored: `npx @askturret/mcp-cli@0.1.2` names
 * `@askturret/mcp-cli`.
 *
 * ---------------------------------------------------------------------------
 * CANNOT-CHECK IS EXIT 2 AND IS NEVER A PASS
 * ---------------------------------------------------------------------------
 *
 * If `packages/` cannot be read, or yields no public package, the authority set
 * is empty — and an empty authority set makes EVERY invocation look invalid,
 * which would be a confidently wrong answer rather than no answer. If no file is
 * scanned at all, the pass would be vacuous. Both exit 2.
 *
 * Run: node .github/scripts/check-npx-invocations.mjs [repoRoot]
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

export const EXIT_OK = 0;
export const EXIT_UNKNOWN_PACKAGE = 1;
export const EXIT_CANNOT_CHECK = 2;

/** Directories that never contain authored text. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build', '.turbo']);

/** File types where an invocation can be written for a human to copy. */
const TEXT_EXTENSIONS = ['.md', '.ts', '.tsx', '.mjs', '.cjs', '.js', '.yml', '.yaml', '.txt'];

/**
 * An install-or-run invocation naming an `@askturret/…` specifier.
 *
 * Flags between the command and the specifier are tolerated (`npx --yes …`),
 * because a reader copies the whole line and the flag does not change which
 * package is named.
 *
 * ## Other PACKAGES between the command and ours are tolerated too (#766)
 *
 * This used to skip only flags, so the specifier had to be the FIRST argument.
 * A co-installed dependency ahead of it — `npm install express @askturret/…` —
 * ended the match, and the invocation was not found at all. Not mis-checked:
 * INVISIBLE, which is the worse failure, because an unfound invocation is
 * indistinguishable from a file with no invocations in it.
 *
 * That is not a hypothetical shape. It is `README.md`'s primary quick-start
 * install line, and it was the ONLY line in the repository the old pattern
 * missed. Measured on the PRE-CHANGE tree (`origin/main` at 13684c6): 61 lines
 * issue one of these commands and name an `@askturret` package; the old pattern
 * matched 60 of them; this one matches all 61. Exactly one line gained —
 * `README.md:21` — and no remainder.
 *
 * MEASURE THIS AGAINST THE PRE-CHANGE TREE, which is what those figures are.
 * Counting on the post-change tree gives a larger number, because the examples
 * written in THIS comment are themselves lines containing a command and an
 * `@askturret` specifier, and the scan reads `.mjs` files including this one.
 * That is how the figures first committed here came to be one too high.
 *
 * So the most-read install line in the project was the one line this guard
 * could not see, and a mutation replacing its package with a name that does not
 * exist passed this guard, `check-readme-imports`, `check-doc-surfaces` and
 * `check-markdown-links` — all four at exit 0.
 *
 * ## Why the skip is an enumerated token run rather than `.*`
 *
 * `.*` would let any text on the line separate the command from the specifier,
 * so `npm install foo && echo @askturret/whatever` would report a package that
 * is not being installed at all. The skip therefore admits only things that can
 * be an ARGUMENT — a flag, or a bare package name — and stops at the first
 * token that is neither. `@`-prefixed text cannot be consumed by the skip, so
 * the specifier itself can never be swallowed by it.
 *
 * ## The captured name must TERMINATE, not merely begin correctly (#759)
 *
 * The capture used to be `[a-z0-9][a-z0-9-]*`, which excludes `_` and `.` —
 * both LEGAL npm name characters. So it truncated at the first one, and the
 * exemption lookup below is an EXACT `Object.hasOwn`, which then matched the
 * TRUNCATED name. `@askturret/mcp-adapter-test_v2` captured as
 * `@askturret/mcp-adapter-test`, an exempt entry, and was SUPPRESSED — a
 * package inheriting an exemption by merely starting with an exempt name.
 *
 * NOTHING WAS EVER PREFIX-MATCHED ON PURPOSE. Both lookups — the exemption and
 * the published-package set — are exact. The prefix behaviour came entirely
 * from the capture stopping early, so widening the capture cannot break an
 * intended prefix semantic; there was never one to break.
 *
 * WHY THE CLASS IS NOT SIMPLY WIDENED TO INCLUDE `.`. A sentence-ending period
 * is the overwhelmingly common neighbour of a package name in prose, so
 * `[a-z0-9._-]*` captures `@askturret/mcp-cli.` from "…run `npx
 * @askturret/mcp-cli`." and reports a package that does not exist — trading a
 * silent suppression for a noisy false accusation on correct documents, which
 * is how a guard becomes something people switch off.
 *
 * So the name may CONTAIN `.`, `_` and `-`, and may END with anything except a
 * dot. That is the npm grammar's shape and it separates the two cases exactly:
 * a dotted package name is captured whole, a trailing sentence period is not.
 * Note it deliberately still ends on `_`, so `mcp-adapter-test_` is captured
 * whole and flagged rather than truncating back onto the exemption.
 *
 * THE RESIDUAL, stated rather than implied: a name ENDING in a dot would still
 * truncate and could still inherit an exemption. That is not a plausible npm
 * name, and closing it is what would reintroduce the prose false-positive
 * above, so it is accepted knowingly rather than overlooked.
 *
 * MEASURED before and after on the real tree: 61 invocations both ways, zero
 * differences. This is the status quo for every line that exists today; it
 * changes only the hazard cases, which are LATENT — no `@askturret` invocation
 * in the tree is followed by `_` or `.`.
 */
const INVOCATION =
  /\b(?:npx|npm\s+install|npm\s+i|yarn\s+add|pnpm\s+add)(?:\s+(?:--?[A-Za-z][\w-]*|[a-z0-9][\w.-]*))*\s+(@askturret\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?)/g;

/**
 * Specifiers that are UNPUBLISHED ON PURPOSE, each with a reason and the issue
 * that will retire it.
 *
 * NAMED ENTRIES, NEVER A PATTERN — the same shape as
 * `.github/release-registry-baseline.json` and for the same argument: a wildcard
 * or an "ignore anything private" rule would silence the next occurrence too,
 * and the next occurrence is the case this guard exists to catch.
 *
 * `@askturret/mcp-adapter-test` is `private: true` in the workspace and 404s on
 * the registry, so the 9 invocations of it in `docs/adapters.md`,
 * `docs/ownership.md`, `docs/releasing.md` and `packages/adapter-test/src/cli.ts`
 * ARE the same user-facing defect as #738 — a doc telling a reader to fetch
 * something that is not there.
 *
 * It is exempt rather than fixed because THE REMEDY IS DIFFERENT AND IS NOT
 * MINE. `@askturret/mcp` was a name that never existed and never will, so the
 * repair is to name the package that does. This one is intended to ship and is
 * parked on #173 (release policy plus credentials — a founder decision). There
 * is no correct alternative name to write, and inventing one would be a
 * confidently wrong command, which is worse than the 404 it replaces.
 *
 * EVERY ENTRY IS PRINTED ON EVERY RUN, pass or fail, so the suppression is
 * visible rather than silent. When #173 publishes the package it leaves this set
 * by itself: `publishedPackages()` will contain it, and the guard's own output
 * will show a stale exemption for anyone to remove.
 */
export const DECLARED_UNPUBLISHED = Object.freeze({
  '@askturret/mcp-adapter-test': {
    reason: 'private:true in the workspace; intended to ship, parked on release policy + credentials',
    issue: '#173',
    declared: '2026-09-07',
  },
});

/**
 * The packages this workspace actually publishes.
 *
 * Derived from the manifests rather than listed here: a hardcoded set is the
 * tally this repository keeps having to remove, and it would go wrong silently
 * the day a tenth package ships.
 */
export function publishedPackages(rootDir) {
  const dir = join(rootDir, 'packages');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (err) {
    return { packages: null, reason: `cannot read packages/ (${err?.message ?? err})` };
  }

  const packages = new Set();
  for (const d of entries) {
    const manifest = join(dir, d.name, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf-8'));
      if (pkg.private !== true && typeof pkg.name === 'string') packages.add(pkg.name);
    } catch (err) {
      return { packages: null, reason: `cannot parse ${d.name}/package.json (${err?.message ?? err})` };
    }
  }

  if (packages.size === 0) {
    // The vacuity guard. An empty authority set would make every invocation
    // look invalid — a confidently wrong answer, not an absent one.
    return { packages: null, reason: 'no public workspace packages were discovered, so nothing could be compared' };
  }
  return { packages };
}

/** Authored text files under `rootDir`, recursively. */
export function textFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (TEXT_EXTENSIONS.some((ext) => e.name.endsWith(ext))) {
        try {
          if (statSync(full).isFile()) out.push(full);
        } catch {
          /* raced away; not ours to report */
        }
      }
    }
  };
  walk(rootDir);
  return out.sort();
}

/** Every invocation in `source`, as `{ spec, line }`. */
export function invocationsIn(source) {
  const found = [];
  const lines = source.split('\n');
  lines.forEach((text, i) => {
    for (const m of text.matchAll(INVOCATION)) found.push({ spec: m[1], line: i + 1 });
  });
  return found;
}

export function check(rootDir) {
  const { packages, reason } = publishedPackages(rootDir);
  if (packages === null) return { cannotCheck: reason, violations: [], scanned: 0, packages: null };

  const files = textFiles(rootDir);
  if (files.length === 0) {
    return { cannotCheck: `no text files found under ${rootDir}`, violations: [], scanned: 0, packages };
  }

  const violations = [];
  const suppressed = [];
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const { spec, line } of invocationsIn(source)) {
      if (packages.has(spec)) continue;
      const where = { file: relative(rootDir, file), line, spec };
      if (Object.hasOwn(DECLARED_UNPUBLISHED, spec)) suppressed.push(where);
      else violations.push(where);
    }
  }

  // A declared entry that is now published, or that nothing references any more,
  // is a claim that has become false. Reporting it is what keeps the exemption
  // set from outliving its reason unread (#428's stale-exemption lesson).
  const staleExemptions = Object.keys(DECLARED_UNPUBLISHED)
    .filter((spec) => packages.has(spec) || !suppressed.some((s) => s.spec === spec))
    .sort();

  return { cannotCheck: null, violations, suppressed, staleExemptions, scanned: files.length, packages };
}

function main(argv) {
  const root = resolve(argv[2] ?? '.');
  const { cannotCheck, violations, suppressed, staleExemptions, scanned, packages } = check(root);

  if (cannotCheck !== null) {
    console.error(`::error::CANNOT CHECK — ${cannotCheck}`);
    console.error('  The set of published packages is the authority this check compares against.');
    console.error('  Without it nothing was verified. This is NOT a pass.');
    return EXIT_CANNOT_CHECK;
  }

  // Printed on EVERY run, pass or fail. A suppression nobody sees is a
  // suppression nobody removes.
  for (const spec of Object.keys(DECLARED_UNPUBLISHED).sort()) {
    const d = DECLARED_UNPUBLISHED[spec];
    const hits = suppressed.filter((s) => s.spec === spec).length;
    console.log(`  declared-unpublished: ${spec} — ${hits} invocation(s) suppressed; ${d.reason} (${d.issue}, ${d.declared})`);
  }
  for (const spec of staleExemptions) {
    console.log(`  NOTE: the exemption for ${spec} is STALE — it is published, or nothing invokes it. Remove it.`);
  }

  if (violations.length > 0) {
    console.error('❌ An invocation names an @askturret package this workspace does not publish:');
    for (const v of violations) console.error(`   ${v.file}:${v.line}  ${v.spec}`);
    console.error('');
    console.error(`   Published packages (derived from packages/*/package.json):`);
    for (const p of [...packages].sort()) console.error(`     ${p}`);
    console.error('');
    console.error('   A reader COPIES these lines. A name that is not published 404s at the');
    console.error('   registry, which costs someone real time and tells them nothing useful.');
    console.error('   The CLI ships as `@askturret/mcp-cli` — its bin is `turret`.');
    console.error('');
    console.error(`::error::${violations.length} invocation(s) name an unpublished package.`);
    return EXIT_UNKNOWN_PACKAGE;
  }

  console.log(
    `check-npx-invocations: OK — every @askturret invocation across ${scanned} file(s) names one of ` +
      `${packages.size} published workspace package(s). Bare mentions and imports are out of scope.`,
  );
  return EXIT_OK;
}

// Runs unconditionally; the self-test spawns this file rather than importing it.
// An `import.meta.url === file://argv[1]` entry guard is false on any checkout
// path containing a space, so main() would never run and the process would exit
// 0 having checked nothing — observed on this repository, documented at the foot
// of check-workflows-parse.mjs.
process.exit(main(process.argv));
