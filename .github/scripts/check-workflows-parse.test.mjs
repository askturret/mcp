#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for check-workflows-parse.mjs (#698).
 *
 * A guard that cannot go red is not a check (ADR-024), and that would be a
 * particularly poor joke in a guard whose entire subject is checks that pass
 * files they never really examined. So every arm is driven here: the observed
 * failure, the clean case, both cannot-check paths, and the degenerate
 * documents.
 *
 * THE CENTRAL CASE IS THE REAL ONE. `colonSpaceWorkflow()` reproduces the
 * construct from `fca8746` verbatim —
 *
 *   run: echo "Integrated tree under test: $GITHUB_SHA"
 *
 * — the line that made `reliability-nightly.yml` unloadable on PR #697 while
 * `check-runners.mjs` (hand-rolled parser) and `check-guards.test.mjs` (text
 * grep) both passed it. If this file is ever rewritten with an invented
 * "obviously broken YAML" fixture instead, the test stops witnessing the defect
 * it was built for: the point is that this shape looks entirely reasonable.
 *
 * The parser-missing arm is exercised by COPYING the guard to a temporary
 * directory outside the repository, where `js-yaml` does not resolve. That is
 * the one arm which, if it silently passed, would let the guard degrade into a
 * green that checked nothing — the exact class it exists to prevent.
 *
 * Deliberately spawns the guard as a child process rather than importing it,
 * which is `check-runners.test.mjs`'s convention. It also means the guard needs
 * no "am I the entry point?" check — see the note at the foot of the guard for
 * why that check is a silent-failure hazard on a path containing a space.
 *
 * Run: node .github/scripts/check-workflows-parse.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, 'check-workflows-parse.mjs');

const EXIT_OK = 0;
const EXIT_UNPARSEABLE = 1;
const EXIT_CANNOT_CHECK = 2;

let passed = 0;
let failed = 0;

function check(desc, ok, detail = '') {
  if (ok) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc}${detail ? `\n       ${detail}` : ''}`);
    failed++;
  }
}

/** Run the guard against a repo root, returning its exit code and output. */
function runGuard(repoRoot, guardPath = GUARD) {
  const r = spawnSync(process.execPath, [guardPath, repoRoot], { encoding: 'utf-8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** A temp repo root with a `.github/workflows` directory. */
function makeRepo(label) {
  const root = mkdtempSync(join(tmpdir(), `check-workflows-parse-${label}-`));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  return root;
}

function writeWorkflow(root, name, body) {
  writeFileSync(join(root, '.github', 'workflows', name), body, 'utf8');
}

const validWorkflow = `name: Valid
on:
  workflow_dispatch:
jobs:
  demo:
    runs-on: [self-hosted, Linux, X64, askturret]
    steps:
      - run: echo hello
`;

/**
 * The fca8746 construct, verbatim: a plain scalar containing colon-space.
 *
 * The quote is not at the START of the value, so this is a PLAIN scalar that
 * happens to contain `"` — not a quoted one. The parser reaches the colon after
 * `test` and tries to open a nested mapping.
 */
const colonSpaceWorkflow = `name: Nightly
on:
  schedule:
    - cron: '0 3 * * *'
jobs:
  integrated-tree:
    runs-on: [self-hosted, Linux, X64, askturret]
    steps:
      - name: Name the tree under test
        run: echo "Integrated tree under test: $GITHUB_SHA"
`;

const roots = [];
function repo(label) {
  const r = makeRepo(label);
  roots.push(r);
  return r;
}

try {
  // --- the observed failure ---------------------------------------------------
  {
    const root = repo('colon');
    writeWorkflow(root, 'reliability-nightly.yml', colonSpaceWorkflow);
    const { status, out } = runGuard(root);
    check('the fca8746 colon-space shape is REJECTED', status === EXIT_UNPARSEABLE, `exit ${status}`);
    check(
      'the failure names the offending file',
      out.includes('reliability-nightly.yml'),
      out.trim(),
    );
    check(
      'the failure reports a line:column, since a parse error without a location is not actionable',
      /reliability-nightly\.yml:\d+:\d+/.test(out),
      out.trim(),
    );
    check(
      'the reported line is the line carrying the colon-space',
      /reliability-nightly\.yml:10:\d+/.test(out),
      `expected line 10 of the fixture; got: ${out.trim()}`,
    );
  }

  // --- one bad file among good ones is still caught ---------------------------
  {
    const root = repo('mixed');
    writeWorkflow(root, 'a-valid.yml', validWorkflow);
    writeWorkflow(root, 'b-broken.yml', colonSpaceWorkflow);
    writeWorkflow(root, 'c-valid.yaml', validWorkflow);
    const { status, out } = runGuard(root);
    check('a single broken file among valid ones fails the run', status === EXIT_UNPARSEABLE);
    check('only the broken file is named', out.includes('b-broken.yml') && !out.includes('a-valid.yml'));
  }

  // --- the clean case ---------------------------------------------------------
  {
    const root = repo('clean');
    writeWorkflow(root, 'valid.yml', validWorkflow);
    writeWorkflow(root, 'valid2.yaml', validWorkflow);
    const { status, out } = runGuard(root);
    check('valid workflows pass', status === EXIT_OK, `exit ${status}: ${out.trim()}`);
    check('the pass message states the bound rather than overclaiming', /does NOT assert GitHub accepts/.test(out));
  }

  // --- degenerate documents ---------------------------------------------------
  {
    const root = repo('empty-doc');
    writeWorkflow(root, 'empty.yml', '# only a comment\n');
    const { status, out } = runGuard(root);
    check('a comments-only file is not a pass', status === EXIT_UNPARSEABLE, `exit ${status}`);
    check('it says the document is empty', /empty document/.test(out), out.trim());
  }
  {
    const root = repo('scalar-doc');
    writeWorkflow(root, 'scalar.yml', 'just a string\n');
    const { status, out } = runGuard(root);
    check('a file parsing to a scalar is not a pass', status === EXIT_UNPARSEABLE, `exit ${status}`);
    check('it says the document is not a mapping', /not a mapping/.test(out), out.trim());
  }

  // --- cannot-check arms ------------------------------------------------------
  {
    const root = mkdtempSync(join(tmpdir(), 'check-workflows-parse-nodir-'));
    roots.push(root);
    const { status, out } = runGuard(root);
    check('a missing .github/workflows directory is CANNOT CHECK, not a pass', status === EXIT_CANNOT_CHECK, `exit ${status}`);
    check('it says nothing was verified', /NOT a pass/.test(out), out.trim());
  }
  {
    const root = repo('nofiles');
    const { status, out } = runGuard(root);
    check('an empty workflow directory is CANNOT CHECK, not a vacuous pass', status === EXIT_CANNOT_CHECK, `exit ${status}`);
    check('it explains why an empty directory is reported', /broken checkout/.test(out), out.trim());
  }

  // --- the fail-closed arm that keeps the dependency honest -------------------
  {
    // Copied OUTSIDE the repository, so `import('js-yaml')` cannot resolve.
    // If this arm ever returns 0, the guard has become a green that checked
    // nothing — which is the entire defect class #698 is about.
    const sandbox = mkdtempSync(join(tmpdir(), 'check-workflows-parse-noparser-'));
    roots.push(sandbox);
    const copied = join(sandbox, 'check-workflows-parse.mjs');
    copyFileSync(GUARD, copied);

    const root = repo('noparser-target');
    writeWorkflow(root, 'valid.yml', validWorkflow);

    const { status, out } = runGuard(root, copied);
    check(
      'an unavailable YAML parser is CANNOT CHECK (exit 2), never a pass',
      status === EXIT_CANNOT_CHECK,
      `exit ${status}: ${out.trim()}`,
    );
    check('it names js-yaml and tells the reader to install', /js-yaml/.test(out) && /npm ci/.test(out), out.trim());
  }

  // --- the guard actually runs when invoked -----------------------------------
  {
    // Regression for the silent no-op found while writing this: an
    // `import.meta.url === \`file://${argv[1]}\`` entry check is false on any
    // path containing a space, so main() never ran and the process exited 0
    // with NO OUTPUT. Exit 0 alone would not have caught it.
    const root = repo('speaks');
    writeWorkflow(root, 'valid.yml', validWorkflow);
    const { status, out } = runGuard(root);
    check(
      'a passing run PRINTS a verdict — exit 0 with no output is a silent no-op',
      status === EXIT_OK && out.trim().length > 0,
      `exit ${status}, output ${JSON.stringify(out)}`,
    );
    check('the verdict states how many files were checked', /2 workflow file\(s\)|1 workflow file\(s\)/.test(out), out.trim());
  }
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
