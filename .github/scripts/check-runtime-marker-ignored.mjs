#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Agent-runtime markers stay ignored by git (#227).
 *
 * The harness writes `.operum-stash-recovery` into the repository root. It is
 * runtime state, never repository content. While UNTRACKED it makes the
 * worktree dirty, and `git_merge` correctly refuses to merge into a dirty
 * worktree — so the marker is what must change, not the guard.
 *
 * ## Why this is worth a CI guard rather than trusting the .gitignore line
 *
 * The entry is invisible until it bites, and when it bites the failure does
 * not look like "a .gitignore line went missing". It looks like a fast-forward
 * being refused, which is easy to misread as a merge-tooling problem — and the
 * agent home branches (`agent/*`) exist solely to track `main` by fast-forward,
 * so they are exactly what stops working.
 *
 * That failure has a nasty property: it is SELF-SEALING. A home branch pinned
 * at a commit older than the .gitignore entry does not contain the entry, so
 * on that branch the marker is untracked, so the fast-forward is refused — and
 * the fast-forward was the only way to acquire the entry. Observed on 2026-08-25:
 * `agent/engineer` sat at `ea961ea` across three merged PRs before anyone
 * noticed, and it could not heal itself. Recovery needs a manual
 * `git reset --hard origin/main`, which no routine step performs.
 *
 * The entry itself arrived as an incidental third commit inside an unrelated
 * metrics PR (#231). Lines that arrive that way are precisely the ones a later
 * tidy-up of .gitignore removes without realising what they were load-bearing
 * for.
 *
 * ## Why `git check-ignore` rather than grepping .gitignore
 *
 * A literal line match would pass a file that a LATER negation un-ignores
 * (`!.operum-stash-recovery`), and would fail a correct entry written as a
 * broader pattern. Asking git resolves the real precedence rules instead of
 * re-implementing them — the "transcribed oracle" antipattern this repo names
 * in docs/TESTING.md.
 *
 * Exit codes:
 *   0 - every marker is ignored
 *   1 - at least one marker is NOT ignored
 *   2 - the check could not be performed (not a git repo, git missing)
 *
 * Exit 2 is a FAILURE, not a pass. "I could not check" must never read as
 * "it passed" — the rule this repository applies everywhere else.
 *
 * Run: node .github/scripts/check-runtime-marker-ignored.mjs [root]
 */

import { spawnSync } from 'node:child_process';

/**
 * Paths the agent harness writes into the repo root.
 *
 * Add to this list rather than widening it to a glob: each entry is a specific
 * file we have seen written, and a broad `.operum*` pattern would also swallow
 * `.operum/knowledge/`, which IS repository content and must stay tracked.
 */
const MARKERS = ['.operum-stash-recovery'];

const root = process.argv[2] ?? '.';

function isIgnored(path) {
  const result = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', path], {
    encoding: 'utf8',
  });

  if (result.error) return { ok: false, fatal: `git could not be run: ${result.error.message}` };
  // 0 = ignored, 1 = not ignored, anything else (128) = git could not answer.
  if (result.status === 0) return { ok: true };
  if (result.status === 1) return { ok: false };
  return {
    ok: false,
    fatal: `git check-ignore exited ${result.status}: ${(result.stderr || '').trim()}`,
  };
}

const notIgnored = [];

for (const marker of MARKERS) {
  const verdict = isIgnored(marker);
  if (verdict.fatal) {
    console.error(`ERROR: cannot verify ignore rules under "${root}" — ${verdict.fatal}`);
    console.error('Refusing to report success: an unverifiable guard is not a passing guard.');
    process.exit(2);
  }
  if (!verdict.ok) notIgnored.push(marker);
}

if (notIgnored.length > 0) {
  console.error('Agent-runtime marker(s) are NOT ignored by git:\n');
  for (const marker of notIgnored) console.error(`  ${marker}`);
  console.error(
    [
      '',
      'These files are written into the repo root by the agent harness. Left',
      'untracked they make the worktree dirty, which causes git_merge to refuse',
      'a fast-forward — and the agent/* home branches exist only to fast-forward',
      'onto main, so they silently stop tracking it.',
      '',
      'Remedy: restore the entry in the root .gitignore, e.g.',
      '',
      '  .operum-stash-recovery',
      '',
      'Check for a later negation (!.operum-stash-recovery) too — a negation',
      'further down the file un-ignores it just as effectively as a deletion.',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`Agent-runtime markers ignored: ${MARKERS.join(', ')} (${MARKERS.length} checked)`);
