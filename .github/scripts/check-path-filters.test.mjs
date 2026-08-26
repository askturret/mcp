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

// ---------------------------------------------------------------------------
// Lane classification (#327)
//
// A real git repository, not a stubbed diff. The check answers "what does this
// PR change", and the plumbing that answers it — `git diff base...HEAD` — is
// part of what can break. Stubbing it would test the message and not the check.
// ---------------------------------------------------------------------------

const git = (dir, ...args) =>
  spawnSync('git', args, { cwd: dir, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

/**
 * A fixture whose base commit is clean and whose HEAD changes `changedPaths`,
 * built as a PR labelled `labels`.
 */
function laneFixture({ labels, changedPaths, filtersBlock, packages = { core: [] } }) {
  // `workspace` must be a declared output or the pre-existing check C fires and
  // masks what these cases are actually asserting.
  const dir = fixture(packages, filtersBlock, { outputs: [...Object.keys(packages), 'workspace'] });

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'guard@test');
  git(dir, 'config', 'user.name', 'Guard Test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');

  git(dir, 'checkout', '-q', '-b', 'pr');
  for (const rel of changedPaths) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), 'changed\n');
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'pr');

  // The payload Actions writes for a pull_request event, which every step can
  // read via GITHUB_EVENT_PATH — no workflow wiring needed.
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { labels: labels.map((name) => ({ name })) } }));

  const r = spawnSync('node', [GUARD, dir, 'main'], {
    encoding: 'utf-8',
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
  });
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const LANE_FILTERS = `            core:
              - 'packages/core/**'
            workspace:
              - 'package.json'
              - 'tsconfig.json'
              - '.github/workflows/**'`;

{
  const r = laneFixture({
    labels: ['ci:cheap'],
    changedPaths: ['.github/workflows/release.yml'],
    filtersBlock: LANE_FILTERS,
  });
  check('lane: a ci:cheap PR editing a workflow FAILS (#327)', r.code, 1);
  check('lane: ...and names the workspace filter as the reason', /filter 'workspace'/.test(r.out), true);
  check('lane: ...and teaches the capacity-gate consequence', r.out.includes('signing-runner slot'), true);
  check(
    'lane: ...and points at extending an already-wired guard as the cheap route',
    r.out.includes('EXTENDING an already-wired guard'),
    true,
  );
}

check(
  'lane: a genuinely cheap PR (docs + .operum/audit) still passes (#327)',
  laneFixture({
    labels: ['ci:cheap'],
    changedPaths: ['docs/thing.md', '.operum/audit/note.jsonl'],
    filtersBlock: LANE_FILTERS,
  }).code,
  0,
);

check(
  'lane: a ci:cheap PR touching packages/ FAILS too — same claim, same check (#327)',
  laneFixture({
    labels: ['ci:cheap'],
    changedPaths: ['packages/core/src/thing.ts'],
    filtersBlock: LANE_FILTERS,
  }).code,
  1,
);

check(
  'lane: the SAME workflow edit labelled ci:full passes — the label is the subject (#327)',
  // The paired positive. Without it, a check that failed every workflow edit
  // regardless of label would satisfy the negatives above.
  laneFixture({
    labels: ['ci:full'],
    changedPaths: ['.github/workflows/release.yml'],
    filtersBlock: LANE_FILTERS,
  }).code,
  0,
);

check(
  'lane: an UNLABELLED PR editing a workflow passes — this check polices a claim, not a change',
  laneFixture({
    labels: [],
    changedPaths: ['.github/workflows/release.yml'],
    filtersBlock: LANE_FILTERS,
  }).code,
  0,
);

check(
  'lane: trip-paths come from the FILTER CONFIG, not a hardcoded list (#327)',
  // `.github/workflows/**` is absent from this fixture's filters, so a
  // hardcoded list would still flag it. Deriving from config must not.
  laneFixture({
    labels: ['ci:cheap'],
    changedPaths: ['.github/workflows/release.yml'],
    filtersBlock: `            core:
              - 'packages/core/**'
            workspace:
              - 'package.json'`,
  }).code,
  0,
);

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

// --- the transitive closure (#282) -----------------------------------------
//
// Direct declarations are not the dependency surface. adapter-test depends on
// adapter-conformance, which depends on adapters-express, which is built from
// explorer — so an explorer change can break adapter-test's suite without
// appearing anywhere in adapter-test's manifest. The first version stopped at
// one level and left exactly that hole in three places.

const EXPLORER = '@askturret/mcp-explorer';
const MID = '@askturret/mcp-mid';

check(
  'flags a dependency reachable only through another package',
  withFixture(
    { explorer: [], mid: [EXPLORER], top: [MID] },
    `            explorer:
              - 'packages/explorer/**'
            mid:
              - 'packages/mid/**'
              - 'packages/explorer/**'
            top:
              - 'packages/top/**'
              - 'packages/mid/**'`,
  ).code,
  1,
);

check(
  'accepts it once the transitive path is listed',
  withFixture(
    { explorer: [], mid: [EXPLORER], top: [MID] },
    `            explorer:
              - 'packages/explorer/**'
            mid:
              - 'packages/mid/**'
              - 'packages/explorer/**'
            top:
              - 'packages/top/**'
              - 'packages/mid/**'
              - 'packages/explorer/**'`,
  ).code,
  0,
);

{
  const r = withFixture(
    { explorer: [], mid: [EXPLORER], top: [MID] },
    `            explorer:
              - 'packages/explorer/**'
            mid:
              - 'packages/mid/**'
              - 'packages/explorer/**'
            top:
              - 'packages/top/**'
              - 'packages/mid/**'`,
  );
  check(
    'says the dependency is TRANSITIVE rather than implying it is declared',
    r.out.includes('transitively depends on'),
    true,
  );
  check(
    'and names the route, so the maintainer is not sent to a manifest that lacks it',
    r.out.includes('via mid -> explorer'),
    true,
  );
}

check(
  'a direct dependency is still described as direct, not transitive',
  // Guards the message split: if everything were labelled transitive, the route
  // text would be noise on the common case and the distinction would be lost.
  withFixture(
    { core: [], cli: [CORE] },
    `            core:
              - 'packages/core/**'
            cli:
              - 'packages/cli/**'`,
  ).out.includes('transitively'),
  false,
);

check(
  'a dependency cycle terminates instead of hanging',
  // npm workspaces permit a cycle between packages. A plain recursive walk
  // would hang the guard rather than fail it — and a CI job that never
  // finishes is worse than one that reports wrongly, because nothing tells you
  // which it is doing. There is no cycle in this repo; the guard should not
  // depend on that staying true.
  withFixture(
    { a: ['@askturret/mcp-b'], b: ['@askturret/mcp-a'] },
    `            a:
              - 'packages/a/**'
              - 'packages/b/**'
            b:
              - 'packages/b/**'
              - 'packages/a/**'`,
  ).code,
  0,
);

check(
  'a package reached only via a cycle is still required',
  // The cycle guard must not swallow a real gap on its way past.
  withFixture(
    { a: ['@askturret/mcp-b'], b: ['@askturret/mcp-a'] },
    `            a:
              - 'packages/a/**'
            b:
              - 'packages/b/**'
              - 'packages/a/**'`,
  ).code,
  1,
);

check(
  'a package does not require a filter entry for ITSELF via a cycle',
  // `packages/a/**` is a's own entry; a self-edge reached through the cycle
  // must not demand it a second time or every cyclic package fails forever.
  withFixture(
    { a: ['@askturret/mcp-b'], b: ['@askturret/mcp-a'] },
    `            a:
              - 'packages/a/**'
              - 'packages/b/**'
            b:
              - 'packages/b/**'
              - 'packages/a/**'`,
  ).out.includes("filter 'a'"),
  false,
);

check(
  'a three-hop chain is walked all the way down',
  // Two hops could be satisfied by a fix that only looks one level further.
  withFixture(
    { d: [], c: ['@askturret/mcp-d'], b: ['@askturret/mcp-c'], a: ['@askturret/mcp-b'] },
    `            d:
              - 'packages/d/**'
            c:
              - 'packages/c/**'
              - 'packages/d/**'
            b:
              - 'packages/b/**'
              - 'packages/c/**'
              - 'packages/d/**'
            a:
              - 'packages/a/**'
              - 'packages/b/**'
              - 'packages/c/**'`,
  ).code,
  1,
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
