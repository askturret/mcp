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
import { spawnSync } from 'node:child_process';
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
/* ---------------------------------------------------------------------------
 * Lane classification (#327)
 *
 * `ci:cheap` is not a preference, it is a claim: "this change schedules no
 * package suite, so it contends on nothing." The gate believes that claim —
 * `ci:cheap` PRs are EXEMPT from the sequential-PR capacity check — so a
 * mislabelled one consumes a signing-runner slot the gate thinks is free
 * (#3908/#5196). A gate that reads as enforced and silently is not.
 *
 * The discriminator is the PATH TOUCHED, not the kind of change. "Adds a guard
 * => ci:full" is the tempting generalisation and it is WRONG: PR #342 added a
 * whole per-file check and was genuinely cheap, because it EXTENDED a guard
 * already wired into the workflow and so edited no workflow file.
 *
 * Trip-paths are read from the filters block this guard already parses, never
 * hardcoded. A second copy of that list would drift from the filters it mirrors
 * — the same defect one level down from the one this file exists to catch.
 * ------------------------------------------------------------------------- */

const CHEAP_LABEL = 'ci:cheap';

/**
 * The labels on the PR being built, or null when this is not a PR run.
 *
 * Read from `GITHUB_EVENT_PATH`, which Actions sets for EVERY step — so this
 * needs no workflow change to obtain. That matters here more than usual: a new
 * workflow step to pass labels in would have tripped the very filter this check
 * exists to police, making the fix `ci:full` and self-contradicting.
 */
function pullRequestLabels() {
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  if (eventPath === undefined || eventPath === '' || !existsSync(eventPath)) return null;

  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, 'utf-8'));
  } catch {
    return null; // not a payload we understand; the other checks still run
  }

  const pr = event?.pull_request;
  if (pr === undefined || pr === null) return null; // push build, not a PR

  const labels = Array.isArray(pr.labels) ? pr.labels : [];
  return labels
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n) => typeof n === 'string');
}

/** Files this PR changes against its base, or null when that cannot be determined. */
function changedFiles(baseRef) {
  const r = spawnSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Does one `dorny/paths-filter` glob match this path?
 *
 * Only the two shapes the filters block actually uses: a literal path, and a
 * `dir/**` prefix. Anything else would be silently mismatched, so it is refused
 * rather than guessed at.
 */
function globMatches(glob, file) {
  if (glob.endsWith('/**')) return file.startsWith(`${glob.slice(0, -3)}/`);
  if (glob.includes('*')) {
    cannotCheck(`filters use an unsupported glob shape '${glob}' — the lane check cannot match it`);
  }
  return file === glob;
}

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

// E: a `ci:cheap` PR that trips any filter is mislabelled (#327).
//
// Only runs on a labelled pull_request build; a push build and a local run have
// no label to check, and inventing one would be worse than saying nothing.
const labels = pullRequestLabels();
if (labels !== null && labels.includes(CHEAP_LABEL)) {
  const baseRef =
    process.argv[3] ??
    (process.env['GITHUB_BASE_REF'] ? `origin/${process.env['GITHUB_BASE_REF']}` : 'origin/main');

  const changed = changedFiles(baseRef);
  if (changed === null) {
    // The lane claim cannot be checked, and an unverifiable claim is not a
    // verified one. Same rule the rest of this file follows.
    cannotCheck(
      `could not diff against '${baseRef}' to classify the lane — a shallow checkout will do this; ` +
        'the guards job uses fetch-depth: 0 for exactly this reason',
    );
  }

  const tripped = [];
  for (const [name, globs] of Object.entries(filters)) {
    const hits = changed.filter((file) => globs.some((glob) => globMatches(glob, file)));
    if (hits.length > 0) tripped.push({ name, hits });
  }

  if (tripped.length > 0) {
    const detail = tripped
      .map(({ name, hits }) => `filter '${name}' <- ${hits.slice(0, 4).join(', ')}${hits.length > 4 ? `, +${hits.length - 4} more` : ''}`)
      .join('; ');

    violations.push(
      `this PR is labelled \`${CHEAP_LABEL}\` but changes paths that trip ${tripped.length} ` +
        `path filter(s): ${detail}. Every package test job gates on \`<pkg> || workspace\`, so those ` +
        'suites are scheduled and the change is not cheap. `ci:cheap` PRs are EXEMPT from the ' +
        'sequential-PR capacity gate, so a mislabelled one consumes a signing-runner slot the gate ' +
        'believes is free (#3908/#5196). Either relabel to `ci:full`, or avoid the tripping path — ' +
        'note that EXTENDING an already-wired guard needs no workflow edit and stays genuinely cheap, ' +
        'which is why #342 was cheap while #326 was not',
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
