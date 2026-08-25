#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The per-package CI path filters cover what each package actually depends on (#213).
 *
 * test.yml schedules each package's suite only when its path filter matches. A
 * filter that omits a dependency therefore produces a GREEN pull request in
 * which the packages affected by the change were never scheduled to run — the
 * #110/#121 family: a check that looks protective and has a hole nothing
 * surfaces.
 *
 * When #213 was filed, 7 packages were missing `packages/core/**`. By the time
 * it was implemented only 5 still were, because #153 had fixed two in passing.
 * Nothing noticed either the original hole or its partial repair; both were
 * found by reading the file. That is the argument for asserting it instead.
 *
 * What is checked, all against source manifests (no install required):
 *
 *   A. Every filter names a real package directory.
 *   B. Every first-party dependency of that package appears in its filter.
 *   C. Every filter is exposed as an output of the `changes` job.
 *   D. Every `needs.changes.outputs.X` reference resolves to a declared output.
 *
 * C and D are the same defect one level up: a job gated on an output that does
 * not exist reads as falsy forever, so the job silently never runs and CI stays
 * green. Cheap to assert while the file is already parsed.
 *
 * NOT checked: whether every package has a dedicated test job. `packages/examples`
 * has no filter and no `test-examples` job. Its suite is not unrun — the
 * test-execution guard (#79) invokes every package's test command from
 * test-integrity, so it does execute — but it is outside the per-package
 * scheduling this guard reasons about, so there is no filter to check it
 * against. Asserting job existence here would make the guard red on arrival for
 * a reason unrelated to dependency coverage.
 *
 * Exit codes: 0 pass, 1 violations found, 2 could not check.
 *
 * `2` matters as much as `1`. A guard that cannot parse its input and exits 0
 * is indistinguishable in a CI log from one that checked and found nothing —
 * which is how the holes above survived. "Could not check" is never "passed".
 *
 * Deliberately uses only Node builtins, so it needs no install to be
 * trustworthy — the same reasoning the readiness-matrix gate states. The YAML
 * it reads is one file in this repository with a known shape, and the parser
 * below REFUSES anything it does not recognise rather than skipping it, so an
 * unexpected edit cannot quietly reduce what is covered.
 *
 * Run: node .github/scripts/check-path-filters.mjs [repoRoot]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Workspace packages are first-party. Kept in step with the supply-chain lib. */
const FIRST_PARTY_SCOPE = '@askturret/';

const repoRoot = resolve(
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
);
const workflowPath = join(repoRoot, '.github', 'workflows', 'test.yml');

/** Exit 2: the guard could not answer. Never conflate this with a pass. */
function cannotCheck(message) {
  console.error(`check-path-filters: CANNOT CHECK — ${message}`);
  process.exit(2);
}

/**
 * Extract the block scalar that follows `filters: |`.
 *
 * Returns the block's lines, dedented. Refuses rather than guesses: a missing
 * or empty block means the filters moved, and silently checking nothing is the
 * failure this guard exists to prevent.
 */
function extractFiltersBlock(text) {
  const lines = text.split('\n');
  const startIdx = lines.findIndex((l) => /^\s*filters:\s*\|\s*$/.test(l));
  if (startIdx === -1) cannotCheck(`no \`filters: |\` block found in ${workflowPath}`);

  const headerIndent = lines[startIdx].match(/^(\s*)/)[1].length;
  const body = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= headerIndent) break; // block ended
    body.push(line);
  }

  const nonBlank = body.filter((l) => l.trim() !== '');
  if (nonBlank.length === 0) cannotCheck('the `filters: |` block is empty');

  const base = Math.min(...nonBlank.map((l) => l.match(/^(\s*)/)[1].length));
  return body.map((l) => (l.trim() === '' ? '' : l.slice(base)));
}

/**
 * Parse the dedented filters block into `{ name: [glob, ...] }`.
 *
 * Every line must match one of the four recognised shapes. Anything else is a
 * CANNOT CHECK — a parser that skips what it does not understand would let an
 * edit remove coverage without the guard noticing.
 */
function parseFilters(blockLines) {
  const filters = {};
  let current = null;

  blockLines.forEach((line, n) => {
    if (line.trim() === '' || /^\s*#/.test(line)) return;

    const key = line.match(/^([A-Za-z0-9._-]+):\s*$/);
    if (key) {
      current = key[1];
      filters[current] = [];
      return;
    }

    const item = line.match(/^\s+-\s+'([^']+)'\s*$/);
    if (item) {
      if (current === null) {
        cannotCheck(`filters block line ${n + 1} is a list item before any filter name`);
      }
      filters[current].push(item[1]);
      return;
    }

    cannotCheck(
      `unrecognised line in the filters block (line ${n + 1}): ${JSON.stringify(line)}`,
    );
  });

  if (Object.keys(filters).length === 0) cannotCheck('parsed zero filters');
  return filters;
}

/** Outputs declared by the `changes` job, e.g. `core: ${{ steps.filter.outputs.core }}`. */
function parseChangesOutputs(text) {
  const lines = text.split('\n');
  const outputsIdx = lines.findIndex((l) => /^\s*outputs:\s*$/.test(l));
  if (outputsIdx === -1) cannotCheck('no `outputs:` block found for the `changes` job');

  const headerIndent = lines[outputsIdx].match(/^(\s*)/)[1].length;
  const names = new Set();
  for (let i = outputsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (line.match(/^(\s*)/)[1].length <= headerIndent) break;

    const m = line.match(/^\s*([A-Za-z0-9._-]+):\s*\$\{\{\s*steps\.filter\.outputs\.([A-Za-z0-9._-]+)\s*\}\}\s*$/);
    if (!m) cannotCheck(`unrecognised line in the \`changes\` outputs block: ${JSON.stringify(line)}`);
    names.add(m[1]);
  }
  if (names.size === 0) cannotCheck('the `changes` job declares no outputs');
  return names;
}

/** Map first-party package name -> directory name under packages/. */
function packageIndex() {
  const packagesDir = join(repoRoot, 'packages');
  if (!existsSync(packagesDir)) cannotCheck(`no packages/ directory under ${repoRoot}`);

  const byName = new Map();
  const dirs = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifest, 'utf-8'));
    } catch (err) {
      cannotCheck(`packages/${entry.name}/package.json is not valid JSON: ${err.message}`);
    }
    if (typeof pkg.name !== 'string') {
      cannotCheck(`packages/${entry.name}/package.json has no "name"`);
    }
    byName.set(pkg.name, entry.name);
    dirs.push(entry.name);
  }
  if (dirs.length === 0) cannotCheck('found no packages under packages/');
  return { byName, dirs };
}

/** DIRECTLY declared first-party dependencies, across all dependency scopes. */
function directDeps(dir, byName) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages', dir, 'package.json'), 'utf-8'));
  const all = {};
  for (const scope of ['dependencies', 'peerDependencies', 'devDependencies']) {
    Object.assign(all, pkg[scope] ?? {});
  }
  return Object.keys(all)
    .filter((n) => n.startsWith(FIRST_PARTY_SCOPE) && byName.has(n))
    .sort();
}

/**
 * Every first-party package reachable from `dir`, not just its direct ones (#282).
 *
 * Direct declarations are not the dependency surface. `adapter-test` depends on
 * `adapter-conformance`, which depends on `adapters-express`, which is built
 * from `explorer` — so an explorer-only change can break the adapter-test suite
 * without appearing anywhere in adapter-test's own manifest. Stopping at direct
 * deps left three such holes, and they are invisible in exactly the way the
 * original #213 holes were: the filter looks thorough, and the job simply does
 * not run.
 *
 * The filters' own comments already asked for this — `adapter-conformance` says
 * it must re-run "when the shared machinery underneath them" changes. Underneath
 * is transitive; the first implementation read it as one level.
 *
 * `seen` is a cycle guard, not an optimisation. npm workspaces permit a
 * dependency cycle between packages, and a plain recursive walk would hang the
 * guard rather than fail it — a CI job that never finishes is worse than one
 * that reports wrongly, because nothing tells you which it is doing. There is
 * no cycle today; this costs nothing and removes the failure mode.
 *
 * `dir` itself is excluded: `packages/<dir>/**` is the filter's own entry, and
 * a self-edge would demand it twice.
 */
function transitiveDeps(dir, byName, cache) {
  const cached = cache.get(dir);
  if (cached !== undefined) return cached;

  // Traversal is in DIRECTORY space, because that is what a manifest is read
  // by and what a path filter is written in. `directDeps` yields npm names, so
  // each hop converts; mixing the two silently reads the wrong manifest.
  const toDir = (npmName) => byName.get(npmName);

  const seen = new Set();
  const stack = directDeps(dir, byName).map(toDir);

  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || next === dir || seen.has(next)) continue;
    seen.add(next);
    stack.push(...directDeps(next, byName).map(toDir));
  }

  const result = [...seen].sort();
  cache.set(dir, result);
  return result;
}

/**
 * The shortest dependency route from `from` to `to`, for the error message.
 *
 * A guard that says `adapter-test` depends on `explorer` sends the maintainer
 * to a package.json that does not mention it, where the obvious conclusion is
 * that the guard is broken. Naming the hop — `adapter-conformance ->
 * adapters-express -> explorer` — turns a confusing report into an actionable
 * one, and lets a reader disagree with the guard on the evidence.
 *
 * Breadth-first, so the route printed is the shortest rather than whichever the
 * depth-first walk happened to take.
 */
function describeRoute(from, to, byName) {
  const queue = [[from]];
  const visited = new Set([from]);

  while (queue.length > 0) {
    const path = queue.shift();
    const tail = path[path.length - 1];

    for (const npmName of directDeps(tail, byName)) {
      const dir = byName.get(npmName);
      if (dir === undefined || visited.has(dir)) continue;
      if (dir === to) return [...path.slice(1), to].join(' -> ');
      visited.add(dir);
      queue.push([...path, dir]);
    }
  }

  // Unreachable in practice: only called for members of the closure. Falling
  // back to a bare name beats asserting a route that was not found.
  return to;
}

// ---------------------------------------------------------------------------

if (!existsSync(workflowPath)) cannotCheck(`${workflowPath} does not exist`);
const workflowText = readFileSync(workflowPath, 'utf-8');

const filters = parseFilters(extractFiltersBlock(workflowText));
const declaredOutputs = parseChangesOutputs(workflowText);
const { byName, dirs } = packageIndex();

/** Shared across filters — a hub package's closure is recomputed otherwise. */
const closureCache = new Map();

/** Directory -> npm name, so a violation can name both. */
const dirToName = new Map([...byName].map(([npmName, dir]) => [dir, npmName]));

const violations = [];

for (const [name, globs] of Object.entries(filters)) {
  // C: a filter with no matching output can never gate anything.
  if (!declaredOutputs.has(name)) {
    violations.push(`filter '${name}' is not exposed as an output of the \`changes\` job`);
  }

  // `workspace` is a repo-wide filter, not a package. It has no dependencies.
  if (name === 'workspace') continue;

  // A: a filter naming no real package is dead config.
  if (!dirs.includes(name)) {
    violations.push(`filter '${name}' does not correspond to any packages/<dir>`);
    continue;
  }

  // B: the #213 invariant, over the TRANSITIVE closure since #282.
  const direct = new Set(directDeps(name, byName).map((n) => byName.get(n)));

  for (const depDir of transitiveDeps(name, byName, closureCache)) {
    const required = `packages/${depDir}/**`;
    if (globs.includes(required)) continue;

    // Both vocabularies, deliberately: the npm name is what the manifest
    // declares and what a maintainer greps for, the directory is what the
    // filter is written in. Reporting only one leaves them a translation step.
    const depName = dirToName.get(depDir) ?? depDir;

    // Naming the route matters for a transitive hit. A maintainer told only
    // that `adapter-test` depends on explorer will look in its package.json,
    // fail to find it, and reasonably conclude the guard is wrong.
    const how = direct.has(depDir)
      ? `depends on ${depName}`
      : `transitively depends on ${depName} (via ${describeRoute(name, depDir, byName)})`;

    violations.push(
      `filter '${name}' ${how} but does not include '${required}' — ` +
        `a change to ${depName} would not re-run ${name}'s tests`,
    );
  }
}

// D: a job gated on an undeclared output is a job that never runs.
for (const match of workflowText.matchAll(/needs\.changes\.outputs\.([A-Za-z0-9._-]+)/g)) {
  if (!declaredOutputs.has(match[1])) {
    violations.push(
      `workflow references needs.changes.outputs.${match[1]}, which the \`changes\` job does not declare — ` +
        `that expression is always falsy, so the job it gates never runs`,
    );
  }
}

if (violations.length > 0) {
  console.error('check-path-filters: FAIL\n');
  // Report every violation: fixing them one CI run at a time is its own cost.
  for (const v of [...new Set(violations)].sort()) console.error(`  - ${v}`);
  console.error(
    `\n${violations.length} problem(s). Add the missing path(s) to the filter in ` +
      `.github/workflows/test.yml so the affected suites re-run.`,
  );
  process.exit(1);
}

console.log(
  `check-path-filters: OK — ${Object.keys(filters).length} filters, ` +
    `${dirs.length} packages, every declared first-party dependency is covered.`,
);
