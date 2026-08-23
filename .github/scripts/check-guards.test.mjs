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
const NUL = join(here, 'check-nul-bytes.mjs');
const CARDINALITY = join(here, 'check-metric-cardinality.mjs');

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

// A greedy cross-statement match (`[\s\S]*?` between `export` and `from`)
// reported a real import TWICE during development: once correctly, and once
// mis-attributed to an unrelated `export` line far above it.
//
// This fixture needs all three of its parts or it proves nothing:
//   1. an `export` on line 1 for the greedy match to start from,
//   2. a `;` before the import, which is what bounds the fixed regex,
//   3. a REAL `from '...'` clause for the greedy match to run onto.
//
// The first version of this test omitted (3). With no import anywhere, both
// the buggy and the fixed regex matched nothing and returned zero violations
// identically — so the suite stayed green with the bug reinstated. That is the
// #79 "test that cannot fail" class, caught in QA on PR #115.
//
// Exit code alone still cannot tell the two apart: both report at least one
// violation and exit 1. The count and the line number are the discriminators,
// so those are what get asserted.
{
  const r = runGuard(
    NETWORK,
    scratchPackage(
      'packages/core/src/compiler/pass.ts',
      `export interface Compiler { run(): void }
export const ok = true;

import { request } from 'undici';
export const go = () => request('https://example.com');
`,
    ),
  );
  const undiciHits = (r.out.match(/imports 'undici'/g) ?? []).length;

  check('network: still flags the undici import in this fixture', r.code, 1);

  // Greedy regex: 2 (line 1 spurious + line 4 real). Bounded: 1.
  check('network: reports the import once, not once per earlier export', undiciHits, 1);

  // The spurious hit lands on line 1, the `export interface` line.
  check(
    'network: does not mis-attribute the import to an earlier export line',
    /pass\.ts:1 — imports 'undici'/.test(r.out) ? 'mis-attributed to line 1' : 'attributed correctly',
    'attributed correctly',
  );
}

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

// ---------------------------------------------------------------------------
// check-nul-bytes.mjs (#119)
//
// The guard exists because nothing else in CI reads source at the byte level.
// Its own tests therefore have to write real bytes, not strings that look like
// them — asserting on '\\0' in a template literal would test the wrong thing.
// ---------------------------------------------------------------------------

/** A throwaway repo root holding one file written from explicit bytes. */
function scratchBytes(relPath, buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'nulguard-'));
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, buffer);
  tmpDirs.push(dir);
  return dir;
}

check(
  'nul: flags a NUL byte in a TypeScript file',
  runGuard(
    NUL,
    scratchBytes(
      'packages/core/src/thing.ts',
      Buffer.concat([Buffer.from("export const a = 'x"), Buffer.from([0x00]), Buffer.from("y';\n")]),
    ),
  ).code,
  1,
);

check(
  'nul: flags a NUL byte in JSON',
  runGuard(
    NUL,
    scratchBytes(
      'packages/core/config.json',
      Buffer.concat([Buffer.from('{"a":"b'), Buffer.from([0x00]), Buffer.from('c"}\n')]),
    ),
  ).code,
  1,
);

check(
  'nul: accepts a clean file',
  runGuard(NUL, scratchBytes('packages/core/src/thing.ts', Buffer.from("export const a = 'xy';\n")))
    .code,
  0,
);

// The literal two-character sequence backslash-zero is ordinary source and must
// not be confused with the byte it denotes.
check(
  'nul: does NOT flag an escaped \\0 written as source text',
  runGuard(
    NUL,
    scratchBytes('packages/core/src/thing.ts', Buffer.from("export const sep = '\\0';\n")),
  ).code,
  0,
);

// Multi-byte UTF-8 is not corruption; a guard that flagged it would be turned
// off within a day.
check(
  'nul: does NOT flag non-ASCII UTF-8',
  runGuard(
    NUL,
    scratchBytes('packages/core/src/thing.ts', Buffer.from("// §5.5 — em dash, ok\n", 'utf-8')),
  ).code,
  0,
);

check(
  'nul: fails closed when the scan finds no files',
  runGuard(NUL, mkdtempSync(join(tmpdir(), 'nulguard-empty-'))).code,
  1,
);

{
  const r = runGuard(
    NUL,
    scratchBytes(
      'packages/core/src/thing.ts',
      Buffer.concat([Buffer.from('const a = 1;\nconst b = '), Buffer.from([0x00]), Buffer.from('2;\n')]),
    ),
  );
  check('nul: reports the offending line number', r.out.includes('thing.ts:2') ? 'located' : r.out, 'located');
}

// ---------------------------------------------------------------------------
// check-metric-cardinality.mjs (#39, §9.2)
//
// An unbounded metric label creates one time series per distinct value. This
// guard's own failure mode is the usual denylist trap: too narrow and it
// misses the spelling people actually write, too broad and it blocks correct
// labels until someone switches it off. Both directions are tested.
// ---------------------------------------------------------------------------

/** A throwaway package-shaped tree holding one source file. */
function scratchSource(relPath, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'cardguard-'));
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  tmpDirs.push(dir);
  return dir;
}

check(
  'cardinality: passes on the documented label sets',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [
         { name: METRIC.a, kind: 'counter', labels: ['method', 'outcome'] },
         { name: METRIC.b, kind: 'gauge', labels: ['tool', 'registry_hash'] },
       ];\n`,
    ),
  ).code,
  0,
);

check(
  "cardinality: fails on a declared user_id label (the issue's stated case)",
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'counter', labels: ['method', 'user_id'] }];\n`,
    ),
  ).code,
  1,
);

check(
  'cardinality: fails on snake_case request_id, not just camelCase requestId',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'counter', labels: ['request_id'] }];\n`,
    ),
  ).code,
  1,
);

check(
  'cardinality: fails on a denied label passed at a CALL SITE, not just declared',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/dispatcher/index.ts',
      `metrics.add(METRIC.requestsTotal, 1, { method: 'tools/call', tenant: t });\n`,
    ),
  ).code,
  1,
);

check(
  'cardinality: does NOT fire on `outcome`, which contains the denied term "sub"',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'counter', labels: ['outcome', 'error_code'] }];\n`,
    ),
  ).code,
  0,
);

check(
  'cardinality: does NOT fire on executor_type, bulkhead, breaker, phase, decision',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'histogram', labels: ['executor_type', 'bulkhead', 'breaker', 'phase', 'decision'] }];\n`,
    ),
  ).code,
  0,
);

{
  const r = runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'counter', labels: ['tenantName'] }];\n`,
    ),
  );
  check(
    'cardinality: names the offending label and the term it matched',
    r.out.includes('tenantName') && r.out.includes('tenant') ? 'named' : r.out,
    'named',
  );
}

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
