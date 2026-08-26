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

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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

function runGuard(script, dir, ...extraArgs) {
  const r = spawnSync('node', [script, dir, ...extraArgs], { encoding: 'utf-8' });
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
// #328: a declaration is not a method call.
//
// `\b(it|test)(` matched the boundary between `.` and `t`, so `regex.test(...)`
// parsed as a test declaration with an assertion-free body. Both directions are
// asserted here: the false positive must be gone, and the guard must NOT have
// gone blind to a genuinely empty body in the process.
// ---------------------------------------------------------------------------

// NOTE ON THIS FIXTURE: the trailing helper is load-bearing, not filler.
// `extractBody` takes the NEXT `{` after a match, so without a following block
// the buggy guard found no body and bailed out — the test then passed under
// the OLD code and proved nothing. That is how it reproduced on #326: the
// `.test(` calls were followed by another braced block, which the guard
// adopted as their "body" and correctly found to contain no assertion.
check(
  'placeholder: does NOT flag regex.test() inside a real test (#328)',
  runGuard(PLACEHOLDER, scratch(`
    it('matches the pattern', () => {
      const re = /^abc/;
      expect(re.test('abcdef')).toBe(true);
    });

    function helper() {
      return 1;
    }
  `)).code,
  0,
);

check(
  'placeholder: STILL flags an assertion-free body that calls regex.test (#328)',
  runGuard(PLACEHOLDER, scratch(`
    it('checks nothing', () => {
      const re = /^abc/;
      re.test('abcdef');
    });
  `)).code,
  1,
);

check(
  'placeholder: does NOT flag a .test.only() method chain (#328)',
  runGuard(PLACEHOLDER, scratch(`
    it('drives a helper', () => {
      const matcher = buildMatcher();
      matcher.test.only('a');
      expect(matcher.calls).toBe(1);
    });
  `)).code,
  0,
);

// The counterpart to the three above: excluding dot-prefixed forms must not
// weaken .only detection, whose dot comes AFTER the keyword. A careless
// "reject anything involving a dot" fix passes the tests above and breaks
// these two — which is the whole reason they are here.
check(
  'placeholder: STILL flags test.only (#328 regression guard)',
  runGuard(PLACEHOLDER, scratch(`
    test.only('focused', () => {
      expect(add(1, 1)).toBe(2);
    });
  `)).code,
  1,
);

check(
  'placeholder: STILL flags describe.only (#328 regression guard)',
  runGuard(PLACEHOLDER, scratch(`
    describe.only('focused suite', () => {
      it('inner', () => {
        expect(add(1, 1)).toBe(2);
      });
    });
  `)).code,
  1,
);

check(
  'placeholder: does NOT flag an identifier ending in a declaration keyword (#328)',
  runGuard(PLACEHOLDER, scratch(`
    it('tolerates dollar-suffixed helpers', () => {
      my$test('x', () => {
        return 1;
      });
      expect(sent()).toBe(true);
    });
  `)).code,
  0,
);

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

/**
 * A workspace whose fake runner reports exactly the suites named in `reported`,
 * while `onDisk` test files exist. That gap is the whole subject of #339.
 *
 * The runner is a `node -e` stand-in rather than real jest because the property
 * under test is what the guard does with a runner's OUTPUT — using real jest
 * would test jest's reporter instead, and could not express the fail-closed
 * case at all (a run with no PASS lines).
 */
function scratchPerFile({ onDisk, reported, tests = 1, pkgOverrides = {} }) {
  const lines = reported.map((f) => `console.error('PASS ${f}')`).join(';');
  const dir = scratchWorkspace({
    scripts: { test: `node -e "${lines}${lines ? ';' : ''}console.error('Tests: ${tests} passed, ${tests} total')"` },
    ...pkgOverrides,
  });
  for (const rel of onDisk) {
    const full = join(dir, 'packages', 'thing', rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '// fixture\n');
  }
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
// #339: per-FILE execution.
//
// The package-level checks above ask "did this package run any tests". They are
// right, and they are silent on a file that contributes none — #216 found one
// such file, #313 found two more, and all three were found by a human reading a
// config rather than by CI.
//
// Keyed on the SHARED SYMPTOM ("this file contributed no tests to the run")
// rather than on either known cause, because #313's files had BOTH a config
// exclusion and a dead self-invocation block, and a check keyed on either alone
// would have passed them.
// ---------------------------------------------------------------------------

check(
  'per-file: PASSES when every test file on disk appears in the run',
  runGuard(
    EXECUTION,
    scratchPerFile({ onDisk: ['src/a.test.ts', 'src/b.test.ts'], reported: ['src/a.test.ts', 'src/b.test.ts'] }),
  ).code,
  0,
);

{
  const r = runGuard(
    EXECUTION,
    scratchPerFile({ onDisk: ['src/a.test.ts', 'src/b.test.ts'], reported: ['src/a.test.ts'] }),
  );
  check('per-file: FAILS when a test file on disk never ran (#339)', r.code, 1);
  check('per-file: ...and names the file that did not run', r.out.includes('src/b.test.ts'), true);
  check(
    'per-file: ...and does not accuse the file that DID run',
    /contributed no tests[^\n]*src\/a\.test\.ts/.test(r.out),
    false,
  );
}

check(
  'per-file: FAILS CLOSED when no per-suite lines can be parsed (#339)',
  // A runner that reports a count but no suites is indistinguishable from one
  // that skipped every file. "I could not tell" must not become "it passed".
  runGuard(EXECUTION, scratchPerFile({ onDisk: ['src/a.test.ts'], reported: [] })).code,
  1,
);

{
  // The OTHER way the reporter coupling can break, and the likelier one (#344).
  //
  // A jest upgrade is far more likely to change how a path is RENDERED than to
  // stop emitting the line at all. That mode was already loud, but only
  // INCIDENTALLY — every file reads as never-run, via the generic path — so
  // nothing pinned it. Both modes being loud is what turned "reporter-coupled"
  // from a soundness objection into a maintenance cost, and that argument is
  // why the extend-over-sibling design was endorsed. It deserves an assertion
  // holding it up rather than a paragraph.
  const r = runGuard(
    EXECUTION,
    scratchPerFile({
      onDisk: ['src/a.test.ts'],
      reported: ['/abs/build/packages/thing/src/a.test.ts'],
    }),
  );
  check('per-file: FAILS CLOSED when the reported path FORMAT changes (#344)', r.code, 1);
  check(
    'per-file: ...and names the file rather than failing silently',
    r.out.includes('src/a.test.ts'),
    true,
  );
}

check(
  'per-file: catches a file whose tests are ALL skipped (#344)',
  // #339 documented this class as NOT covered. It is — verified against this
  // repo's real jest: a fully-skipped file emits NO per-suite line, so it lands
  // in the same bucket as an excluded one, while a partly-skipped file still
  // emits its line and correctly passes. Nothing special-cases `.skip`; the
  // keyed symptom ("contributed no tests") covers it. Pinned here so the
  // corrected docstring cannot drift back into being wrong.
  runGuard(
    EXECUTION,
    scratchPerFile({ onDisk: ['src/a.test.ts', 'src/quiet.test.ts'], reported: ['src/a.test.ts'] }),
  ).code,
  1,
);

check(
  'per-file: a written exemption is honoured',
  runGuard(
    EXECUTION,
    scratchPerFile({
      onDisk: ['src/a.test.ts', 'src/b.test.ts'],
      reported: ['src/a.test.ts'],
      pkgOverrides: { askturret: { testFilesNotExecuted: { 'src/b.test.ts': 'fixture, not a suite' } } },
    }),
  ).code,
  0,
);

check(
  'per-file: an exemption with no reason is rejected',
  runGuard(
    EXECUTION,
    scratchPerFile({
      onDisk: ['src/a.test.ts', 'src/b.test.ts'],
      reported: ['src/a.test.ts'],
      pkgOverrides: { askturret: { testFilesNotExecuted: { 'src/b.test.ts': '' } } },
    }),
  ).code,
  1,
);

check(
  'per-file: a STALE exemption naming a file that does run is rejected',
  // Otherwise an exemption outlives its reason and quietly re-opens the hole.
  runGuard(
    EXECUTION,
    scratchPerFile({
      onDisk: ['src/a.test.ts'],
      reported: ['src/a.test.ts'],
      pkgOverrides: { askturret: { testFilesNotExecuted: { 'src/a.test.ts': 'no longer true' } } },
    }),
  ).code,
  1,
);

check(
  'per-file: a STALE exemption naming a file that no longer exists is rejected',
  runGuard(
    EXECUTION,
    scratchPerFile({
      onDisk: ['src/a.test.ts'],
      reported: ['src/a.test.ts'],
      pkgOverrides: { askturret: { testFilesNotExecuted: { 'src/gone.test.ts': 'deleted long ago' } } },
    }),
  ).code,
  1,
);

{
  // "This package has nothing to test" and "this package ships test files"
  // cannot both be true — the declaration would exempt those files from ever
  // running, which is precisely the silence being guarded against.
  const dir = scratchWorkspace({ askturret: { testsNotRequired: 'nothing to test here' } });
  mkdirSync(join(dir, 'packages', 'thing', 'src'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'thing', 'src', 'orphan.test.ts'), '// fixture\n');
  const r = runGuard(EXECUTION, dir);
  check('per-file: FAILS a testsNotRequired package that still ships test files', r.code, 1);
  check('per-file: ...and names the stranded file', r.out.includes('src/orphan.test.ts'), true);
}

check(
  'per-file: a package with NO test files is unaffected by the new check',
  // The check must not invent a requirement the package-level rules never had.
  runGuard(EXECUTION, scratchPerFile({ onDisk: [], reported: ['src/ghost.test.ts'] })).code,
  0,
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

// The gateway entry was `packages/gateway/src/` — a whole directory — until it
// was narrowed to the one file that needs it (#181). Both halves of that
// narrowing are pinned, because either alone can pass for the wrong reason: the
// listener must still be ALLOWED, and a sibling must now be CAUGHT.
check(
  'network: allows the inbound listener import in the allowlisted gateway server.ts',
  runGuard(
    NETWORK,
    scratchPackage(
      'packages/gateway/src/server.ts',
      `import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
       export const serve = () => createServer();`,
    ),
  ).code,
  0,
);

// The demonstration from #181, kept as a test: an outbound `node:https` call in
// `src/version.ts`, sitting beside the listener that is legitimately
// allowlisted. Under the directory entry this exited 0 and printed "No network
// access outside the allowlist" — the guard's own success message, over a file
// calling an arbitrary host. Restoring `packages/gateway/src/` reddens both
// assertions below.
{
  const dir = mkdtempSync(join(tmpdir(), 'netguard-gateway-'));
  mkdirSync(join(dir, 'packages', 'gateway', 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'packages', 'gateway', 'src', 'server.ts'),
    `import { createServer } from 'node:http';
     export const serve = () => createServer();`,
  );
  writeFileSync(
    join(dir, 'packages', 'gateway', 'src', 'version.ts'),
    `import { request } from 'node:https';
     export function phoneHome() { return request('https://example.com/collect'); }`,
  );
  tmpDirs.push(dir);

  const r = runGuard(NETWORK, dir);

  check(
    'network: flags an outbound call in a gateway file beside the allowlisted listener',
    r.code,
    1,
  );

  // Exit 1 on its own would ALSO be the result if the narrowing had broken the
  // legitimate case and flagged `server.ts` instead — the opposite failure, with
  // an identical exit code. Only the attribution separates them, so that is what
  // gets asserted rather than the summary.
  check(
    'network: attributes the violation to version.ts and leaves server.ts allowlisted',
    /packages\/gateway\/src\/version\.ts:\d+ — imports 'node:https'/.test(r.out) &&
      !/server\.ts:\d+ — /.test(r.out)
      ? 'version.ts only'
      : `wrong attribution:\n${r.out}`,
    'version.ts only',
  );
}

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
// check-nul-bytes.mjs — scan coverage (#121)
//
// Two coverage gaps, both found during #119's QA rather than by the guard
// itself. They are not bugs in what it checks; they are places it never looked.
// ---------------------------------------------------------------------------

const NUL_BYTES = (before, after) =>
  Buffer.concat([Buffer.from(before), Buffer.from([0x00]), Buffer.from(after)]);

/**
 * A throwaway repo root with every REQUIRED scan root present.
 *
 * Each required root gets a real file, so a fixture never trips the
 * empty-scan check or the missing-root check by accident — leaving whatever the
 * test is actually about as the only reason it can fail.
 */
function scratchRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nulroots-'));
  for (const root of ['packages', 'examples', 'docs', '.github']) {
    mkdirSync(join(dir, root), { recursive: true });
    writeFileSync(join(dir, root, 'placeholder.md'), `# ${root}\n`);
  }
  for (const [relPath, contents] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  tmpDirs.push(dir);
  return dir;
}

// The headline gap: Tester demonstrated that a NUL in a root-level file exited
// 0 while the same bytes under packages/ exited 1.
check(
  'nul: flags a NUL byte in a root-level package.json',
  runGuard(NUL, scratchRepo({ 'package.json': NUL_BYTES('{"name":"a', 'b"}\n') })).code,
  1,
);

check(
  'nul: flags a NUL byte in a root-level README.md',
  runGuard(NUL, scratchRepo({ 'README.md': NUL_BYTES('# Title\nbody ', ' more\n') })).code,
  1,
);

check(
  'nul: accepts clean root-level files',
  runGuard(
    NUL,
    scratchRepo({ 'package.json': '{"name":"a"}\n', 'tsconfig.json': '{}\n', 'README.md': '# ok\n' }),
  ).code,
  0,
);

// The root scan is a GLOB, not a scan root. If it recursed, it would walk
// node_modules — SKIP_DIRS only prunes by name, and an unlisted directory is
// deliberately out of scope. This is the assertion that would go red if someone
// "simplified" it into `walk(repoRoot)`.
check(
  'nul: does NOT recurse from the root into undeclared directories',
  runGuard(NUL, scratchRepo({ 'unlisted/deep/thing.ts': NUL_BYTES('const a = ', '1;\n') })).code,
  0,
);

// A missing REQUIRED root is visible by default, but not fatal — pointing the
// guard at a fixture is a legitimate thing to do.
{
  const r = runGuard(NUL, scratchBytes('README.md', Buffer.from('# only a root file\n')));
  check('nul: warns about a missing required root by default', r.code, 0);
  check(
    'nul: names the missing root in the warning',
    r.out.includes('packages/') && r.out.includes('REQUIRED') ? 'named' : r.out,
    'named',
  );
}

// ...and fatal under --require-roots, which is how CI runs it. This is the
// assertion that stops a renamed `packages/` from silently halving coverage
// while the guard still reports success.
{
  const r = runGuard(
    NUL,
    scratchBytes('README.md', Buffer.from('# only a root file\n')),
    '--require-roots',
  );
  check('nul: FAILS on a missing required root under --require-roots', r.code, 1);
  check(
    'nul: explains which required roots went missing',
    r.out.includes('required scan root(s) missing') ? 'explained' : r.out,
    'explained',
  );
}

// `scripts` is declared but does not exist in this repository. Declared roots
// marked optional must never fail, or CI could not run with --require-roots at
// all — which is the whole point of keeping the declaration.
{
  const r = runGuard(NUL, scratchRepo({ 'README.md': '# ok\n' }), '--require-roots');
  check('nul: a missing OPTIONAL root does not fail under --require-roots', r.code, 0);
  check(
    'nul: still reports the optional root as absent',
    r.out.includes('scripts/') ? 'reported' : r.out,
    'reported',
  );
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
      // `registry_hash` stood here as an example of an ALLOWED label until #136
      // denied the whole `hash` family: truncating a hash bounds a label's
      // width, never its value set. Replaced with `executor_type`, which is
      // bounded by the executor registry and is genuinely allowed.
      `export const D = [
         { name: METRIC.a, kind: 'counter', labels: ['method', 'outcome'] },
         { name: METRIC.b, kind: 'gauge', labels: ['tool', 'executor_type'] },
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
  'cardinality: does NOT fire on the ordinary declared labels `outcome` / `error_code`',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'counter', labels: ['outcome', 'error_code'] }];\n`,
    ),
  ).code,
  0,
);

// The case the assertion above was NAMED for but never exercised. Its old title
// claimed `outcome` "contains the denied term sub" — it does not — so it
// asserted a true result for a false reason, and would not have caught the
// guard being loosened to substring matching (#39 QA).
//
// `target` really does contain `arg`, and `subject` really does contain `sub`.
check(
  'cardinality: does NOT fire on labels containing a denied term as a mere SUBSTRING',
  runGuard(
    CARDINALITY,
    scratchSource(
      'core/src/telemetry/types.ts',
      `export const D = [{ name: METRIC.a, kind: 'counter', labels: ['target', 'subject'] }];\n`,
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

// ---------------------------------------------------------------------------
// The root `typecheck` script must be able to fail (#134)
//
// This file is about guards that stop working silently, and #134 was that same
// shape one level up: `typecheck` ran `tsc --noEmit`, which does not traverse
// project references. The root tsconfig has `files: []`, so the script checked
// NOTHING — it exited 0 on a tree containing a real type error, while reading,
// in PR after PR, as evidence that types were sound.
//
// Asserted on the SCRIPT STRING rather than by running tsc, deliberately: a
// full build takes minutes and this suite is meant to be fast. What can
// realistically regress is someone restoring `--noEmit` to make the script
// quicker, and that is exactly what these two catch.
//
// Note that `tsc -b --noEmit` is NOT an available compromise: TypeScript
// rejects it here with `TS6310: Referenced project may not disable emit`,
// because a project others reference must emit the .d.ts they check against.
// Build mode is the only invocation that checks this repository at all.
{
  const rootPkg = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf-8'));
  const typecheck = rootPkg.scripts?.typecheck ?? '';

  check(
    'scripts: root typecheck uses build mode, so it can actually fail',
    /(^|\s)(-b|--build)(\s|$)/.test(typecheck) ? 'build-mode' : `NOT build mode: "${typecheck}"`,
    'build-mode',
  );
  check(
    'scripts: root typecheck does not use --noEmit, which checks nothing here',
    typecheck.includes('--noEmit') ? `uses --noEmit: "${typecheck}"` : 'no --noEmit',
    'no --noEmit',
  );
}

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
