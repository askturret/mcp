#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the path-filter coverage guard (#213).
 *
 * The guard exists because a filter that omits a dependency produces a green
 * PR in which the affected suites never ran. A guard that silently stops
 * checking is the same failure one level up, so it is exercised here against
 * fixtures reproducing every hole it claims to catch — and, just as
 * importantly, against the near-misses that would make it cry wolf.
 *
 * The parser is hand-rolled (builtins only, no YAML dependency), so the
 * CANNOT-CHECK cases below carry real weight: they are what stops an
 * unrecognised edit being skipped rather than reported.
 *
 * Run: node .github/scripts/check-path-filters.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-path-filters.mjs');

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

/**
 * Build a fixture repo.
 *
 * @param {Record<string, string[]>} packages  dir -> first-party dep names
 * @param {string} filtersBlock                the literal `filters: |` body
 * @param {object} [opts]
 * @param {string[]} [opts.outputs]            output names the `changes` job declares
 * @param {string} [opts.extraJobs]            appended YAML, for `if:` reference tests
 */
function fixture(packages, filtersBlock, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'path-filters-'));

  for (const [name, deps] of Object.entries(packages)) {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    writeFileSync(
      join(dir, 'packages', name, 'package.json'),
      JSON.stringify({
        name: `@askturret/mcp-${name}`,
        dependencies: Object.fromEntries(deps.map((d) => [d, '*'])),
      }),
    );
  }

  const outputs = opts.outputs ?? Object.keys(packages);
  const outputLines = outputs
    .map((o) => `      ${o}: \${{ steps.filter.outputs.${o} }}`)
    .join('\n');

  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(dir, '.github', 'workflows', 'test.yml'),
    `name: Test
jobs:
  changes:
    runs-on: [self-hosted, Linux, X64, askturret]
    outputs:
${outputLines}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
${filtersBlock}
${opts.extraJobs ?? ''}`,
  );
  return dir;
}

function run(dir) {
  const r = spawnSync('node', [GUARD, dir], { encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function withFixture(...args) {
  const dir = fixture(...args);
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CORE = '@askturret/mcp-core';

// --- the hole the guard exists to catch -----------------------------------

check(
  'a dependency missing from its filter fails',
  withFixture(
    { core: [], cli: [CORE] },
    `            core:
              - 'packages/core/**'
            cli:
              - 'packages/cli/**'`,
  ).code,
  1,
);

{
  const r = withFixture(
    { core: [], cli: [CORE] },
    `            core:
              - 'packages/core/**'
            cli:
              - 'packages/cli/**'`,
  );
  check(
    'the failure names the package, the dependency and the missing glob',
    r.out.includes("filter 'cli'") &&
      r.out.includes(CORE) &&
      r.out.includes("'packages/core/**'"),
    true,
  );
}

check(
  'the same filter WITH the dependency passes',
  withFixture(
    { core: [], cli: [CORE] },
    `            core:
              - 'packages/core/**'
            cli:
              - 'packages/cli/**'
              - 'packages/core/**'`,
  ).code,
  0,
);

check(
  'every violation is reported in one pass, not just the first',
  withFixture(
    { core: [], cli: [CORE], explorer: [CORE], transports: [CORE] },
    `            core:
              - 'packages/core/**'
            cli:
              - 'packages/cli/**'
            explorer:
              - 'packages/explorer/**'
            transports:
              - 'packages/transports/**'`,
  ).out.match(/^ {2}- filter/gm)?.length,
  3,
);

// --- the same defect one level up ------------------------------------------

// Note the outputs list is non-empty but simply does not mention `core`. A
// fixture declaring NO outputs at all exercises the CANNOT-CHECK path instead
// (an outputs block with zero entries is broken, not merely incomplete), which
// is a different assertion — and is covered below.
check(
  'a filter that is not a declared output fails',
  withFixture({ core: [] }, `            core:\n              - 'packages/core/**'`, {
    outputs: ['workspace'],
  }).code,
  1,
);

check(
  'a `changes` job declaring no outputs at all is CANNOT CHECK',
  withFixture({ core: [] }, `            core:\n              - 'packages/core/**'`, {
    outputs: [],
  }).code,
  2,
);

check(
  'a job gated on an undeclared output fails',
  withFixture({ core: [] }, `            core:\n              - 'packages/core/**'`, {
    extraJobs: `  test-ghost:
    if: needs.changes.outputs.ghost == 'true'
    runs-on: [self-hosted, Linux, X64, askturret]
    steps:
      - run: npm test`,
  }).code,
  1,
);

check(
  'a filter naming no real package fails',
  withFixture(
    { core: [] },
    `            core:
              - 'packages/core/**'
            ghost:
              - 'packages/ghost/**'`,
    { outputs: ['core', 'ghost'] },
  ).code,
  1,
);

// --- cry-wolf cases: these must NOT fail -----------------------------------

check(
  'extra globs beyond the declared dependencies are allowed',
  withFixture(
    { core: [], cli: [CORE] },
    `            core:
              - 'packages/core/**'
            cli:
              - 'packages/cli/**'
              - 'packages/core/**'
              - 'examples/petstore-light/**'
              - 'docs/**'`,
  ).code,
  0,
);

check(
  'third-party dependencies are ignored',
  withFixture(
    { core: ['express', 'js-yaml'] },
    `            core:
              - 'packages/core/**'`,
  ).code,
  0,
);

check(
  'the workspace filter is exempt from the package rules',
  withFixture(
    { core: [] },
    `            core:
              - 'packages/core/**'
            workspace:
              - 'package.json'
              - '.github/workflows/**'`,
    { outputs: ['core', 'workspace'] },
  ).code,
  0,
);

check(
  'comments and blank lines inside the filters block are tolerated',
  withFixture(
    { core: [], cli: [CORE] },
    `            # leading comment
            core:
              - 'packages/core/**'

            cli:
              # why this entry exists
              - 'packages/cli/**'
              - 'packages/core/**'`,
  ).code,
  0,
);

// --- could not check is never a pass ---------------------------------------

check(
  'a missing filters block is CANNOT CHECK, not a pass',
  (() => {
    const dir = mkdtempSync(join(tmpdir(), 'path-filters-'));
    mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: CORE }),
    );
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'test.yml'), 'name: Test\njobs: {}\n');
    try {
      return run(dir).code;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })(),
  2,
);

check(
  'an unrecognised line in the filters block is CANNOT CHECK, not a skip',
  withFixture(
    { core: [] },
    `            core:
              - 'packages/core/**'
              - "packages/double-quoted/**"`,
  ).code,
  2,
);

check(
  'a list item before any filter name is CANNOT CHECK',
  withFixture({ core: [] }, `              - 'packages/core/**'`).code,
  2,
);

check(
  'a missing workflow file is CANNOT CHECK, not a pass',
  run(join(tmpdir(), 'path-filters-does-not-exist')).code,
  2,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
