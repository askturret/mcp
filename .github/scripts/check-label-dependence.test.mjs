#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the label-dependence registry guard (#565).
 *
 * BOTH DIRECTIONS ARE WITNESSED, and the second is the one that decays:
 *
 *   direction 1  a label-dependent site appears and is not declared
 *   direction 2  a declared entry's file is DELETED, stops branching on a
 *                label, or names a label the file does not contain
 *
 * Direction 2 is why this guard exists at all. `check-path-filters.mjs` states
 * in prose that lane-check.yml "will refuse it", and before this the suite
 * asserted only that the STRING appeared — so deleting lane-check.yml, or
 * typoing `ci:cheap` inside it, left everything green while the promise became
 * false. Those two exact mutations are cases below.
 *
 * The cannot-check arms are exercised rather than coded: a registry that cannot
 * be read must exit 2, never 0, or this guard becomes another green that
 * compared nothing.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { workflowIsLabelDependent, scriptIsLabelDependent, EXIT_OK, EXIT_DIVERGENCE, EXIT_CANNOT_CHECK } from './check-label-dependence.mjs';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-label-dependence.mjs');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed += 1;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed += 1;
  }
}

const DEPENDENT_WORKFLOW = `name: Lane check
on:
  pull_request:
    types: [labeled]
jobs:
  lane-claim:
    if: contains(github.event.pull_request.labels.*.name, 'ci:cheap')
    runs-on: [self-hosted]
    steps:
      - run: node .github/scripts/check-path-filters.mjs .
`;

const PLAIN_WORKFLOW = `name: Plain
on:
  pull_request:
    branches: [main]
jobs:
  build:
    runs-on: [self-hosted]
    steps:
      - run: echo hi
`;

const DEPENDENT_SCRIPT = `const p = process.env['GITHUB_EVENT_PATH'];\nconst ls = ev.pull_request.labels;\nif (ls.includes('ci:cheap')) {}\n`;
const PLAIN_SCRIPT = `console.log('no labels here');\n`;

/** A throwaway .github tree plus a registry. */
function fixture({ workflows = {}, scripts = {}, registry }) {
  const dir = mkdtempSync(join(tmpdir(), 'label-dep-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.github', 'scripts'), { recursive: true });
  for (const [name, body] of Object.entries(workflows)) writeFileSync(join(dir, '.github', 'workflows', name), body);
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(dir, '.github', 'scripts', name), body);
  if (registry !== undefined) {
    writeFileSync(
      join(dir, '.github', 'label-dependent-checks.json'),
      typeof registry === 'string' ? registry : JSON.stringify(registry, null, 2),
    );
  }
  return dir;
}

const entryFor = (path, label = 'ci:cheap') => ({
  id: `x:${path}`,
  kind: path.endsWith('.mjs') ? 'script' : 'workflow',
  path,
  label,
  behaviour: 'declared for the test',
  sampling: 'declared for the test',
});

function runGuard(dir) {
  const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const AGREEING = () => ({
  workflows: { 'lane-check.yml': DEPENDENT_WORKFLOW, 'plain.yml': PLAIN_WORKFLOW },
  scripts: { 'dep.mjs': DEPENDENT_SCRIPT, 'plain.mjs': PLAIN_SCRIPT },
  registry: { checks: [entryFor('.github/workflows/lane-check.yml'), entryFor('.github/scripts/dep.mjs')] },
});

// --------------------------------------------------------------------------
// The agreeing baseline. Without this every FAIL below is consistent with a
// guard that simply always fails.
// --------------------------------------------------------------------------
{
  const r = runGuard(fixture(AGREEING()));
  check('registry and tree agree -> exit 0', r.code, EXIT_OK);
  check('...and says how many it compared', r.out.includes('2 declared'), true);
}

// --------------------------------------------------------------------------
// DIRECTION 1 — an undeclared label-dependent site.
// --------------------------------------------------------------------------
{
  const spec = AGREEING();
  spec.workflows['sneaky.yml'] = DEPENDENT_WORKFLOW;
  const r = runGuard(fixture(spec));
  check('direction 1: an undeclared label-dependent workflow -> exit 1', r.code, EXIT_DIVERGENCE);
  check('...and names the file', r.out.includes('sneaky.yml'), true);

  const spec2 = AGREEING();
  spec2.scripts['sneaky.mjs'] = DEPENDENT_SCRIPT;
  const r2 = runGuard(fixture(spec2));
  check('direction 1: an undeclared label-dependent script -> exit 1', r2.code, EXIT_DIVERGENCE);
}

// --------------------------------------------------------------------------
// DIRECTION 2 — THE MUTATIONS QA NAMED. Before this guard, both of these left
// the suite green while `check-path-filters.mjs` went on promising in prose
// that lane-check.yml would refuse a mislabelled PR.
// --------------------------------------------------------------------------
{
  // DELETE lane-check.yml.
  const spec = AGREEING();
  delete spec.workflows['lane-check.yml'];
  const r = runGuard(fixture(spec));
  check('direction 2: DELETING the declared workflow -> exit 1', r.code, EXIT_DIVERGENCE);
  check('...and says it does not exist', r.out.includes('DOES NOT EXIST'), true);

  // TYPO the label: ci:cheap -> ci:chepa. The workflow still exists and is
  // still label-dependent; it simply never fires. Nothing else notices.
  const typo = AGREEING();
  typo.workflows['lane-check.yml'] = DEPENDENT_WORKFLOW.replace("'ci:cheap'", "'ci:chepa'");
  const rt = runGuard(fixture(typo));
  check('direction 2: TYPOING the label in the workflow -> exit 1', rt.code, EXIT_DIVERGENCE);
  check('...and says the label does not appear in the file', rt.out.includes('does not appear in the file'), true);

  // The file survives but stops branching on a label at all.
  const inert = AGREEING();
  inert.workflows['lane-check.yml'] = PLAIN_WORKFLOW;
  const ri = runGuard(fixture(inert));
  check('direction 2: a declared file that no longer branches on a label -> exit 1', ri.code, EXIT_DIVERGENCE);
  check('...and says so rather than blaming the path', ri.out.includes('no longer branches'), true);
}

// --------------------------------------------------------------------------
// An entry must carry its reasoning. A declaration with no `sampling` note is
// how the registry becomes a list of names that explains nothing.
// --------------------------------------------------------------------------
{
  const spec = AGREEING();
  const stripped = entryFor('.github/workflows/lane-check.yml');
  delete stripped.sampling;
  spec.registry = { checks: [stripped, entryFor('.github/scripts/dep.mjs')] };
  const r = runGuard(fixture(spec));
  check('an entry missing its sampling note -> exit 1', r.code, EXIT_DIVERGENCE);
  check('...and names the missing field', r.out.includes('sampling'), true);
}

// --------------------------------------------------------------------------
// CANNOT CHECK — exit 2, never 0. A registry that could not be read has
// compared nothing, and reporting OK from it is the #281 violation.
// --------------------------------------------------------------------------
{
  const spec = AGREEING();
  delete spec.registry;
  const missing = runGuard(fixture(spec));
  check('cannot check: no registry file -> exit 2, not 0', missing.code, EXIT_CANNOT_CHECK);

  const bad = AGREEING();
  bad.registry = '{ "checks": ';
  const corrupt = runGuard(fixture(bad));
  check('cannot check: unparseable registry -> exit 2', corrupt.code, EXIT_CANNOT_CHECK);
  check('...and says it is not valid JSON', corrupt.out.includes('not valid JSON'), true);

  const noArray = AGREEING();
  noArray.registry = { notChecks: [] };
  check('cannot check: registry with no checks array -> exit 2', runGuard(fixture(noArray)).code, EXIT_CANNOT_CHECK);

  // A scan directory that does not exist is not an empty tree.
  const dir = mkdtempSync(join(tmpdir(), 'label-dep-bare-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.github'), { recursive: true });
  writeFileSync(join(dir, '.github', 'label-dependent-checks.json'), JSON.stringify({ checks: [] }));
  const bare = runGuard(dir);
  check('cannot check: unreadable scan directories -> exit 2, not a clean 0', bare.code, EXIT_CANNOT_CHECK);
  check('...and says nothing was compared', bare.out.includes('NOT a pass'), true);
}

// --------------------------------------------------------------------------
// The predicates, directly. These are what decide the population, so a
// false negative here silently empties the registry's meaning.
// --------------------------------------------------------------------------
{
  check('predicate: `types: [labeled]` is label-dependent', workflowIsLabelDependent(DEPENDENT_WORKFLOW), true);
  check('predicate: a plain workflow is not', workflowIsLabelDependent(PLAIN_WORKFLOW), false);
  check(
    'predicate: `github.event.label` alone is label-dependent',
    workflowIsLabelDependent('if: github.event.label.name == 1'),
    true,
  );
  check('predicate: a script reading the payload and labels is label-dependent', scriptIsLabelDependent(DEPENDENT_SCRIPT), true);
  check('predicate: a plain script is not', scriptIsLabelDependent(PLAIN_SCRIPT), false);
  // The false positive that fired on this guard's own first run: the STRINGS
  // appear, but nothing reads the payload.
  check(
    'predicate: mentioning GITHUB_EVENT_PATH in a regex is NOT a dependence',
    scriptIsLabelDependent("const re = /GITHUB_EVENT_PATH/; const x = /\\.labels\\b/;"),
    false,
  );
}

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
