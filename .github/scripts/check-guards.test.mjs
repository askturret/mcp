#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the two #79 guards.
 *
 * The guards exist because things silently stopped running. A guard that
 * silently stops working is the same failure, one level up — so each one is
 * exercised here against fixtures reproducing every root cause it claims to
 * catch, plus the near-misses that would make it cry wolf.
 *
 * Run: node .github/scripts/check-guards.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = join(here, 'check-placeholder-tests.mjs');
const EXECUTION = join(here, 'check-test-execution.mjs');

let passed = 0;
let failed = 0;

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (expected exit ${expected}, got ${actual})`);
    failed++;
  }
}

function runGuard(script, dir) {
  const r = spawnSync('node', [script, dir], { encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A throwaway directory holding one test file. */
function withTestFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  writeFileSync(join(dir, 'sample.test.ts'), contents);
  return dir;
}

const tmpDirs = [];
const scratch = (contents) => {
  const d = withTestFile(contents);
  tmpDirs.push(d);
  return d;
};

// ---------------------------------------------------------------------------
// check-placeholder-tests.mjs
// ---------------------------------------------------------------------------

check(
  'placeholder: flags expect(true).toBe(true)',
  runGuard(PLACEHOLDER, scratch(`
    it('does nothing', () => {
      expect(true).toBe(true);
    });
  `)).code,
  1,
);

check(
  'placeholder: flags a test body with no assertion at all',
  runGuard(PLACEHOLDER, scratch(`
    it('runs some code', async () => {
      const result = await doTheThing();
      console.log(result);
    });
  `)).code,
  1,
);

check(
  'placeholder: flags it.only, which disables every other test',
  runGuard(PLACEHOLDER, scratch(`
    it.only('focused', () => {
      expect(1 + 1).toBe(2);
    });
  `)).code,
  1,
);

check(
  'placeholder: flags expect(1).toBe(1)',
  runGuard(PLACEHOLDER, scratch(`
    it('tautology with numbers', () => {
      expect(1).toBe(1);
    });
  `)).code,
  1,
);

check(
  'placeholder: accepts a real assertion',
  runGuard(PLACEHOLDER, scratch(`
    it('checks something real', () => {
      expect(add(2, 2)).toBe(4);
    });
  `)).code,
  0,
);

// The guard must not flag its own documentation, or anyone else's.
check(
  'placeholder: does NOT flag a tautology quoted inside a comment',
  runGuard(PLACEHOLDER, scratch(`
    it('checks something real', () => {
      // This used to be expect(true).toBe(true), which asserted nothing.
      expect(add(2, 2)).toBe(4);
    });
  `)).code,
  0,
);

check(
  'placeholder: does NOT flag a tautology inside a string literal',
  runGuard(PLACEHOLDER, scratch(`
    it('reports bad patterns', () => {
      expect(lint(source)).toContain('expect(true).toBe(true)');
    });
  `)).code,
  0,
);

check(
  'placeholder: does NOT flag a block comment mentioning it.only',
  runGuard(PLACEHOLDER, scratch(`
    /* Never commit it.only( — it disables the rest of the file. */
    it('is fine', () => {
      expect(compute()).toEqual([1, 2]);
    });
  `)).code,
  0,
);

check(
  'placeholder: .skip warns but does not fail',
  runGuard(PLACEHOLDER, scratch(`
    it.skip('temporarily disabled', () => {
      expect(add(1, 1)).toBe(2);
    });
  `)).code,
  0,
);

{
  const dir = scratch(`
    it('weakly asserts', () => {
      expect(thing()).toBeDefined();
    });
  `);
  const r = runGuard(PLACEHOLDER, dir);
  check('placeholder: weak-assertion-only warns but does not fail', r.code, 0);
  check(
    'placeholder: ...and says so in the output',
    r.out.includes('only weak assertions') ? 'reported' : r.out,
    'reported',
  );
}

// ---------------------------------------------------------------------------
// check-test-execution.mjs
// ---------------------------------------------------------------------------

/** Build a throwaway npm workspace with one package. */
function scratchWorkspace(pkgOverrides) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-ws-'));
  tmpDirs.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }, null, 2),
  );
  const pkgDir = join(dir, 'packages', 'thing');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'thing', version: '1.0.0', private: true, ...pkgOverrides }, null, 2),
  );
  return dir;
}

check(
  'execution: fails a "test": "exit 0" no-op script',
  runGuard(EXECUTION, scratchWorkspace({ scripts: { test: 'exit 0' } })).code,
  1,
);

check(
  'execution: fails a package with no test script at all',
  runGuard(EXECUTION, scratchWorkspace({ scripts: {} })).code,
  1,
);

check(
  'execution: fails when the runner reports zero tests',
  runGuard(
    EXECUTION,
    scratchWorkspace({
      scripts: { test: 'node -e "console.error(\'Tests: 0 total\')"' },
    }),
  ).code,
  1,
);

check(
  'execution: fails when the test command errors',
  runGuard(
    EXECUTION,
    scratchWorkspace({ scripts: { test: 'node -e "process.exit(1)"' } }),
  ).code,
  1,
);

check(
  'execution: fails closed when no test count can be parsed',
  runGuard(
    EXECUTION,
    scratchWorkspace({ scripts: { test: 'node -e "console.log(\'all good!\')"' } }),
  ).code,
  1,
);

check(
  'execution: passes when tests actually run',
  runGuard(
    EXECUTION,
    scratchWorkspace({
      scripts: { test: 'node -e "console.error(\'Tests: 3 passed, 3 total\')"' },
    }),
  ).code,
  0,
);

check(
  'execution: honours an explicit testsNotRequired declaration',
  runGuard(
    EXECUTION,
    scratchWorkspace({ askturret: { testsNotRequired: 'no source of its own' } }),
  ).code,
  0,
);

check(
  'execution: rejects an empty testsNotRequired reason',
  runGuard(EXECUTION, scratchWorkspace({ askturret: { testsNotRequired: '' } })).code,
  1,
);

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
