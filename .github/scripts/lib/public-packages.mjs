// SPDX-License-Identifier: Apache-2.0
/**
 * WHICH WORKSPACE PACKAGES ARE PUBLIC — one definition, imported (#711).
 *
 * Five files carried their own copy of this walk before this module existed:
 * `check-npx-invocations`, `check-release-registry-reconcile`,
 * `check-tarball-compliance`, `check-compatibility-contract` and
 * `check-readme-imports`. They agreed — measured, all five returned the same
 * nine names — which is exactly the state a sixth copy would have joined
 * without anyone noticing it had.
 *
 * #711 was filed because `generate-notice.mjs` cannot write the per-package
 * NOTICE copies without knowing that list, and adding it there would have made
 * six. This module is what it imports instead.
 *
 * ## What is shared, and what is deliberately NOT
 *
 * SHARED: the authority — where the packages live, and what makes one public.
 * That is `packages/<dir>/package.json` with `private !== true` and a string
 * `name`, and it is the only thing all five callers actually agreed on.
 *
 * NOT SHARED: what to do when a manifest cannot be read. The five callers hold
 * THREE different policies, and collapsing them would be a silent behaviour
 * change in a repository whose whole position is that cannot-check must never
 * become a pass:
 *
 *   fail closed   `check-npx-invocations`, `check-release-registry-reconcile`
 *                 refuse to answer at all — an empty authority set would make
 *                 every invocation look invalid, a confidently wrong answer.
 *   record it     `check-tarball-compliance` keeps the entry and reports the
 *                 package as unreadable, because it must still name the dir.
 *   skip it       `check-compatibility-contract`, `check-readme-imports`
 *                 continue without it.
 *
 * So this returns the FACTS — every entry, with its own read outcome — and each
 * caller applies its own policy in a few lines. Sharing the walk removes the
 * duplicated authority; sharing the policy would have removed a distinction
 * three of those guards depend on.
 *
 * `dir` is included because a name alone cannot locate the package, and the
 * NOTICE writer needs somewhere to write.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every package directory under `packages/`, with its manifest read.
 *
 * @param {string} repoRoot
 * @returns {{ entries: {dir: string, path: string, name: string|null, manifest: object|null, unreadable: string|null}[]|null, error: string|null }}
 *   `entries` is null ONLY when `packages/` itself could not be listed — the
 *   one condition under which no caller can say anything true. Otherwise every
 *   directory appears, carrying either a manifest or the reason it has none.
 *   Sorted by directory name so callers need not re-sort for stable output.
 */
export function enumerateWorkspacePackages(repoRoot) {
  const dir = join(repoRoot, 'packages');
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { entries: null, error: `cannot read packages/ (${err?.message ?? err})` };
  }

  const entries = [];
  for (const d of dirents.filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, d.name, 'package.json');
    // A directory with no manifest is not a package. It is skipped rather than
    // reported unreadable: nothing was there to read, so there is no failure to
    // fail closed on.
    if (!existsSync(path)) continue;
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf-8'));
      entries.push({
        dir: `packages/${d.name}`,
        path,
        name: typeof manifest.name === 'string' ? manifest.name : null,
        manifest,
        unreadable: null,
      });
    } catch (err) {
      entries.push({
        dir: `packages/${d.name}`,
        path,
        name: null,
        manifest: null,
        unreadable: String(err?.message ?? err),
      });
    }
  }
  return { entries, error: null };
}

/** Is this entry a package the workspace publishes? */
export function isPublic(entry) {
  return entry.manifest !== null && entry.manifest.private !== true && typeof entry.name === 'string';
}

/**
 * The public packages, for callers that SKIP unreadable manifests.
 *
 * Callers that must fail closed use `enumerateWorkspacePackages` directly and
 * inspect `error` and `unreadable` themselves — that policy is theirs, and
 * this helper deliberately does not make it for them.
 */
export function publicPackages(repoRoot) {
  const { entries, error } = enumerateWorkspacePackages(repoRoot);
  if (entries === null) return { packages: null, reason: error };
  return { packages: entries.filter(isPublic), reason: null };
}
