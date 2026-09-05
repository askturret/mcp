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

import { isProcessEntryPoint } from './lib/entry-point.mjs';

import { didNotStart, spawnFailureDetail } from './sdk-upgrade-drill.mjs';

const AUDIT_PREFIX = '.operum/audit/';
const SUFFIX = '.jsonl';

/**
 * What to run by hand when this guard could not run (#449).
 *
 * Named in every cannot-check message, because the difference between a
 * REFUSAL and a SHRUG is whether the reader is told what to do instead. A
 * reader who hits this should not have to decide whether the failure mattered;
 * QA hit exactly this during live review of PR #490 and did the check by hand,
 * and this is that procedure written down.
 *
 * Exported so the self-test asserts against the real string rather than a
 * transcribed copy of it — a second copy here is the Transcribed Oracle shape
 * `docs/TESTING.md` names.
 */
export const MANUAL_SUBSTITUTE =
  `Check by hand before trusting this change:\n` +
  `  git diff --numstat origin/main...HEAD -- ${AUDIT_PREFIX}   # THREE dots; expect ZERO deletions\n` +
  `  git show origin/main:<path> | wc -l                         # ...and the line count must go UP\n` +
  `\n` +
  `The three dots are load-bearing. Two-dot \`git diff origin/main\` compares main's CURRENT TIP\n` +
  `against your HEAD, not your branch's own contribution, so a file added to main AFTER your\n` +
  `branch forked renders as a phantom DELETION. Keep the line-count check too: it is immune to\n` +
  `that distinction, and proving the count went UP establishes nothing was lost.`;

/**
 * CANNOT CHECK (2) for a git that never ran.
 *
 * `didNotStart` and `spawnFailureDetail` are IMPORTED, not reimplemented (#464).
 * Keeping the condition while inlining its own detail construction is #443's
 * finding 2 exactly: `status === null` is true both when the process failed to
 * start (`error` set) and when it was killed by a signal (`error` UNDEFINED,
 * `signal` set), so a hand-rolled `result.error.message` crashes on the second
 * row — inside the branch whose whole job is to report legibly.
 */
function couldNotRunGit(what, result) {
  return {
    code: 2,
    message:
      `${what} COULD NOT RUN, so this guard did not check anything:\n` +
      `${spawnFailureDetail(result)}\n\n` +
      `This guard did not run, and "could not check" is never "it passed".\n\n` +
      `${MANUAL_SUBSTITUTE}`,
  };
}

/** A spawn's stderr, safe to read on any result shape. */
const stderrOf = (result) => (typeof result.stderr === 'string' ? result.stderr.trim() : '(none reported)');

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
  // Tested BEFORE `status !== 0`, and before anything reads `stderr`. A spawn
  // that never started has `status: null` and `stderr: null`, so the old
  // `merged.stderr.trim()` threw a TypeError from inside the fail-closed branch
  // — the guard crashed in exactly the degraded environment its message exists
  // to explain, and printed a stack trace instead of the sentence (#449).
  if (didNotStart(merged)) return couldNotRunGit('git merge-base', merged);
  if (merged.status !== 0) {
    // "I could not check" is never "it passed". A missing base ref means this
    // guard did not run, and saying so is the only honest outcome.
    return {
      code: 2,
      message:
        `Could not resolve a merge base between '${baseRef}' and HEAD:\n` +
        `${stderrOf(merged)}\n\n` +
        `This guard did not run. Fetch the base ref (Actions needs ` +
        `fetch-depth: 0) and retry — a guard that cannot check must not report ` +
        `success.\n\n` +
        `${MANUAL_SUBSTITUTE}`,
    };
  }

  const diff = git(['diff', '--numstat', `${baseRef}...HEAD`, '--', AUDIT_PREFIX], repoDir);
  if (didNotStart(diff)) return couldNotRunGit('git diff', diff);
  if (diff.status !== 0) {
    return { code: 2, message: `git diff failed:\n${stderrOf(diff)}\n\n${MANUAL_SUBSTITUTE}` };
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
 * `import.meta.url` is a percent-encoded, symlink-resolved URL; a hand-built
 * `file://${argv[1]}` is neither. argv[1] must be normalised TWO ways, and
 * missing either fails SILENTLY: the script does nothing and exits 0 — which,
 * for a guard, means reporting success without having checked anything.
 *
 *   1. **Percent-encoding** — `import.meta.url` is a URL, so a space anywhere
 *      in the path breaks a hand-built `file://${...}`.
 *   2. **Symlinks** — node reports the resolved path, so a checkout reached
 *      through a symlink mismatches unless argv[1] is realpath'd too.
 *
 * A relative INVOCATION is not a third mode, though an earlier version of this
 * comment claimed it was, and cited `node .github/scripts/x.mjs` — the way CI
 * invokes this — as the example (#184). Node resolves argv[1] to an absolute,
 * normalised path before the module runs, so that invocation compares EQUAL
 * even under the old idiom. CI was never the exposure; a space in the checkout
 * path is, and that is the likelier accident of the two.
 *
 * The same defect shipped in the gateway's CLI (#57) and was fixed alongside
 * this one. A guard that quietly no-ops is strictly worse than no guard,
 * because the green check says it ran.
 */

const invokedDirectly = isProcessEntryPoint(import.meta.url);

if (invokedDirectly) {
  const result = check(resolveBase(process.argv[2]), process.argv[3] ?? '.');
  if (result.code === 0) {
    console.log(result.message);
  } else {
    console.error(`\n${result.message}\n`);
    // The annotation is the one line that survives into the Actions summary, so
    // it must not say the opposite of the message above it. Code 2 means the
    // guard did NOT run; announcing that as "lost lines" reports a finding it
    // never made, and a reader who trusts the annotation over the body draws
    // exactly the wrong conclusion. The EXIT CODE is unchanged — both are
    // non-zero and both still fail closed (#449).
    console.error(
      result.code === 2
        ? `::error::append-only guard CANNOT CHECK — it did not run, so nothing was verified.`
        : `::error::append-only audit log lost lines.`,
    );
  }
  process.exit(result.code);
}
