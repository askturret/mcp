#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for check-doc-surfaces.mjs (#734).
 *
 * The guard it exercises exists because a guard ran in a lane its own subject
 * could not schedule. So this self-test's job is not only "does it assert the
 * right things" but "does it FAIL when the documented surface regresses" — the
 * property the original had and could not exercise where it mattered.
 *
 * ## Two conventions this follows deliberately
 *
 * SPAWNED, NEVER IMPORTED. Every case runs the guard as a subprocess against a
 * fixture tree, so what is exercised is the real entry path — argv handling,
 * exit code, and all. A self-test that imports `check()` proves the function
 * works while the script could still be broken.
 *
 * EXIT CODES ARE LOCAL LITERALS. They are declared here, not imported from the
 * guard. Importing them is #746: the constant would be compared against itself,
 * so the assertion holds no matter what the value is — including after someone
 * changes it to 0 and makes the guard stop failing.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), 'check-doc-surfaces.mjs');

// Declared here on purpose — see the header.
const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_CANNOT_CHECK = 2;

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
function checkIncludes(desc, haystack, needle) {
  if (haystack.includes(needle)) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (output did not contain ${JSON.stringify(needle)})`);
    console.log(`       got: ${JSON.stringify(haystack.slice(0, 400))}`);
    failed++;
  }
}

function run(root) {
  const r = spawnSync(process.execPath, [GUARD, root], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A README with every documented surface in its correct, current form. */
function goodReadme() {
  return [
    '# Demo',
    '',
    '```bash',
    "cat > petstore.yaml <<'YAML'",
    'openapi: 3.0.0',
    'servers:',
    '  - url: https://petstore.example.com/api/v1',
    'YAML',
    '```',
    '',
    'Save this as `server.mjs` — the extension matters.',
    '',
    '```javascript',
    'const port = Number(process.env.PORT ?? 7078);',
    'const server = app.listen(port);',
    "server.on('error', (err) => {",
    "  if (err.code !== 'EADDRINUSE') throw err;",
    '});',
    '```',
    '',
    '```bash',
    '# Your API now exposes tools over MCP.',
    'curl -X POST http://localhost:7078/mcp \\',
    "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'",
    '```',
  ].join('\n');
}

/** The surviving jest test, reduced to the marker literals check G reads. */
function goodServerTest() {
  return [
    "const PROOF_MARKER = 'Your API now exposes tools over MCP';",
    'const SPEC_HEREDOC_OPEN = "cat > petstore.yaml <<\'YAML\'";',
  ].join('\n');
}

/**
 * Build a fixture repo. `readme` and `serverTest` default to the good forms, so
 * each case below mutates exactly one thing and the rest stays valid — a case
 * that failed for two reasons at once would not prove which one it detects.
 */
function fixture({ readme = goodReadme(), serverTest = goodServerTest(), extraDocs = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-surfaces-'));
  if (readme !== null) writeFileSync(join(dir, 'README.md'), readme, 'utf8');
  if (serverTest !== null) {
    const testDir = join(dir, 'packages/adapters-express/src/__tests__');
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'readme-quickstart.test.ts'), serverTest, 'utf8');
  }
  for (const [rel, body] of Object.entries(extraDocs)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return dir;
}

const created = [];
function fx(opts) {
  const d = fixture(opts);
  created.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// The clean case. If this is not green, every red below is uninterpretable.
// ---------------------------------------------------------------------------
{
  const r = run(fx());
  check('a correct tree passes', r.code, EXIT_OK);
  checkIncludes('...and says so', r.out, 'check-doc-surfaces: OK');
}

// ---------------------------------------------------------------------------
// The #716 regression itself: the proof command reverted to the GET form.
// This is the defect the guard exists for, so it is asserted as a whole
// message rather than only as an exit code.
// ---------------------------------------------------------------------------
{
  const readme = goodReadme().replace(
    "curl -X POST http://localhost:7078/mcp \\\n  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'",
    'curl http://localhost:7078/mcp/tools/list',
  );
  // The mutation must LAND — a replace that silently matched nothing would
  // leave the good README in place and this case would pass for the wrong
  // reason. That is the trap TESTING.md names as mutation-application variant 2.
  if (readme === goodReadme()) {
    console.log('FAIL - the GET-form mutation did not apply to the fixture');
    failed++;
  }
  const r = run(fx({ readme }));
  check('the pre-#716 GET form fails', r.code, EXIT_VIOLATION);
  checkIncludes('...naming the missing POST', r.out, 'does not POST');
  checkIncludes('...naming the URL-path form', r.out, '`/mcp/tools/list` as a URL path');
  checkIncludes('...and the absent JSON-RPC payload', r.out, 'no parseable -d JSON payload');
}

// ---------------------------------------------------------------------------
// Each remaining assertion, one mutation at a time.
// ---------------------------------------------------------------------------
{
  const r = run(fx({ readme: goodReadme().replace('"method":"tools/list"', '"method":"tools/call"') }));
  check('a documented body calling the wrong method fails', r.code, EXIT_VIOLATION);
  checkIncludes('...naming it', r.out, 'does not call tools/list');
}
{
  const r = run(fx({ readme: goodReadme().replace('"jsonrpc":"2.0"', '"jsonrpc":"1.0"') }));
  check('a documented body that is not JSON-RPC 2.0 fails', r.code, EXIT_VIOLATION);
}
{
  const r = run(fx({ readme: goodReadme().replace('servers:\n', '') }));
  check('an inlined spec with no servers: entry fails', r.code, EXIT_VIOLATION);
  checkIncludes('...explaining the consequence', r.out, 'cannot resolve an upstream');
}
{
  const r = run(fx({ readme: goodReadme().replace("if (err.code !== 'EADDRINUSE') throw err;", 'throw err;') }));
  check('a server snippet that does not handle EADDRINUSE fails', r.code, EXIT_VIOLATION);
}
{
  const r = run(fx({ readme: goodReadme().replace('const port = Number(process.env.PORT ?? 7078);', 'const port = 7078;') }));
  check('a server snippet with no PORT override fails', r.code, EXIT_VIOLATION);
}
{
  // The express-5 trap: `app.listen(port, cb)` also calls cb on a FAILED bind.
  const r = run(fx({ readme: goodReadme().replace('app.listen(port);', "app.listen(port, () => console.log('up'));") }));
  check('a listen callback that logs success fails', r.code, EXIT_VIOLATION);
  checkIncludes('...naming why', r.out, 'FAILED bind');
}

// ---------------------------------------------------------------------------
// The repo-wide sweeps. These are the reason the guard's subject is EVERY
// markdown file rather than README.md alone, so both are exercised on a file
// that is NOT the README — the case no path filter covered (#734).
// ---------------------------------------------------------------------------
{
  const r = run(fx({ extraDocs: { 'docs/readiness.md': 'Try http://localhost:7000/mcp today.' } }));
  check('the port-7000 form in docs/ fails', r.code, EXIT_VIOLATION);
  checkIncludes('...naming the offending file', r.out, 'docs/readiness.md');
}
{
  const r = run(fx({ extraDocs: { 'docs/guide.md': 'GET /mcp/tools/call works.' } }));
  check('the URL-path form in docs/ fails', r.code, EXIT_VIOLATION);
  checkIncludes('...naming the offending file', r.out, 'docs/guide.md');
}
{
  // Prose ABOUT port 7000 is legitimate and is exactly what the README uses to
  // explain why the default moved. A guard that forbade its own documentation
  // would be unusable — the same shape that bit PR #740.
  const r = run(fx({ extraDocs: { 'docs/why.md': 'macOS AirPlay holds port 7000, so the default is 7078.' } }));
  check('prose about port 7000 is allowed', r.code, EXIT_OK);
}
{
  // Likewise the bare JSON-RPC method name, which appears throughout the docs.
  const r = run(fx({ extraDocs: { 'docs/api.md': 'Call the `tools/list` method over POST.' } }));
  check('the bare tools/list method name is allowed', r.code, EXIT_OK);
}
{
  const r = run(fx({ extraDocs: { 'node_modules/vendor/README.md': 'See http://localhost:7000/mcp' } }));
  check('vendored markdown is not policed', r.code, EXIT_OK);
}

// ---------------------------------------------------------------------------
// Structural anchors. A reworded README must fail LOUDLY rather than leave the
// guard checking an empty string — a guard that silently stops asserting is
// the failure mode this whole issue is about.
// ---------------------------------------------------------------------------
{
  const r = run(fx({ readme: goodReadme().replace('# Your API now exposes tools over MCP.', '# Behold.') }));
  check('a reworded proof marker fails', r.code, EXIT_VIOLATION);
  checkIncludes('...telling the author to update the constant', r.out, 'update PROOF_MARKER');
}
{
  const r = run(fx({ readme: goodReadme().replace("cat > petstore.yaml <<'YAML'", 'cat > spec.yaml <<EOF') }));
  check('a reworded spec heredoc fails', r.code, EXIT_VIOLATION);
  checkIncludes('...and refuses deletion as the remedy', r.out, 'do NOT delete this check');
}
{
  const r = run(fx({ readme: goodReadme().replace('Save this as `server.mjs` — the extension matters.', 'Now the server.') }));
  check('a reworded server marker fails', r.code, EXIT_VIOLATION);
}
{
  const r = run(fx({ readme: null }));
  check('a tree with no README cannot be checked', r.code, EXIT_CANNOT_CHECK);
  checkIncludes('...and says CANNOT CHECK rather than passing', r.out, 'CANNOT CHECK');
}

// ---------------------------------------------------------------------------
// Check G — the drift guard the split creates. Both files parse the same
// README, so a marker reworded in one and not the other must fail here rather
// than throwing later on whichever PR happens to schedule the jest test.
// ---------------------------------------------------------------------------
{
  const r = run(fx({ serverTest: "const PROOF_MARKER = 'Behold, tools';" }));
  check('a server test that stopped anchoring on SPEC_HEREDOC_OPEN fails', r.code, EXIT_VIOLATION);
  checkIncludes('...naming the drift', r.out, 'no longer anchors on SPEC_HEREDOC_OPEN');
}
{
  const r = run(fx({ serverTest: null }));
  check('deleting the server test fails', r.code, EXIT_VIOLATION);
  checkIncludes('...explaining what it held', r.out, 'server-mounting half');
}

for (const d of created) rmSync(d, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
