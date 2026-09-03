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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'check-path-filters.mjs');

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

/**
 * Run the guard against a fixture, with the ambient event payload withheld (#365).
 *
 * These fixtures are plain temp directories, NOT git repositories. Actions sets
 * `GITHUB_EVENT_PATH` on every step, and check E engages whenever that payload
 * carries the `ci:cheap` label — at which point it diffs against the base inside
 * `repoRoot`, which here is the fixture, and cannot. Every case below then
 * returned CANNOT CHECK (2) instead of the verdict it was written to assert.
 *
 * The tell was that this looked environmental and was not. The payload is a
 * SNAPSHOT taken when the event fired, and a PR is created before it is
 * labelled — so the `opened` build carries no `ci:cheap` and passes, while every
 * later `synchronize` carries it and fails. Same commit, same runner, opposite
 * result, which is what made it read as runner drift rather than a leak.
 *
 * Only this one variable is withheld, not the whole environment: PATH is still
 * needed to spawn node, and check E is gated solely on the label, so dropping
 * the payload skips the block outright and `GITHUB_BASE_REF` is never consulted.
 * `laneFixture` passes a payload EXPLICITLY when it wants that path, so the
 * cases that do need it are unaffected.
 *
 * `GITHUB_EVENT_NAME` is withheld TOO, and that is not tidiness (#565 QA).
 * Since the payload-state fix, "the event name says pull_request but the
 * payload is unreadable" is CANNOT CHECK — exit 2, deliberately. This suite
 * runs inside test-integrity, which triggers on `pull_request`, so the ambient
 * `GITHUB_EVENT_NAME` is `pull_request` in CI and unset on a developer's
 * machine. Withholding only the path would have made every case below exit 2 in
 * CI while passing locally: a CI-only failure, invisible here, in a suite whose
 * whole subject is environment-dependent behaviour that looks fine locally.
 * Withholding both models "not a CI run at all", which is what these fixtures
 * are.
 */
function run(dir) {
  const { GITHUB_EVENT_PATH: _ambient, GITHUB_EVENT_NAME: _ambientName, ...env } = process.env;
  const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf-8', env });
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
 *
 * `baseRef` defaults to the branch this fixture actually creates, so every
 * existing case keeps diffing against something resolvable. Overriding it with
 * a ref that does NOT exist is how the lane check's fail-closed branch is
 * reached (#349) — before that override there was no way to exercise it, since
 * the fixture could only ever pass a valid ref.
 */
function laneFixture({
  labels,
  changedPaths,
  filtersBlock,
  packages = { core: [] },
  baseRef = 'main',
  // The payload's `action` (#565). Defaults to `synchronize` — a payload whose
  // label set IS authoritative — so every pre-existing case keeps asserting
  // exactly what it asserted before this field existed. `opened` is the one
  // value that makes an ABSENT `ci:cheap` unreliable, and the cases that pass
  // it are the ones added for #565.
  action = 'synchronize',
  // Run the guard with no PATH, so ITS `git` cannot be found (#510). The
  // fixture's own git calls run in this process and are unaffected; only the
  // child loses the ability to start one. `process.execPath` is absolute, so
  // node itself still runs — the trap #361 and #509 both name.
  pathless = false,
}) {
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
  mkdirSync(join(dir, 'no-bin'), { recursive: true });
  const eventPath = join(dir, 'event.json');
  // `action` sits at the TOP LEVEL of the payload, beside `pull_request` — not
  // inside it. Getting that nesting wrong would make the discriminator read
  // `undefined` on every real run while every fixture still passed.
  writeFileSync(
    eventPath,
    JSON.stringify({ action, pull_request: { labels: labels.map((name) => ({ name })) } }),
  );

  // PATH pointed at an EMPTY DIRECTORY, not unset. Found by running it:
  // DELETING `PATH` does not make a binary unfindable, because libc falls back
  // to a default search path (`/usr/bin:/bin`) and git is on it — the guard
  // then ran normally and the case proved nothing. An empty directory is a
  // PATH that exists and contains nothing, which is the state being modelled.
  const r = spawnSync(process.execPath, [GUARD, dir, baseRef], {
    encoding: 'utf-8',
    // `GITHUB_EVENT_NAME` is set EXPLICITLY rather than inherited: these cases
    // assert pull_request behaviour, and inheriting it makes the result depend
    // on whether the suite happens to be running inside a pull_request build.
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: 'pull_request',
      ...(pathless ? { PATH: join(dir, 'no-bin') } : {}),
    },
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

// ---------------------------------------------------------------------------
// #565 — the label-blind `opened` payload.
//
// A PR is created by one API call and labelled by a separate one, so an
// `opened` payload cannot carry a label applied afterwards. That made THREE
// states collapse into one observable outcome ("check E did not run"), of which
// one is the defect: a PR that IS `ci:cheap` on a payload that predates its own
// labelling. These cases pin the discriminator that separates them.
// ---------------------------------------------------------------------------
{
  const r = laneFixture({
    action: 'opened',
    labels: [],
    changedPaths: ['.github/workflows/release.yml'],
    filtersBlock: LANE_FILTERS,
  });
  check('opened + tripping paths + no ci:cheap: exits 0, never reddens the PR', r.code, 0);
  check('...and SAYS the classification was deferred', r.out.includes('lane classification DEFERRED'), true);
  check('...and names the tripped filter', /trips 1 filter\(s\): 'workspace'/.test(r.out), true);
  check('...and names the CONSEQUENCE, not the mechanism', r.out.includes('that is a mislabel'), true);
  check('...and points at the run that WILL check it', r.out.includes('lane-check.yml'), true);
}

// THE ASYMMETRY. Only the NEGATIVE case is unreliable on an `opened` payload:
// if `ci:cheap` IS present the claim is being made and must still be refused.
// Without this case a later "simplification" to skip all `opened` runs passes.
{
  const r = laneFixture({
    action: 'opened',
    labels: ['ci:cheap'],
    changedPaths: ['.github/workflows/release.yml'],
    filtersBlock: LANE_FILTERS,
  });
  check('opened + ci:cheap PRESENT: still REFUSED — the asymmetry holds', r.code, 1);
  check('...and it is the real violation, not a deferral', r.out.includes('lane classification DEFERRED'), false);
}

// THE ANTI-WALLPAPER CONTROL, and the case a naive implementation fails. A
// deferral printed on every `opened` run — the great majority of which are
// legitimately not cheap — is wallpaper, and wallpaper is how a warning becomes
// invisible. Nothing is pending here: `ci:cheap` would be CORRECT for this
// change, so there is no claim to defer.
{
  const r = laneFixture({
    action: 'opened',
    labels: [],
    changedPaths: ['docs/thing.md', '.operum/audit/note.jsonl'],
    filtersBlock: LANE_FILTERS,
  });
  check('opened + NO tripping paths + no ci:cheap: exits 0', r.code, 0);
  check('...and stays SILENT — no deferral to announce', r.out.includes('lane classification DEFERRED'), false);
}

// The pre-#565 behaviour, pinned against regression: on a payload whose label
// set IS authoritative, a tripping `ci:cheap` PR is still refused.
check(
  'synchronize + ci:cheap + tripping paths: still refused (regression pin)',
  laneFixture({
    action: 'synchronize',
    labels: ['ci:cheap'],
    changedPaths: ['.github/workflows/release.yml'],
    filtersBlock: LANE_FILTERS,
  }).code,
  1,
);

// The observed `action` is REPORTED, not assumed. The entire discriminator
// rests on GitHub sending it, so the value actually seen is printed on every PR
// run — `action=none` would mean the discriminator has silently stopped
// discriminating and every `opened` run is back to the old blind behaviour.
{
  const r = laneFixture({
    action: 'synchronize',
    labels: [],
    changedPaths: ['docs/thing.md'],
    filtersBlock: LANE_FILTERS,
  });
  check('a PR run reports the observed action on its summary line', r.out.includes('action=synchronize'), true);

  // `null`, NOT `undefined`. A JS default parameter fires on `undefined`, so
  // `action: undefined` would silently become `synchronize` and this case would
  // assert nothing — it failed exactly that way when first written. `null`
  // passes through the default and `JSON.stringify` emits `"action":null`,
  // which is a payload carrying no usable action.
  const noAction = laneFixture({
    action: null,
    labels: [],
    changedPaths: ['docs/thing.md'],
    filtersBlock: LANE_FILTERS,
  });
  check('a payload with NO action reports action=none rather than staying quiet', noAction.out.includes('action=none'), true);
}

// ---------------------------------------------------------------------------
// PAYLOAD STATE — the seven cannot-determine paths (#565 QA).
//
// Five of these used to exit 0. Three distinct conditions collapsed into one
// `null` — not a PR run, unreadable payload, no `pull_request` key — and `null`
// read as "nothing to check here". The worst two did not merely stay silent:
// they ASSERTED "lane not claimed" from a label set they had failed to parse,
// which is "I could not check" resolving as "it passed".
//
// The control cases matter as much as the failures: a push build and a local
// run must stay quiet and exit 0, or this fix would redden everything that is
// not a pull request.
// ---------------------------------------------------------------------------
/** Run the guard against the REAL repo with a hand-built payload environment. */
function payloadRun({ body, eventName, omitPath = false, writeFile = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'payload-'));
  const eventPath = join(dir, 'event.json');
  if (writeFile) writeFileSync(eventPath, typeof body === 'string' ? body : JSON.stringify(body));

  const { GITHUB_EVENT_PATH: _p, GITHUB_EVENT_NAME: _n, ...base } = process.env;
  const env = { ...base };
  if (!omitPath) env.GITHUB_EVENT_PATH = eventPath;
  if (eventName !== null) env.GITHUB_EVENT_NAME = eventName;

  // No repoRoot argument: the guard defaults to this repository, so checks A-D
  // pass and the payload state is the only thing under test.
  const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf-8', env });
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const CHEAP_PAYLOAD = { action: 'synchronize', pull_request: { labels: [{ name: 'ci:cheap' }] } };

{
  // 3. GITHUB_EVENT_PATH set, file missing.
  const r = payloadRun({ body: CHEAP_PAYLOAD, eventName: 'pull_request', writeFile: false });
  check('payload: event file absent is CANNOT CHECK, not a pass', r.code, 2);
  check('...and says the label claim was not evaluated', r.out.includes('was NOT evaluated'), true);

  // 4. Corrupt JSON.
  const corrupt = payloadRun({ body: '{ "pull_request": ', eventName: 'pull_request' });
  check('payload: corrupt JSON is CANNOT CHECK, not a pass', corrupt.code, 2);
  check('...and names it as invalid JSON', corrupt.out.includes('not valid JSON'), true);

  // 5. `labels` is a string, not an array.
  const strLabels = payloadRun({
    body: { action: 'synchronize', pull_request: { labels: 'ci:cheap' } },
    eventName: 'pull_request',
  });
  check('payload: labels as a string is CANNOT CHECK, not "lane not claimed"', strLabels.code, 2);
  check('...and says the label set could not be read', strLabels.out.includes('could not be read'), true);
  check('...and does NOT assert a negative conclusion', strLabels.out.includes('lane not claimed'), false);

  // 6. The event names ci:cheap but the PR object carries no label set. This is
  //    the shape the workflow gate could produce, and the one that used to
  //    report "lane not claimed" while a claim demonstrably existed.
  const noLabels = payloadRun({
    body: { action: 'labeled', label: { name: 'ci:cheap' }, pull_request: {} },
    eventName: 'pull_request',
  });
  check('payload: label.name=ci:cheap with no labels[] is CANNOT CHECK', noLabels.code, 2);
  check('...and does NOT report the claim as absent', noLabels.out.includes('lane not claimed'), false);

  // A partial read is not a read: one unparseable entry could be the ci:cheap one.
  const partial = payloadRun({
    body: { action: 'synchronize', pull_request: { labels: [{ name: 'ci:full' }, { nome: 'typo' }] } },
    eventName: 'pull_request',
  });
  check('payload: a partially-readable label set is CANNOT CHECK', partial.code, 2);

  // 7. No pull_request object on a pull_request event.
  const noPr = payloadRun({ body: { action: 'synchronize' }, eventName: 'pull_request' });
  check('payload: no pull_request object on a pull_request event is CANNOT CHECK', noPr.code, 2);

  // GITHUB_EVENT_PATH unset on a pull_request event.
  const noPath = payloadRun({ body: CHEAP_PAYLOAD, eventName: 'pull_request', omitPath: true });
  check('payload: event path unset on a pull_request event is CANNOT CHECK', noPath.code, 2);
}

// THE CONTROLS. Without these the fix above would redden every push build and
// every local run — and a guard that fails on correct conditions is one someone
// switches off.
{
  const push = payloadRun({
    body: { ref: 'refs/heads/main', commits: [] },
    eventName: 'push',
  });
  check('control: a push build has no pull_request and still exits 0', push.code, 0);
  check('...and says nothing about the lane', push.out.includes('lane'), false);

  const local = payloadRun({ body: CHEAP_PAYLOAD, eventName: null, omitPath: true });
  check('control: a local run with no payload at all exits 0', local.code, 0);
  check('...and says nothing about the lane', local.out.includes('lane'), false);

  const wellFormed = payloadRun({
    body: { action: 'synchronize', pull_request: { labels: [{ name: 'ci:full' }] } },
    eventName: 'pull_request',
  });
  check('control: a well-formed non-cheap payload still exits 0', wellFormed.code, 0);
  check('...and reports the lane as not claimed', wellFormed.out.includes('lane not claimed'), true);
}

// ---------------------------------------------------------------------------
// THE DECLARATION IS CHECKED, NOT ASSERTED (#565 QA / #535 shape).
//
// The guard's deferral message tells the reader that lane-check.yml "will
// refuse it". Until now nothing read that file: deleting lane-check.yml, or
// typoing `ci:cheap` inside it, left this suite 69/0 green while the promise
// became false. Prose asserting external state with nothing noticing when it
// diverges is exactly what #535 was filed about.
// ---------------------------------------------------------------------------
{
  const LANE_WORKFLOW = join(HERE, '..', 'workflows', 'lane-check.yml');
  const exists = existsSync(LANE_WORKFLOW);
  check('declaration: lane-check.yml exists, as the deferral message promises', exists, true);

  const yaml = exists ? readFileSync(LANE_WORKFLOW, 'utf-8') : '';
  check('declaration: it triggers on the `labeled` event', /types:\s*\[[^\]]*labeled/.test(yaml), true);
  check('declaration: its gate names ci:cheap', yaml.includes("'ci:cheap'"), true);

  // THE FIELD IDENTITY, pinned. The gate must read the PR's CURRENT label set —
  // the same field the script parses — not `github.event.label.name`, the
  // single label that triggered the event. Those are different fields and they
  // disagreed: a PR already carrying ci:cheap, then given any other label,
  // skipped entirely and suppressed a real finding.
  check(
    'declaration: the gate reads pull_request.labels, the SAME field the script reads',
    yaml.includes('contains(github.event.pull_request.labels.*.name'),
    true,
  );
  check(
    'declaration: the gate does NOT read the single triggering label',
    /if:.*github\.event\.label\.name/.test(yaml),
    false,
  );
  check('declaration: it actually runs this guard', yaml.includes('check-path-filters.mjs'), true);
}

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

// ---------------------------------------------------------------------------
// Hermeticity (#365)
//
// The suite must reach the same verdict whether or not the runner happens to
// have a `ci:cheap` pull_request payload in the environment. Asserted here
// rather than left to `run()`'s implementation, because the failure it guards
// is invisible locally: a developer's shell has no GITHUB_EVENT_PATH, so the
// leak is silent everywhere except the one place it breaks CI.
//
// This case fails on exactly the ambient payload that broke it — a `ci:cheap`
// label — so reverting the withhold in `run()` turns it RED rather than merely
// changing a count somewhere.
// ---------------------------------------------------------------------------

{
  const evDir = mkdtempSync(join(tmpdir(), 'path-filters-ambient-'));
  const evPath = join(evDir, 'event.json');
  writeFileSync(evPath, JSON.stringify({ pull_request: { labels: [{ name: 'ci:cheap' }] } }));

  const previous = process.env['GITHUB_EVENT_PATH'];
  process.env['GITHUB_EVENT_PATH'] = evPath;
  try {
    check(
      'an ambient ci:cheap event payload does not reach a fixture run (#365)',
      withFixture({ core: [] }, `            core:\n              - 'packages/core/**'`).code,
      0,
    );
  } finally {
    if (previous === undefined) delete process.env['GITHUB_EVENT_PATH'];
    else process.env['GITHUB_EVENT_PATH'] = previous;
    rmSync(evDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The lane check's own CANNOT-CHECK branch (#349)
//
// #348 added a fail-closed branch: if the base ref cannot be diffed, the lane
// claim is unverifiable and the guard exits 2 rather than passing. It works —
// but nothing exercised it, because laneFixture could only ever pass a
// resolvable ref.
//
// The contrast is the argument for pinning it. The PARSER's cannot-check paths
// in this same file carry five assertions (missing filters block, unrecognised
// line, list item before a name, missing workflow file, no declared outputs).
// This file's convention is unmistakably to pin them; the lane check was the
// one branch resting on prose.
//
// A fail-closed branch with no test is precisely what gets "simplified" into
// fail-open by someone who cannot see what it protects.
// ---------------------------------------------------------------------------

{
  const r = laneFixture({
    labels: ['ci:cheap'],
    changedPaths: ['docs/thing.md'],
    filtersBlock: LANE_FILTERS,
    baseRef: 'origin/no-such-base-ref',
  });

  check('lane: an unresolvable base ref is CANNOT CHECK, not a silent pass (#349)', r.code, 2);
  check(
    'lane: ...and names the ref it could not diff against',
    /diff against 'origin\/no-such-base-ref'/.test(r.out),
    true,
  );

  // RE-POINTED, NOT JUST UPDATED (#510). This assertion used to read "...and
  // names the shallow checkout as the likely cause" — it pinned the defect.
  // git ran and refused here, so shallow is ONE of two explanations and the
  // guard is not entitled to pick; what it must do is offer both and quote the
  // evidence that separates them.
  check(
    'lane: ...and offers both explanations rather than asserting shallow',
    r.out.includes('fetch-depth: 0') && /may not exist here/.test(r.out),
    true,
  );
  check(
    "lane: ...and quotes git's own words, which are what distinguish them",
    /unknown revision|ambiguous argument|fatal:/.test(r.out),
    true,
  );
}

// ---------------------------------------------------------------------------
// A cannot-check that names the WRONG cause (#510)
//
// Three conditions reached one sentence blaming a shallow checkout, and it was
// right about one of them. The guard already failed closed — this was never a
// false pass — but #281's point is not merely to refuse. The reader ACTS on the
// sentence, and two in three were sent to deepen a checkout that was already
// deep enough.
//
// The unstartable-git row is the one that matters most: it produces the most
// misleading output, and it is the row where "shallow" is not merely unproven
// but impossible — the diff never ran at all.
// ---------------------------------------------------------------------------

{
  const r = laneFixture({
    labels: ['ci:cheap'],
    changedPaths: ['docs/thing.md'],
    filtersBlock: LANE_FILTERS,
    pathless: true,
  });

  check('lane: git that never starts is CANNOT CHECK (#510)', r.code, 2);
  check(
    'lane: ...and says the diff never ran, rather than blaming the checkout',
    /could not be started/.test(r.out),
    true,
  );

  // THE ASSERTION THAT BITES. Asserting the good sentence is present is weak —
  // the old message would have satisfied a loose match too. Assert the HARMFUL
  // claim is ABSENT: nothing here may tell the reader to deepen a checkout.
  check(
    'lane: ...and does NOT tell the reader to deepen the checkout',
    r.out.includes('fetch-depth: 0'),
    false,
  );
  check(
    'lane: ...and says explicitly that this is not a shallow checkout',
    /NOT a shallow checkout/.test(r.out),
    true,
  );
  check(
    'lane: ...and points at the cause it actually has, the PATH',
    /on PATH/.test(r.out),
    true,
  );
}

// The paired positive is load-bearing here, and it already exists above: the
// SAME cheap `docs/` change with a resolvable ref exits 0 ("a genuinely cheap
// PR (docs + .operum/audit) still passes"). Without it, a guard that returned 2
// for everything would satisfy the three assertions above.

// ---------------------------------------------------------------------------
// The summary trailer knows which class it is summarising (#351)
//
// Every case below asserts report TEXT. Both defects are output defects with a
// CORRECT exit code — the guard exited 1 exactly when it should — so a
// status-only assertion passes against the bug unfixed and proves nothing.
// ---------------------------------------------------------------------------

// A filter that omits a dependency: coverage gap only, no lane violation.
const GAP_FILTERS = `            core:
              - 'packages/core/**'
            cli:
              - 'packages/cli/**'
            workspace:
              - 'package.json'`;

{
  // Lane violation ONLY: cheap-labelled, but the change trips a filter. The
  // trailer used to tell this author to ADD the tripping path to a filter,
  // contradicting the per-violation line directly above it.
  const r = laneFixture({
    labels: ['ci:cheap'],
    changedPaths: ['.github/workflows/release.yml'],
    filtersBlock: LANE_FILTERS,
  });

  check('trailer: a lane violation alone still exits 1 (#351)', r.code, 1);
  check(
    'trailer: ...and does NOT tell the author to add the tripping path to a filter',
    r.out.includes('Add the missing path(s) to the filter'),
    false,
  );
  check(
    'trailer: ...and gives the lane remedy instead',
    /Either relabel this PR `ci:full`, or avoid the tripping path/.test(r.out),
    true,
  );
  check(
    'trailer: ...and says plainly that adding paths is the wrong move here',
    r.out.includes('Do NOT add these paths to a filter'),
    true,
  );
}

{
  // Coverage gap ONLY: no ci:cheap label, so the lane check never runs. The
  // original advice is correct for this class and must survive unchanged.
  const r = laneFixture({
    labels: [],
    changedPaths: ['docs/thing.md'],
    filtersBlock: GAP_FILTERS,
    packages: { core: [], cli: [CORE] },
  });

  check('trailer: a coverage gap alone still exits 1 (#351)', r.code, 1);
  check(
    'trailer: ...and KEEPS the add-the-path remedy, which is right for this class',
    r.out.includes('Add the missing path(s) to the filter'),
    true,
  );
  check(
    'trailer: ...and does not offer the lane remedy, which would be wrong here',
    r.out.includes('Either relabel this PR'),
    false,
  );
}

{
  // MIXED: a coverage gap AND a lane violation in one run. This is the case a
  // single trailer cannot serve, and the one most likely to be missed — either
  // class alone reads fine with a trailer written for it.
  const r = laneFixture({
    labels: ['ci:cheap'],
    changedPaths: ['packages/core/src/thing.ts'],
    filtersBlock: GAP_FILTERS,
    packages: { core: [], cli: [CORE] },
  });

  check('trailer: a mixed run still exits 1 (#351)', r.code, 1);
  check(
    'trailer: ...summarises the coverage class',
    /\d+ filter-coverage problem\(s\)\./.test(r.out),
    true,
  );
  check(
    'trailer: ...AND the lane class, in the same run',
    /\d+ lane problem\(s\)\./.test(r.out),
    true,
  );
  check(
    'trailer: ...so neither class is handed the other class remedy',
    r.out.includes('Add the missing path(s) to the filter') &&
      r.out.includes('Either relabel this PR `ci:full`'),
    true,
  );
  // The fixture yields exactly one of each: `cli` depends on core without
  // including 'packages/core/**' (coverage), and the changed path trips the
  // `core` filter under a ci:cheap label (lane). Pinning the total AND the two
  // per-class counts is what stops a regression that drops one class from the
  // total while still printing both lines.
  check(
    'trailer: ...and the total counts BOTH classes, not just one',
    /\n2 problem\(s\)\./.test(r.out),
    true,
  );
  check(
    'trailer: ...with one problem attributed to each class',
    /1 filter-coverage problem\(s\)\./.test(r.out) && /1 lane problem\(s\)\./.test(r.out),
    true,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
