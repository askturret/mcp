#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * CODEOWNERS rules must actually route something (#58).
 *
 * ## The two silent failures
 *
 * **A dead pattern.** `/packages/sources/openapi/` looks right — it is how
 * §12.4 writes the boundary — and matches nothing, because the directory is
 * `packages/sources-openapi/`. GitHub does not warn: the rule is simply never
 * the last match for any file, so the area has an owner on paper and no
 * reviewer in practice. Nobody notices until a PR that should have been routed
 * is not, and "no review was requested" looks like normal quiet.
 *
 * **An uncovered package.** A new package added without a CODEOWNERS line
 * falls through to the `*` catch-all. That is a safe default and a bad silence:
 * the point of §12.4's split is that adding an area is an ownership DECISION,
 * and inheriting the catch-all makes it a non-decision nobody was asked about.
 *
 * ## What this cannot check
 *
 * **Whether an owner has write access.** GitHub silently ignores a CODEOWNERS
 * entry naming a user or team that cannot review, and that permission state is
 * not visible from inside the repository. So a file can pass every check here
 * and still route nothing. Said plainly rather than left implied — this guard
 * covers the half that is checkable, and docs/ownership.md carries the rest.
 *
 * Usage: node .github/scripts/check-codeowners.mjs [repoDir]
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

/** Every tracked-ish path in the repo, repo-relative with POSIX separators. */
function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const rel = relative(root, full).split(sep).join('/');
    if (statSync(full).isDirectory()) {
      out.push(`${rel}/`);
      walk(root, full, out);
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Parse CODEOWNERS into `{ pattern, owners, line }`.
 *
 * Comments and blank lines are dropped. A rule with no owners is legal in
 * CODEOWNERS (it un-assigns a path) but is not something this repository does,
 * so it is kept and checked like any other pattern.
 */
export function parseCodeowners(text) {
  const rules = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') return;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern, owners, line: index + 1 });
  });
  return rules;
}

/**
 * Does a CODEOWNERS pattern match a path?
 *
 * CODEOWNERS uses gitignore-style patterns. Only the subset this repository
 * actually uses is implemented — a leading `/` anchoring to the root, a
 * trailing `/` meaning "this directory and everything under it", and `*` as a
 * within-segment wildcard.
 *
 * Deliberately NOT a general gitignore engine. A half-correct one would be a
 * second implementation of matching rules that could disagree with GitHub's,
 * and this guard's job is to catch a pattern that matches NOTHING — for which
 * an exact-subset matcher is sufficient and honest. If a future rule needs
 * syntax beyond the subset, this throws rather than guessing.
 */
export function matches(pattern, path) {
  if (pattern.includes('**')) {
    throw new Error(
      `check-codeowners does not implement '**' (pattern '${pattern}'). ` +
        `Extend the matcher deliberately rather than letting it guess.`,
    );
  }

  const anchored = pattern.startsWith('/');
  const body = anchored ? pattern.slice(1) : pattern;
  const dirOnly = body.endsWith('/');
  const core = dirOnly ? body.slice(0, -1) : body;

  // `*` matches within a segment, so it must not cross a '/'.
  const regexBody = core
    .split('/')
    .map((segment) =>
      segment
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('/');

  // A directory rule covers the directory and its whole subtree; a file rule
  // matches the path exactly.
  const suffix = dirOnly ? '(/.*)?/?' : '';
  const prefix = anchored ? '^' : '^(.*/)?';
  return new RegExp(`${prefix}${regexBody}${suffix}$`).test(path);
}

export function check(repoDir = '.') {
  const root = resolve(repoDir);
  const file = join(root, '.github', 'CODEOWNERS');

  if (!existsSync(file)) {
    return { code: 1, message: `No .github/CODEOWNERS. §12.4 requires one; see docs/ownership.md.` };
  }

  const rules = parseCodeowners(readFileSync(file, 'utf-8'));
  if (rules.length === 0) {
    return { code: 1, message: `.github/CODEOWNERS contains no rules.` };
  }

  const paths = walk(root);
  const problems = [];

  // 1. Every pattern must match at least one real path.
  for (const rule of rules) {
    if (rule.pattern === '*') continue; // the catch-all matches everything
    if (!paths.some((p) => matches(rule.pattern, p))) {
      problems.push(
        `  line ${String(rule.line)}: '${rule.pattern}' matches no path in the repository.\n` +
          `      A rule that matches nothing routes nothing — the area looks owned and is not.`,
      );
    }
  }

  // 2. Every package must have a rule of its own, not just the catch-all.
  const packagesDir = join(root, 'packages');
  if (existsSync(packagesDir)) {
    for (const name of readdirSync(packagesDir)) {
      if (SKIP_DIRS.has(name)) continue;
      if (!statSync(join(packagesDir, name)).isDirectory()) continue;
      const pkgPath = `packages/${name}/`;
      const owned = rules.some((r) => r.pattern !== '*' && matches(r.pattern, pkgPath));
      if (!owned) {
        problems.push(
          `  packages/${name}/ has no CODEOWNERS rule of its own.\n` +
            `      It would fall through to the '*' catch-all, which is a safe default\n` +
            `      and a silent one. Adding a package is an ownership decision — make it\n` +
            `      in .github/CODEOWNERS, and record the reasoning in docs/ownership.md.`,
        );
      }
    }
  }

  // 3. A catch-all must exist, or an unmatched file has no reviewer at all.
  if (!rules.some((r) => r.pattern === '*')) {
    problems.push(
      `  No '*' catch-all rule. Anything not matched by a specific rule would have\n` +
        `      no owner at all.`,
    );
  }

  if (problems.length > 0) {
    return {
      code: 1,
      message:
        `.github/CODEOWNERS problems:\n\n${problems.join('\n')}\n\n` +
        `Note: this guard cannot verify that the named owners have WRITE ACCESS.\n` +
        `GitHub silently ignores entries for users who do not, and that state is not\n` +
        `visible from the repository. See docs/ownership.md.`,
    };
  }

  return {
    code: 0,
    message:
      `.github/CODEOWNERS: ${String(rules.length)} rule(s), all matching real paths; every package owned.` +
      soleOwnerNote(rules),
  };
}

/**
 * The owner-set cardinality note (#330).
 *
 * ## Why this is a NOTE and never a failure
 *
 * Nothing in the repository can remedy it — a second maintainer is a hiring
 * decision, not a code change — so failing would be a permanent red that no one
 * can clear, which is how an alarm becomes something people route around. It is
 * the honest current state, not a defect.
 *
 * ## What is and is not expressible here
 *
 * The general property — "will this file gate the next PR?" — is NOT expressible.
 * It needs to know who will author that PR, and it needs the ruleset's bypass
 * list, which requires credentials CI does not have. Do not write a guard for
 * either; it would assert something it cannot know.
 *
 * The CARDINALITY of the owner set is a different question and is fully static:
 * if every rule names the same single handle, then a PR authored by that handle
 * routes to nobody, because GitHub never requests review from a PR's own author.
 * That is a theorem about this file, decidable from the file alone.
 *
 * Three properties make it the right check: decidable without the network,
 * SELF-CLEARING when a second owner is added (no one has to remember to delete
 * it), and it states the CONSEQUENCE rather than a status. #330 was filed
 * because a status word went stale without anyone touching the file; a sentence
 * that recomputes itself every run cannot.
 *
 * Note it covers ONE of the two independent reasons this file gates nothing —
 * self-authorship. The other, the author being an `always` bypass actor, is not
 * visible from here. Both must change before enforced review is real, so this
 * note disappearing is necessary and NOT sufficient. See docs/ownership.md.
 */
function soleOwnerNote(rules) {
  const owners = new Set(rules.flatMap((r) => r.owners));
  if (owners.size !== 1) return '';
  const [only] = [...owners];
  return (
    `\n\nNote: all ${String(rules.length)} rules name a single owner (${only}). GitHub does not\n` +
    `request review from a PR's own author, so a PR authored by that account routes to\n` +
    `no reviewer. This note disappears when a second distinct owner is added. It covers\n` +
    `only self-authorship — the bypass-actor half is not visible from the repository.\n` +
    `See docs/ownership.md.`
  );
}

function isProcessEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isProcessEntryPoint()) {
  const result = check(process.argv[2] ?? '.');
  if (result.code === 0) {
    console.log(result.message);
  } else {
    console.error(`\n${result.message}\n`);
    console.error(`::error::CODEOWNERS does not route what it claims to.`);
  }
  process.exit(result.code);
}
