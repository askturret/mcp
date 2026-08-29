#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the two mechanisms protecting append-only audit logs (#128).
 *
 *   1. `.gitattributes` — `merge=union`, so two branches appending distinct
 *      rows to the same log merge cleanly with BOTH rows present. This is the
 *      verification #128's acceptance asks for.
 *
 *   2. `check-audit-append-only.mjs` — the guard covering what a merge driver
 *      cannot: a hand-edit, a whole-file restore, a conflict resolved by
 *      taking one side.
 *
 * ## These run real git, against the repo's real .gitattributes
 *
 * The union test COPIES this repository's actual `.gitattributes` into a
 * throwaway repo. Writing the attribute line inline would have tested a copy —
 * it would pass while the real file said something else, or nothing at all,
 * which is precisely the state #128 was filed about.
 *
 * ## The control case is the point
 *
 * Asserting "the merge succeeded" proves nothing on its own: git might have
 * merged cleanly anyway. So the same scenario runs a second time in a repo with
 * NO `.gitattributes`, and that one must CONFLICT. Together they show the clean
 * merge is caused by the attribute rather than coincident with it.
 *
 * Run: node .github/scripts/check-audit-append-only.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { check, MANUAL_SUBSTITUTE } from './check-audit-append-only.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-audit-append-only.mjs');
/** A directory that does not exist, used as a PATH with no `git` on it. */
const NO_GIT_PATH = join(tmpdir(), 'operum-there-is-no-git-here');
const repoRoot = resolve(here, '../..');
const REAL_GITATTRIBUTES = join(repoRoot, '.gitattributes');
const LOG = '.operum/audit/protected-file-events.jsonl';

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check_(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed++;
  }
}

/**
 * Run git with the ambient environment neutralised.
 *
 * A developer's global `core.attributesFile` or a system gitattributes could
 * otherwise supply the very driver under test, and the suite would pass on a
 * machine that happened to be configured for it while CI failed. Isolating the
 * config is what makes the result about THIS repository's file.
 */
function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'audit-merge-'));
  tmpDirs.push(dir);
  git(['init', '-q', '-b', 'main'], dir);
  mkdirSync(join(dir, '.operum', 'audit'), { recursive: true });
  return dir;
}

function writeLog(dir, rows) {
  writeFileSync(join(dir, LOG), rows.map((r) => `${r}\n`).join(''));
}

function readLog(dir) {
  return readFileSync(join(dir, LOG), 'utf-8');
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  const r = git(['commit', '-q', '-m', message], dir);
  if (r.status !== 0) throw new Error(`commit failed: ${r.stderr}`);
}

const BASE = ['{"ts":"2026-01-01T00:00:00Z","result":"base-1"}', '{"ts":"2026-01-01T00:00:01Z","result":"base-2"}'];
const ROW_A = '{"ts":"2026-01-02T00:00:00Z","branch":"branch-a","result":"path-restore"}';
const ROW_B = '{"ts":"2026-01-02T00:00:05Z","branch":"branch-b","result":"path-restore"}';

/**
 * Two branches append one distinct row each to the same log, then merge.
 *
 * @param withAttributes - copy the repo's real `.gitattributes` in, or not.
 * @returns the merge exit status and the resulting file contents.
 */
function twoBranchAppendMerge(withAttributes) {
  const dir = scratchRepo();

  if (withAttributes) {
    copyFileSync(REAL_GITATTRIBUTES, join(dir, '.gitattributes'));
  }
  writeLog(dir, BASE);
  commitAll(dir, 'base');

  git(['checkout', '-q', '-b', 'branch-a'], dir);
  writeLog(dir, [...BASE, ROW_A]);
  commitAll(dir, 'branch-a appends its row');

  git(['checkout', '-q', 'main'], dir);
  git(['checkout', '-q', '-b', 'branch-b'], dir);
  writeLog(dir, [...BASE, ROW_B]);
  commitAll(dir, 'branch-b appends its row');

  git(['checkout', '-q', 'branch-a'], dir);
  const merge = git(['merge', '--no-edit', 'branch-b'], dir);

  return { dir, status: merge.status, contents: readLog(dir) };
}

// ---------------------------------------------------------------------------
// 1. The acceptance criterion: union merge, no manual resolution
// ---------------------------------------------------------------------------

console.log('\n# .gitattributes merge=union\n');

const HAS_GITATTRIBUTES = existsSync(REAL_GITATTRIBUTES);

check_('the repository actually has a .gitattributes', HAS_GITATTRIBUTES, true);

// Everything below reads that file. Without this gate a missing .gitattributes
// crashes the run with a stack trace from `copyFileSync` instead of reporting
// the one failure that explains it — and a suite that dies is harder to read
// than a suite that says which assertion failed and why.
if (!HAS_GITATTRIBUTES) {
  console.log('\nFAIL - .gitattributes is missing; the union-merge checks cannot run.');
  console.log(`\n${String(passed)} passed, ${String(failed + 1)} failed\n`);
  process.exit(1);
}

{
  const real = readFileSync(REAL_GITATTRIBUTES, 'utf-8');
  // Asserted as a literal because #128's acceptance names this exact pattern.
  check_(
    'it declares merge=union for .operum/audit/*.jsonl',
    /^\.operum\/audit\/\*\.jsonl\s+merge=union$/m.test(real),
    true,
  );
  check_(
    'and for the one-file-per-entry captures in subdirectories',
    /^\.operum\/audit\/\*\*\/\*\.jsonl\s+merge=union$/m.test(real),
    true,
  );
}

{
  const { status, contents } = twoBranchAppendMerge(true);

  check_('two branches appending distinct rows merge with no conflict', status, 0);
  check_('branch A’s row survives', contents.includes(ROW_A), true);
  check_('branch B’s row survives', contents.includes(ROW_B), true);
  check_('the base rows survive', BASE.every((r) => contents.includes(r)), true);
  check_('no conflict markers are left in the file', /^(<{7}|={7}|>{7})/m.test(contents), false);
  // Union keeps both sides' lines and nothing else. A count guards against a
  // driver that duplicated the base rows while appearing to work.
  check_(
    'exactly base + A + B lines, no duplicates',
    contents.trim().split('\n').length,
    BASE.length + 2,
  );
  check_('every line is still valid JSON', contents.trim().split('\n').every((l) => {
    try { JSON.parse(l); return true; } catch { return false; }
  }), true);
}

{
  // The control. Without the attribute this MUST conflict — otherwise the clean
  // merge above says nothing about whether .gitattributes did anything.
  const { status, contents } = twoBranchAppendMerge(false);

  check_('CONTROL: without .gitattributes the same merge conflicts', status !== 0, true);
  check_('CONTROL: and leaves conflict markers a resolver must decide', /^<{7}/m.test(contents), true);
}

// ---------------------------------------------------------------------------
// 2. The guard: no audit line may be deleted
// ---------------------------------------------------------------------------

console.log('\n# check-audit-append-only guard\n');

/** A repo with a committed base log and a `base` ref to diff against. */
function guardRepo() {
  const dir = scratchRepo();
  writeLog(dir, BASE);
  commitAll(dir, 'base');
  git(['branch', 'base'], dir);
  return dir;
}

{
  const dir = guardRepo();
  writeLog(dir, [...BASE, ROW_A]);
  commitAll(dir, 'append a row');

  check_('passes when a row is appended', check('base', dir).code, 0);
}

{
  const dir = guardRepo();
  // A whole-file restore to an earlier state — the #5911 shape, and the one a
  // merge driver cannot see because no merge happens.
  writeLog(dir, [BASE[0]]);
  commitAll(dir, 'restore an older copy of the log');

  check_('FAILS when a row is removed by a whole-file restore', check('base', dir).code, 1);
  check_(
    'and names the file that lost lines',
    check('base', dir).message.includes(LOG),
    true,
  );
}

{
  const dir = guardRepo();
  // The dangerous resolution: taking one side of a conflict. Modelled directly
  // as "my row replaced theirs", which is what --ours/--theirs produces.
  writeLog(dir, [...BASE.slice(0, 1), ROW_A]);
  commitAll(dir, 'resolve by taking one side');

  check_('FAILS when a conflict is resolved by dropping the other side', check('base', dir).code, 1);
}

{
  const dir = guardRepo();
  git(['rm', '-q', LOG], dir);
  commitAll(dir, 'delete the log outright');

  check_('FAILS when the log is deleted outright', check('base', dir).code, 1);
}

{
  const dir = guardRepo();
  writeFileSync(join(dir, 'README.md'), 'unrelated\n');
  commitAll(dir, 'an unrelated change');

  // The guard must not cry wolf, or it gets ignored.
  check_('passes on a diff that touches no audit log', check('base', dir).code, 0);
}

{
  const dir = guardRepo();
  mkdirSync(join(dir, '.operum', 'audit', 'concealment-reminders'), { recursive: true });
  writeFileSync(
    join(dir, '.operum/audit/concealment-reminders/20260101T000000Z-engineer-1.jsonl'),
    '{"ts":"2026-01-01T00:00:00Z","agent":"engineer"}\n',
  );
  commitAll(dir, 'add a one-file-per-entry capture');

  check_('passes when a new per-entry capture is added in a subdirectory', check('base', dir).code, 0);
}

{
  const dir = guardRepo();
  const capture = '.operum/audit/concealment-reminders/20260101T000000Z-engineer-1.jsonl';
  mkdirSync(join(dir, '.operum', 'audit', 'concealment-reminders'), { recursive: true });
  writeFileSync(join(dir, capture), '{"a":1}\n{"b":2}\n');
  commitAll(dir, 'add a capture with two rows');
  git(['branch', '-f', 'base', 'HEAD'], dir);
  writeFileSync(join(dir, capture), '{"a":1}\n');
  commitAll(dir, 'truncate the capture');

  // The subdirectory is covered by the guard too, not just by .gitattributes.
  check_('FAILS when a subdirectory capture loses a row', check('base', dir).code, 1);
}

{
  const dir = guardRepo();
  // A ref that does not exist. The guard must say it could not check rather
  // than exit 0 — "I could not check" is never "it passed".
  const result = check('no-such-ref', dir);

  check_('exits 2 — not 0 — when the base ref cannot be resolved', result.code, 2);
  check_('and says the guard did not run', result.message.includes('did not run'), true);

  // A refusal that does not say what to run instead is a shrug. QA hit this
  // branch during live review of PR #490 and did the check by hand; this is
  // that procedure, carried by the message rather than by whoever remembers it.
  check_('...and names the manual substitute', result.message.includes(MANUAL_SUBSTITUTE), true);
}

// ---------------------------------------------------------------------------
// git that never RAN — the crash inside the fail-closed branch (#449)
//
// NOT the same case as the unresolvable ref above, and the distinction is the
// whole defect. An unresolvable ref means git RAN and exited non-zero, so
// `stderr` is a string and the message rendered fine — which is why the test
// above has always passed. A git that never STARTS has `status: null` and
// `stderr: null`, so `merged.stderr.trim()` threw a TypeError from inside the
// branch whose entire job is to report legibly.
//
// This is the #429 environment, not a shallow clone: a space-separated PATH
// leaves `git` unresolvable in an ordinary agent worktree, which is where QA
// met it.
// ---------------------------------------------------------------------------
{
  const dir = guardRepo();
  const realPath = process.env['PATH'];
  let result;
  try {
    process.env['PATH'] = NO_GIT_PATH;
    result = check('base', dir);
  } finally {
    process.env['PATH'] = realPath;
  }

  check_('a git that never RAN exits 2', result.code, 2);
  // The regression proper: the old code threw before it could return anything.
  check_('...and returns a message rather than throwing', typeof result.message, 'string');
  check_('...and names the spawn cause instead of swallowing it', /ENOENT/.test(result.message), true);
  check_('...and says it did not run', result.message.includes('did not run'), true);
  check_('...and names the manual substitute', result.message.includes(MANUAL_SUBSTITUTE), true);
}

// The same case through the SHIPPED entry point, because the defect was only
// ever visible there: a stack trace on stderr and exit 1 from an uncaught
// throw, rather than the sentence and exit 2.
{
  const dir = guardRepo();
  const r = spawnSync(process.execPath, [GUARD, 'base', dir], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: NO_GIT_PATH },
  });
  const out = `${r.stdout}${r.stderr}`;

  check_('the CLI exits 2, not 1 from an uncaught throw', r.status, 2);
  check_('...and prints no stack trace', /TypeError|at ModuleJob/.test(out), false);
  check_('...and prints the intended sentence', out.includes('did not run'), true);

  // The annotation is the line that reaches the Actions summary. Announcing a
  // guard that never ran as "lost lines" reports a finding it never made.
  check_('...and the annotation says CANNOT CHECK', /CANNOT CHECK/.test(out), true);
  check_('...rather than claiming lost lines', /lost lines/.test(out), false);
}

// ---------------------------------------------------------------------------
// #443 finding 2, asserted against the production source
//
// Read from source rather than executed, and the reason is specific: the
// CONDITION-ONLY variant — `didNotStart` kept, `spawnFailureDetail` replaced by
// an inline `result.error.message` — leaves every behavioural assertion above
// GREEN. A spawn that failed to START has `error` set, so the inline form works
// on exactly the rows tested here. It breaks only on the signal-killed row
// (`status: null`, `error` UNDEFINED, `signal` set), which cannot be produced
// on demand from a self-test.
//
// `spawnFailureDetail` is tested directly, including that row, in
// `sdk-upgrade-drill.test.mjs`. What that CANNOT see is whether this file still
// calls it — so the shared helper is tested there and its use is pinned here.
// ---------------------------------------------------------------------------
{
  // COMMENTS ARE STRIPPED FIRST, and that is load-bearing rather than tidy.
  // Both absence assertions below FAILED on their first run — matching the
  // prose in this guard's own docstrings, which name the two forms precisely
  // in order to warn against them. A scan window that includes its own
  // documentation is the Decorative Guard shape `docs/TESTING.md` names: it
  // would go red for a comment and stay green for a real call site that a
  // comment happened to mention.
  const source = readFileSync(GUARD, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  check_(
    'the guard imports the shared failure-detail helper rather than re-deriving it',
    /import \{[^}]*spawnFailureDetail[^}]*\} from '\.\/sdk-upgrade-drill\.mjs'/.test(source),
    true,
  );
  check_('...and uses it', /spawnFailureDetail\(/.test(source), true);

  // The inlined form this replaced. Its absence is the assertion: a call site
  // reaching for `.error.message` has kept the condition and dropped the
  // defence, which is the shape that dereferences `undefined` on a SIGKILL.
  check_('...and never dereferences `.error.message` directly', /\.error\.message/.test(source), false);

  // `stderr` is absent on a never-started spawn and a string otherwise, so a
  // SPAWN RESULT may never be read directly — that was this issue's crash.
  // Targeted at the named results rather than at `.stderr.trim()` in general:
  // the `stderrOf` helper contains exactly that text and is CORRECT, because it
  // type-checks first. Asserting on the bare form failed against the fix, which
  // is how the over-broad window was found.
  check_('...and reads no spawn result’s `stderr` directly', /\b(merged|diff)\.stderr/.test(source), false);
}

// ---------------------------------------------------------------------------

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${String(passed)} passed, ${String(failed)} failed\n`);
process.exit(failed === 0 ? 0 : 1);
