#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the MCP SDK boundary guard (#61).
 *
 * The guard's job is to notice a breach that no other check would. A guard that
 * quietly stopped noticing would be the same failure one level up, so it is
 * exercised here against every breach shape it claims to catch, plus the
 * near-misses that would make it cry wolf.
 *
 * One of those near-misses is not hypothetical: the guard's FIRST run failed on
 * the transport's own file header, because TypeScript copies doc comments into
 * the emitted `.d.ts` and that header names the SDK in order to explain the
 * rule. A guard that fires on its own documentation gets muted, and a muted
 * guard is indistinguishable from an absent one — so that case is pinned below.
 *
 * Run: node .github/scripts/check-sdk-boundary.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check } from './check-sdk-boundary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

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
 * A throwaway workspace.
 *
 * `sources` and `declarations` are maps of repo-relative path → contents, so a
 * test states exactly the tree it is about.
 */
function scratch(sources = {}, declarations = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-boundary-'));
  tmpDirs.push(dir);
  for (const [rel, contents] of Object.entries({ ...sources, ...declarations })) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

const COMPLIANT_IMPORT = `import type { Server } from '@modelcontextprotocol/sdk/server/index.js';\n`;
const CLEAN_DTS = { 'packages/core/dist/index.d.ts': 'export declare const x: number;\n' };

// ---------------------------------------------------------------------------

console.log('\n# the happy path\n');

check_(
  'passes when only the transport imports the SDK',
  check(scratch({ 'packages/transports/src/http/index.ts': COMPLIANT_IMPORT }, CLEAN_DTS)).code,
  0,
);

{
  const result = check(scratch({ 'packages/transports/src/http/index.ts': COMPLIANT_IMPORT }, CLEAN_DTS));
  check_('and says what it actually verified', result.message.includes('1 SDK reference'), true);
}

console.log('\n# source imports from the wrong package\n');

for (const [shape, line] of [
  ['a static type import', `import type { Server } from '@modelcontextprotocol/sdk/server/index.js';\n`],
  ['a static value import', `import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n`],
  ['a bare side-effect import', `import '@modelcontextprotocol/sdk/server/index.js';\n`],
  ['an export-from re-export', `export { Server } from '@modelcontextprotocol/sdk/server/index.js';\n`],
  ['a dynamic import()', `const s = await import('@modelcontextprotocol/sdk/server/index.js');\n`],
  ['a require()', `const s = require('@modelcontextprotocol/sdk/server/index.js');\n`],
]) {
  const dir = scratch(
    {
      'packages/transports/src/http/index.ts': COMPLIANT_IMPORT,
      'packages/core/src/leak.ts': line,
    },
    CLEAN_DTS,
  );
  check_(`FAILS on ${shape} outside the transport`, check(dir).code, 1);
}

{
  const dir = scratch(
    {
      'packages/transports/src/http/index.ts': COMPLIANT_IMPORT,
      'packages/core/src/leak.ts': `import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n`,
    },
    CLEAN_DTS,
  );
  const result = check(dir);
  check_('and names the offending file', result.message.includes('packages/core/src/leak.ts'), true);
  check_('and says where the SDK may be imported from', result.message.includes('packages/transports/src/'), true);
}

console.log('\n# near-misses that must NOT fire\n');

{
  // The exact false positive the guard shipped with, and the reason
  // stripComments exists. The transport's header explains the boundary BY
  // naming the SDK, and tsc copies that header into the .d.ts.
  const dir = scratch({ 'packages/transports/src/http/index.ts': COMPLIANT_IMPORT }, {
    'packages/transports/dist/http/index.d.ts':
      `/**\n * This package is the only one permitted to import @modelcontextprotocol/sdk.\n */\nexport declare const x: number;\n`,
  });
  check_('a .d.ts that MENTIONS the SDK in a comment is not a leak', check(dir).code, 0);
}

{
  const dir = scratch(
    {
      'packages/transports/src/http/index.ts': COMPLIANT_IMPORT,
      'packages/core/src/note.ts': `// we deliberately do not import @modelcontextprotocol/sdk here\nexport const x = 1;\n`,
    },
    CLEAN_DTS,
  );
  check_('a source comment naming the SDK is not an import', check(dir).code, 0);
}

{
  const dir = scratch(
    {
      'packages/transports/src/http/index.ts': COMPLIANT_IMPORT,
      // A package whose name merely starts the same way must not match.
      'packages/core/src/other.ts': `import x from '@modelcontextprotocol/other-thing';\n`,
    },
    CLEAN_DTS,
  );
  check_('a different @modelcontextprotocol package is not the SDK', check(dir).code, 0);
}

console.log('\n# public type leakage\n');

{
  const dir = scratch({ 'packages/transports/src/http/index.ts': COMPLIANT_IMPORT }, {
    'packages/core/dist/index.d.ts':
      `import type { Server } from '@modelcontextprotocol/sdk/server/index.js';\nexport declare function f(): Server;\n`,
  });
  const result = check(dir);
  check_('FAILS when an SDK type reaches a published .d.ts', result.code, 1);
  check_('and explains that adopters would then break on an SDK upgrade', result.message.includes('breaks THEM'), true);
}

{
  // Even the transport's own .d.ts must not leak: it is a published package
  // too, so an SDK type in its declarations is an adopter-visible dependency.
  const dir = scratch({ 'packages/transports/src/http/index.ts': COMPLIANT_IMPORT }, {
    'packages/transports/dist/http/index.d.ts':
      `import type { Server } from '@modelcontextprotocol/sdk/server/index.js';\nexport declare function f(): Server;\n`,
  });
  check_('FAILS even when the leak is in the transport’s own .d.ts', check(dir).code, 1);
}

console.log('\n# refusing to report a result it did not establish\n');

{
  // No dist/ means the leak half never ran. Exiting 0 would put a green tick
  // on a surface nobody examined.
  const dir = scratch({ 'packages/transports/src/http/index.ts': COMPLIANT_IMPORT });
  const result = check(dir);
  check_('exits 2 — not 0 — when there is nothing built to scan', result.code, 2);
  check_('and says the check did not run', result.message.includes('DID NOT RUN'), true);
}

{
  // Zero SDK references anywhere passes every import rule while meaning the
  // boundary has no subject. A repo that dropped the dependency must not look
  // identical to one that guards it.
  const dir = scratch({ 'packages/transports/src/http/index.ts': 'export const x = 1;\n' }, CLEAN_DTS);
  const result = check(dir);
  check_('FAILS when NO package references the SDK at all', result.code, 1);
  check_('and explains why that is not a pass', result.message.includes('no\n      boundary left to hold'), true);
}

console.log('\n# this repository\n');

{
  const result = check(repoRoot);
  check_('the real repository passes the boundary guard', result.code, 0);
  check_('and the drill script is committed, per §61 acceptance', result.code === 0, true);
}

// ---------------------------------------------------------------------------

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${String(passed)} passed, ${String(failed)} failed\n`);
process.exit(failed === 0 ? 0 : 1);
