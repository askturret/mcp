#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the repository's CI guards — the two #79 test-integrity guards and
 * the #26 network-access guard.
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
const NETWORK = join(here, 'check-network-imports.mjs');

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

// ---------------------------------------------------------------------------
// check-network-imports.mjs (#26)
//
// The telemetry policy's first clause — no outbound call unless the adopter
// configured one — is only as strong as this guard. Each case below is a way
// the guard could fail open (miss real egress) or cry wolf (flag something
// inert). Both make it worthless, for opposite reasons.
// ---------------------------------------------------------------------------

/** A throwaway directory with no packages/ tree at all. */
function scratchEmpty() {
  const dir = mkdtempSync(join(tmpdir(), 'netguard-empty-'));
  tmpDirs.push(dir);
  return dir;
}

/** A throwaway repo root holding one packages/<pkg>/src file. */
function scratchPackage(relPath, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'netguard-'));
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  tmpDirs.push(dir);
  return dir;
}

check(
  'network: flags a bare fetch() in a non-allowlisted file',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `export async function phoneHome() {
         await fetch('https://telemetry.example.com/collect');
       }`,
    ),
  ).code,
  1,
);

check(
  'network: flags a runtime import of undici outside the allowlist',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `import { request } from 'undici';
       export const go = () => request('https://example.com');`,
    ),
  ).code,
  1,
);

check(
  'network: flags node:-prefixed builtins too',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `import https from 'node:https';
       export const go = () => https.get('https://example.com');`,
    ),
  ).code,
  1,
);

// The mechanism this codebase actually uses is the global fetch, so an
// allowlisted file must still be able to use it or the guard is unshippable.
check(
  'network: allows fetch() inside an allowlisted executor file',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/executor/via-http.ts',
      `export async function call(url) {
         return fetch(url);
       }`,
    ),
  ).code,
  0,
);

check(
  'network: allows a network import inside an allowlisted transport file',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/transports/src/http/index.ts',
      `import http from 'node:http';
       export const serve = () => http.createServer();`,
    ),
  ).code,
  0,
);

// A type-only import is erased before anything runs. Failing it would train
// people to route around the guard rather than fix real problems.
check(
  'network: does NOT flag a type-only import of http',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `import type { Server } from 'http';
       export type Held = Server;`,
    ),
  ).code,
  0,
);

// ...but a value binding smuggled in alongside a type binding is a real import.
// This is the exact shape that appears in this repo's own test files.
check(
  'network: DOES flag a mixed value+type import of http',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `import { createServer, type Server } from 'http';
       export const s = createServer();`,
    ),
  ).code,
  1,
);

// packages/explorer emits browser JavaScript inside a template literal, and
// that browser code calls fetch against the adopter's own server. It is not
// egress from the Node process. Flagging it is how a guard earns a reputation
// for crying wolf and gets switched off.
check(
  'network: does NOT flag fetch inside a template literal',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/explorer/src/html.ts',
      'export const page = `<script>fetch("/api/tools");</script>`;',
    ),
  ).code,
  0,
);

check(
  'network: does NOT flag a comment mentioning node-fetch',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `// We deliberately avoid node-fetch here; see docs/telemetry-policy.md.
       export const compile = () => 1;`,
    ),
  ).code,
  0,
);

// A method named fetch on an object is not the global one.
check(
  'network: does NOT flag a property call like client.fetch()',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `export const run = (client) => client.fetch('thing');`,
    ),
  ).code,
  0,
);

// A greedy cross-statement match reported a real import at an unrelated line
// during development. The bug is invisible unless a file has an earlier
// `export` keyword, so it gets a fixture of its own.
check(
  'network: does not mis-attribute an import to an earlier export statement',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `export interface Compiler { run(): void }
       export const ok = true;`,
    ),
  ).code,
  0,
);

// Test files never ship to an adopter. Skipping them is deliberate; asserting
// it here means the decision is recorded rather than assumed.
check(
  'network: skips test files',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/__tests__/wiring.test.ts',
      `import { createServer } from 'http';
       it('serves', () => { createServer(); });`,
    ),
  ).code,
  0,
);

// Reporting success on a scan that examined nothing is the failure mode that
// would make every other assertion here meaningless.
check(
  'network: fails closed when there is no packages/ directory',
  runGuard(NETWORK, scratchEmpty()).code,
  1,
);

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
