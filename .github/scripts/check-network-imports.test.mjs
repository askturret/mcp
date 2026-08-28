#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the network-import guard (#455, closing a gap found in #431).
 *
 * Wired into `test.yml:540` with **no self-test at all** — four failure paths,
 * none of them ever executed. This is the guard standing behind the promise in
 * `docs/telemetry-policy.md` that the project makes no outbound network call
 * the adopter did not configure. If it had quietly stopped detecting them, the
 * promise would have kept being made and nothing would have checked it.
 *
 * ## Every failure site here has been observed red
 *
 * Each `WITNESS` was built by neutralising its site and confirming this file
 * turns red — verified mechanically by `check-mutation-audit.mjs`, which
 * neutralises each site in turn and requires the self-test to fail.
 *
 * Assertions labelled `CONTROL` pin behaviour that is already correct and would
 * survive their site being neutralised. Several of them matter a great deal
 * here — the allowlist and the type-only carve-out are how this guard avoids
 * crying wolf — but they are NOT evidence that a failure path works, and
 * keeping the two apart is the whole subject of #431.
 *
 * Run: node .github/scripts/check-network-imports.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check } from './check-network-imports.mjs';
import { didNotStart } from './sdk-upgrade-drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const guardPath = join(here, 'check-network-imports.mjs');

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

/** A throwaway tree laid out as `packages/<pkg>/src/...`. */
function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'network-imports-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'packages'), { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

/** One package with a single source file holding `source`. */
const oneFile = (source, rel = 'packages/core/src/index.ts') => scratch({ [rel]: source });

const violationText = (result) => result.violations.map((v) => `${v.file}:${v.line} ${v.what}`).join('\n');

/**
 * Run the guard as CI runs it, so the real exit code is observable.
 *
 * `check()` cannot witness `process.exit` — neutralise that call and every
 * in-process assertion still passes. `process.execPath` rather than `'node'`
 * because #429 was a space-separated PATH making `node` unresolvable. A child
 * that never starts FAILS this file rather than reading as a passing exit code
 * (#281, and the #443 `status: null` defect).
 */
function runGuard(rootDir) {
  const result = spawnSync(process.execPath, [guardPath, rootDir], { encoding: 'utf-8' });
  if (didNotStart(result)) {
    return { cannotCheck: true, why: `guard never started: ${result.error ? result.error.message : '(none reported)'}` };
  }
  return { cannotCheck: false, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function checkSpawned(desc, run, fn) {
  if (run.cannotCheck) {
    console.log(`FAIL - ${desc} (CANNOT CHECK — ${run.why})`);
    failed++;
    return;
  }
  fn();
}

// ---------------------------------------------------------------------------
// Site 1 — no packages/ directory
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 1 — missing packages/ directory\n');

{
  const dir = mkdtempSync(join(tmpdir(), 'network-imports-bare-'));
  tmpDirs.push(dir);
  const result = check(dir);

  check_('FAILS when there is no packages/ directory', result.code, 1);
  check_('...and says nothing was checked', result.message.includes('nothing to check'), true);
  check_(
    '...and says the guard needs updating rather than deleting',
    result.message.includes('needs updating, not deleting'),
    true,
  );
}

// ---------------------------------------------------------------------------
// Site 2 — packages/ exists but contains no src directories
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 2 — no packages/*/src to scan\n');

{
  const result = check(scratch({ 'packages/core/README.md': '# core\n' }));

  check_('FAILS when packages/ has no */src directories', result.code, 1);
  check_(
    '...and refuses to report success on a scan that examined nothing',
    result.message.includes('Refusing to report success on a scan that examined nothing'),
    true,
  );
}

// ---------------------------------------------------------------------------
// Site 3 — a file that cannot be read
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 3 — unreadable file\n');

{
  // Injected rather than provoked with chmod 000: as root that call is a no-op,
  // so a chmod-based witness would pass vacuously on exactly the CI images most
  // likely to run it (#349).
  const result = check(oneFile('export const a = 1;\n'), {
    readFile: () => {
      throw new Error('EACCES: permission denied');
    },
  });

  check_('FAILS when a source file cannot be read', result.code, 1);
  check_('...and names the file', result.message.includes('packages/core/src/index.ts'), true);
  check_('...and quotes the underlying error', result.message.includes('EACCES'), true);
}

{
  // The important half: an unreadable file must not be skipped into a green
  // result. A file the guard cannot read is a file it cannot clear.
  const dir = scratch({
    'packages/core/src/a.ts': 'export const a = 1;\n',
    'packages/core/src/b.ts': "import http from 'node:http';\n",
  });
  const result = check(dir, {
    readFile: () => {
      throw new Error('EIO');
    },
  });
  check_('an unreadable file stops the scan rather than being skipped', result.code, 1);
}

// ---------------------------------------------------------------------------
// Site 4 — network access outside the allowlist
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: site 4 — network access detected\n');

for (const mod of ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:http2']) {
  const result = check(oneFile(`import x from '${mod}';\n`));
  check_(`FAILS on a core-module import of ${mod}`, result.code, 1);
  check_(`...and names ${mod}`, violationText(result).includes(mod), true);
}

for (const mod of ['undici', 'node-fetch', 'axios', 'got', 'superagent', 'request', 'phin', 'needle']) {
  const result = check(oneFile(`import x from '${mod}';\n`));
  check_(`FAILS on a third-party HTTP client: ${mod}`, result.code, 1);
}

{
  // Submodule paths must resolve to their base package, or the ban is trivially
  // sidestepped by importing one level deeper.
  const result = check(oneFile("import x from 'undici/lib/core';\n"));
  check_('FAILS on a submodule path of a banned package', result.code, 1);
  check_("...and reports it as the base module 'undici'", violationText(result).includes("imports 'undici'"), true);
}

{
  const result = check(oneFile('export async function f() { return fetch(url); }\n'));
  check_('FAILS on a call to global fetch()', result.code, 1);
  check_('...and names it as a fetch call', violationText(result).includes('calls global fetch()'), true);
}

{
  const result = check(oneFile("import x from 'node:http';\n"));
  check_('...and emits a CI annotation', result.message.includes('::error::'), true);
  check_(
    '...and points at the policy the violation breaks',
    result.message.includes('docs/telemetry-policy.md'),
    true,
  );
  check_(
    '...and explains the type-only escape hatch',
    result.message.includes('import type'),
    true,
  );
  check_('...and reports the line number', result.violations[0].line, 1);
}

{
  const dir = scratch({
    'packages/b/src/x.ts': "import http from 'node:http';\n",
    'packages/a/src/y.ts': "import net from 'node:net';\n",
  });
  const result = check(dir);
  check_('every violation is reported, not just the first', result.violations.length, 2);
  check_('...sorted by file so the output is stable', result.violations[0].file, 'packages/a/src/y.ts');
}

// ---------------------------------------------------------------------------
// Not violations — the carve-outs that stop this guard crying wolf
// ---------------------------------------------------------------------------

console.log('\n# CONTROL: the carve-outs\n');

{
  const result = check(oneFile('export const a = 1;\n'));
  check_('a clean package passes', result.code, 0);
  check_('...and says so', result.message.includes('No network access outside the allowlist'), true);
}

{
  // Type-only imports are erased at compile time, so they are not network
  // access at all. Flagging them is what would push authors to work around the
  // guard rather than heed it.
  const result = check(oneFile("import type { Server } from 'node:http';\n"));
  check_('a type-only import is not a violation', result.code, 0);
  check_('...but it IS noted, so it stays visible', result.notes.length, 1);
  check_('...and the note explains why it is allowed', result.notes[0].why.includes('erased at compile time'), true);
}

{
  const result = check(oneFile("import http from 'node:http';\n", 'packages/transports/src/serve.ts'));
  check_('an allowlisted path may import a network module', result.code, 0);
}

{
  const result = check(oneFile("import http from 'node:http';\n", 'packages/core/src/executor/via-http.ts'));
  check_('an allowlisted FILE may import a network module', result.code, 0);
}

{
  // Listed as a single file rather than a directory on purpose, so anything
  // else added under src/audit/ still trips the guard.
  const result = check(oneFile("import http from 'node:http';\n", 'packages/core/src/audit/sinks/other.ts'));
  check_('a sibling of an allowlisted FILE is still checked', result.code, 1);
}

for (const rel of [
  'packages/core/src/__tests__/x.ts',
  'packages/core/src/x.test.ts',
  'packages/core/src/x.spec.ts',
  'packages/core/src/fixtures/x.ts',
  'packages/core/src/__mocks__/x.ts',
]) {
  const result = check(oneFile("import http from 'node:http';\n", rel));
  check_(`test-adjacent file is skipped: ${rel}`, result.code, 0);
}

{
  const result = check(oneFile("import { join } from 'node:path';\nimport x from './local.js';\n"));
  check_('non-network and relative imports are ignored', result.code, 0);
}

{
  // A comment or string mentioning a banned module must not fail the build —
  // that is how a linter earns a reputation for crying wolf.
  const result = check(oneFile("// import http from 'node:http';\nconst s = \"node:http\";\n"));
  check_('a banned module named only in a comment or string is not a violation', result.code, 0);
}

{
  const result = check(oneFile('export const f = { fetch: 1 };\nobj.fetch(x);\n'));
  check_('a property named fetch is not a global fetch() call', result.code, 0);
}

// ---------------------------------------------------------------------------
// The exit code CI reads
// ---------------------------------------------------------------------------

console.log('\n# WITNESS: the guard process exit code\n');

{
  const run = runGuard(oneFile("import http from 'node:http';\n"));
  checkSpawned('the guard PROCESS exits non-zero on a violation', run, () => {
    check_('the guard PROCESS exits non-zero on a violation', run.status, 1);
    check_('...and the annotation reaches stderr', run.stderr.includes('::error::'), true);
  });
}

{
  const run = runGuard(oneFile('export const a = 1;\n'));
  checkSpawned('CONTROL: the guard PROCESS exits 0 on a clean tree', run, () => {
    check_('CONTROL: the guard PROCESS exits 0 on a clean tree', run.status, 0);
  });
}

// ---------------------------------------------------------------------------
// The real repository
// ---------------------------------------------------------------------------

console.log('\n# this repository\n');

{
  const result = check(repoRoot);
  check_('CONTROL: the repository passes its own guard', result.code, 0);
  // A scan that collapsed to nothing would still pass; assert the coverage is
  // real so a broken walk cannot look healthy.
  check_('CONTROL: and the scan actually examined the tree', result.filesScanned > 50, true);
}

// ---------------------------------------------------------------------------

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${String(passed)} passed, ${String(failed)} failed\n`);
process.exit(failed === 0 ? 0 : 1);
