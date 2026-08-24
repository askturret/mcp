#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Append-only audit logs must never lose a line (#128).
 *
 * ## What this catches that `.gitattributes` cannot
 *
 * `merge=union` fixes the MERGE: two branches appending to the same log
 * union-merge instead of presenting a "pick a side" conflict whose obvious
 * resolutions silently destroy rows.
 *
 * It does nothing about the other ways a row disappears — a hand-edit, a
 * whole-file restore from an older revision, a `git checkout <sha> -- <path>`
 * that rewinds the log, or a rebase resolved by taking one side. Those are not
 * merges, so no merge driver runs. The incident the concealment doctrine
 * records was exactly this: a whole-file restore destroyed three entries, CI
 * caught nothing, and it surfaced only because a human read a commit that had
 * been labelled unrelated.
 *
 * So this guard asserts the property directly: **a diff touching an
 * `.operum/audit/**\/*.jsonl` file adds lines and deletes none.**
 *
 * ## Why the property is checkable here and nowhere else
 *
 * An append-only log has no append-only assertion — a dropped row is
 * indistinguishable from a row that was never written, once the branch is gone.
 * The diff against the base is the ONLY moment both states exist at once. That
 * is why this lives in CI against a base ref rather than in a unit test.
 *
 * ## No override flag, deliberately
 *
 * There is no `--allow-deletions`. A genuine need to remove a row is rare
 * enough to be a conversation, and the escape hatch is editing this file —
 * which shows up in the diff and gets reviewed, the same shape the
 * network-import guard uses for its allowlist. A runtime flag would be
 * invisible in the artifact anyone later inspects.
 *
 * Usage:
 *   node .github/scripts/check-audit-append-only.mjs [baseRef] [repoDir]
 *
 * `baseRef` defaults to `origin/main`, or to `origin/$GITHUB_BASE_REF` when
 * GitHub Actions supplies one.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const AUDIT_PREFIX = '.operum/audit/';
const SUFFIX = '.jsonl';

/** Resolve the ref to diff against. */
function resolveBase(explicit) {
  if (explicit !== undefined && explicit !== '') return explicit;
  const prBase = process.env['GITHUB_BASE_REF'];
  if (prBase !== undefined && prBase !== '') return `origin/${prBase}`;
  return 'origin/main';
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' });
}

/**
 * Parse `git diff --numstat` output into audit-log entries.
 *
 * Rename detection is left ON (git's default). A pure rename reports `0 0` and
 * must not trip this guard — the content survived, which is the property being
 * protected. A rename that also drops lines still reports them, so the real
 * failure is still caught.
 */
function auditChanges(raw) {
  const changes = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const [added, deleted, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t');
    if (!path.startsWith(AUDIT_PREFIX) || !path.endsWith(SUFFIX)) continue;
    changes.push({
      path,
      // `-` means git treated the file as binary. Not a line count, and not a
      // deletion we can reason about — reported rather than silently passed.
      added: added === '-' ? null : Number(added),
      deleted: deleted === '-' ? null : Number(deleted),
    });
  }
  return changes;
}

export function check(baseRef, repoDir = '.') {
  const merged = git(['merge-base', baseRef, 'HEAD'], repoDir);
  if (merged.status !== 0) {
    // "I could not check" is never "it passed". A missing base ref means this
    // guard did not run, and saying so is the only honest outcome.
    return {
      code: 2,
      message:
        `Could not resolve a merge base between '${baseRef}' and HEAD:\n` +
        `${merged.stderr.trim()}\n\n` +
        `This guard did not run. Fetch the base ref (Actions needs ` +
        `fetch-depth: 0) and retry — a guard that cannot check must not report ` +
        `success.`,
    };
  }

  const diff = git(['diff', '--numstat', `${baseRef}...HEAD`, '--', AUDIT_PREFIX], repoDir);
  if (diff.status !== 0) {
    return { code: 2, message: `git diff failed:\n${diff.stderr.trim()}` };
  }

  const changes = auditChanges(diff.stdout);
  if (changes.length === 0) {
    return { code: 0, message: 'No audit-log changes in this diff.' };
  }

  const offenders = changes.filter((c) => c.deleted === null || c.deleted > 0);

  if (offenders.length === 0) {
    const total = changes.reduce((sum, c) => sum + (c.added ?? 0), 0);
    return {
      code: 0,
      message:
        `${String(changes.length)} audit log(s) changed, ${String(total)} row(s) added, ` +
        `0 deleted.`,
    };
  }

  const detail = offenders
    .map((c) =>
      c.deleted === null
        ? `  ${c.path} — treated as BINARY by git, so line counts are unavailable`
        : `  ${c.path} — ${String(c.deleted)} line(s) deleted, ${String(c.added ?? 0)} added`,
    )
    .join('\n');

  return {
    code: 1,
    message:
      `Lines were REMOVED from append-only audit log(s):\n\n${detail}\n\n` +
      `These files are append-only. A removed row cannot be recovered from the\n` +
      `log itself — once this branch is gone, a dropped row is indistinguishable\n` +
      `from one that was never written.\n\n` +
      `The usual causes:\n` +
      `  - a merge or rebase conflict resolved by taking ONE side rather than\n` +
      `    the union (\`.gitattributes\` sets merge=union to prevent this, but it\n` +
      `    only applies to branches that had the file checked out);\n` +
      `  - a whole-file restore from an older revision, which rewinds the log;\n` +
      `  - a hand-edit.\n\n` +
      `Recover the missing rows (both parents of the merge still have them) and\n` +
      `re-apply your own on top. If a removal is genuinely intended, that is a\n` +
      `change to this guard, so it is visible in review.`,
  };
}

/**
 * Run only when invoked directly, so the self-test can import `check`.
 *
 * argv[1] must be normalised three ways, and missing any of them fails
 * SILENTLY: the script does nothing and exits 0 — which, for a guard, means
 * reporting success without having checked anything.
 *
 *   1. **Relative** — `node .github/scripts/x.mjs` gives a relative argv[1]
 *      while `import.meta.url` is always absolute. This is how CI invokes it.
 *   2. **Percent-encoding** — `import.meta.url` is a URL, so a space anywhere
 *      in the path breaks a hand-built `file://${...}`.
 *   3. **Symlinks** — node reports the resolved path, so a checkout reached
 *      through a symlink mismatches unless argv[1] is realpath'd too.
 *
 * The same defect shipped in the gateway's CLI (#57) and is fixed there in this
 * change. A guard that quietly no-ops is strictly worse than no guard, because
 * the green check says it ran.
 */
function isProcessEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

const invokedDirectly = isProcessEntryPoint();

if (invokedDirectly) {
  const result = check(resolveBase(process.argv[2]), process.argv[3] ?? '.');
  if (result.code === 0) {
    console.log(result.message);
  } else {
    console.error(`\n${result.message}\n`);
    console.error(`::error::append-only audit log lost lines.`);
  }
  process.exit(result.code);
}
