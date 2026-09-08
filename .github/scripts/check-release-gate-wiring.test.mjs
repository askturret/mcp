#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Pins the release gate's WIRING (#269).
 *
 * check-readiness-matrix.test.mjs proves the evaluator is correct. That is a
 * different question from whether anything consults it: the entire gate is one
 * word in a `needs:` list, and deleting that word removes the gate while
 * leaving every other test green. This file is what makes that deletion fail.
 *
 * A PR touching `.github/workflows/**` cannot demonstrate its own gating
 * behaviour from its own CI run — the release path only runs on a real
 * release. So the wiring is asserted by READING the workflows, which is a
 * check that runs on every PR.
 *
 * ## WHERE IT RUNS, and why one lane is the right answer (#750)
 *
 * It runs in `test-integrity` in `test.yml`, on every pull request. That is the
 * whole of its wiring, and it is not a prose claim: `check-guards.test.mjs`'s
 * #381 check asserts every guard script is named by a workflow step, over an
 * exemption list that is currently EMPTY. Delete the step and that check fails
 * BY NAME — verified by mutation rather than assumed.
 *
 * This header used to justify the dependency-free constraint by saying "a test
 * that cannot run everywhere its subject runs is a test that silently stops
 * running", which reads as a coverage claim the wiring does not deliver. The
 * constraint stays; the reasoning was wrong, in a way worth writing down.
 *
 * ONE LANE IS SUFFICIENT BECAUSE THE SUBJECT IS LANE-INDEPENDENT. This test
 * READS workflow files. For a given commit those bytes are the same in every
 * job, so running it a second time somewhere else re-reads the same input and
 * cannot reach a different verdict. Extra lanes would add executions, not
 * coverage.
 *
 * AND WIRING IT INTO `readiness` WOULD NOT CATCH THE FAILURE THIS FILE EXISTS
 * FOR — which is the argument that settles it. The failure is deleting
 * `readiness` from `publish`'s `needs:`. Delete that word and:
 *
 *   - `readiness` STILL RUNS. It is gated on `if: github.event_name ==
 *     'release'`, not on being needed by anything.
 *   - so a wiring test living there would go red, correctly.
 *   - and `publish` would publish anyway, because it no longer waits on
 *     `readiness`.
 *
 * The backstop fails in exactly the case it exists for. And that word was the
 * only thing ORDERING the two jobs, so once it is gone they run concurrently:
 * the red need not even land beside the publish, it can arrive AFTER it, on a
 * version already public. Nothing sequences them. `publish` is the one
 * GitHub-hosted job here while `readiness` queues for the self-hosted pool, so
 * that order is an ordinary schedule rather than a contrived one. Either way it
 * is a red X on a release nothing actually refused — the overclaim
 * `tag-readiness-advisory.yml` already rules against in the other direction.
 *
 * THE RESIDUAL, stated rather than implied: one lane cannot catch a workflow
 * change that reaches the release ref WITHOUT passing the PR lane. Every path
 * this repository uses goes through a pull request, so that is narrow.
 *
 * Two things this header does NOT get to say about it.
 *
 * FIRST, not "`readiness` could not block it either". Finding 1 proves
 * `readiness` cannot block ONE failure — its own deletion from `publish`'s
 * `needs:`, which is the case that severs the edge. The residual is a different
 * scenario: some other workflow change arriving off the PR lane, with the edge
 * INTACT. There a red `readiness` WOULD block `publish`, exactly as designed.
 * Generalising finding 1 from the single case it proves to every case is a
 * claim it does not support.
 *
 * SECOND, not "closing it would need a check that does not exist". One exists:
 * `supply-chain`, in this same workflow file. It runs on `release` — its `if:`
 * excludes only dependabot pull requests, and the comment above it says push
 * and release must never be skipped by that condition — and `publish` NEEDS it.
 * A wiring assertion hosted there would go red on the needs-deletion AND block
 * the publish, covering finding 1's case and this residual together.
 *
 * It is not wired there, and that is a TRADE rather than an absence.
 * `supply-chain` is the licence, NOTICE and SBOM job: every step in it is about
 * what the product ships, and a red there is read as a compliance failure. A
 * workflow-wiring assertion would be the one step that is about something else,
 * making that job's red mean two unrelated things — paid for a path this
 * repository does not use. If that stops being true, this is the lane, recorded
 * here so the option is revisited rather than rediscovered.
 *
 * STILL DEPENDENCY-FREE, for the reason that is actually true rather than the
 * one above: it keeps this file eligible for the install-less lanes, where its
 * sibling `check-readiness-matrix.test.mjs` already runs inside `readiness`
 * with no `npm ci`. If it is ever wired into such a job, `check-install-less-
 * deps.mjs` (#743) enforces builtins-only automatically — so the constraint is
 * machine-checked the moment it becomes load-bearing, and costs nothing while
 * it is not.
 *
 * That reasoning is unchanged by PR #742, but the provenance sentence it used
 * to open with is: `js-yaml` was described here as "only hoisted into the root
 * `node_modules` via a transitive dependency", which was true when written and
 * was falsified by #742 declaring it as a root devDependency (#743). A DECLARED
 * devDependency is still absent from a job that never installs, so being
 * dependency-free remains the requirement — only the reason js-yaml happens to
 * be resolvable has changed.
 *
 * Run: node .github/scripts/check-release-gate-wiring.test.mjs
 */

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;

function check(desc, ok, detail = '') {
  if (ok) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc}${detail ? `\n       ${detail}` : ''}`);
    failed++;
  }
}

const supplyChain = readFileSync('.github/workflows/supply-chain.yml', 'utf8');
const testWorkflow = readFileSync('.github/workflows/test.yml', 'utf8');
const advisory = readFileSync('.github/workflows/tag-readiness-advisory.yml', 'utf8');

/** The `key:` line of a top-level job, and everything indented under it. */
function jobBlock(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

// --- the gate itself --------------------------------------------------------
const publish = jobBlock(supplyChain, 'publish');
check('supply-chain.yml declares a publish job', publish !== null);

const needs = publish && /^\s*needs:\s*(.+)$/m.exec(publish);
check('publish declares needs:', !!needs);
check(
  'publish is gated on the readiness job',
  !!needs && needs[1].includes('readiness'),
  `needs: was ${needs ? needs[1] : '(absent)'} — the gate IS this word`,
);
check(
  'publish keeps its existing supply-chain dependency',
  !!needs && needs[1].includes('supply-chain'),
  'readiness must be added alongside, not instead of, licence review + SBOM',
);

check('supply-chain.yml declares a readiness job', jobBlock(supplyChain, 'readiness') !== null);

const readiness = jobBlock(supplyChain, 'readiness') ?? '';
check('the readiness job runs the shared evaluator', readiness.includes('check-readiness-matrix.mjs'));
check('the readiness job self-tests the evaluator first', readiness.includes('check-readiness-matrix.test.mjs'));
check(
  'the readiness job only runs for release events',
  /if:\s*github\.event_name == 'release'/.test(readiness),
);
check(
  'the readiness job can still block — it does not pass --advisory unconditionally',
  readiness.includes('check-readiness-matrix.mjs\n') ||
    /check-readiness-matrix\.mjs\s*$/m.test(readiness),
  'a blocking invocation with no --advisory flag must remain reachable',
);
check(
  'the readiness job treats 0.x as advisory',
  readiness.includes('--advisory') && readiness.includes('MAJOR'),
);

// --- the SBOM upload permission (#269 blocker 2) ----------------------------
const sbomJob = jobBlock(supplyChain, 'supply-chain') ?? '';
check('the SBOM job uploads a release asset', sbomJob.includes('gh release upload'));
check(
  'the SBOM job declares contents: write for that upload',
  /permissions:\s*(?:#[^\n]*\n\s*)*[\s\S]*?contents:\s*write/.test(sbomJob),
  'it inherits contents: read from the workflow level, which 403s on upload',
);

// --- both callers use one implementation ------------------------------------
check('test.yml calls the extracted script', testWorkflow.includes('check-readiness-matrix.mjs'));
check(
  'test.yml no longer inlines the matrix parser',
  !testWorkflow.includes('MET_COUNT'),
  'two implementations of this parser is exactly what extracting it prevents',
);

// --- the advisory workflow must stay advisory -------------------------------
// If this ever fails it is not a formatting nit: a blocking invocation here
// produces a red X on a tag that nothing actually refused, which is the same
// class of overclaim #269 exists to remove — just pointing the other way.
const advisoryRuns = advisory.match(/check-readiness-matrix\.mjs[^\n]*/g) ?? [];
check('the tag workflow runs the evaluator', advisoryRuns.length > 0);
check(
  'every tag-workflow invocation is advisory',
  advisoryRuns.every((line) => line.includes('--advisory')),
  `found: ${JSON.stringify(advisoryRuns)}`,
);
check(
  'the tag workflow says it is not a gate',
  /advisory/i.test(advisory) && /cannot|does not block/i.test(advisory),
);

// --- the tarball gate on the release path (#670) -----------------------------
// Until #670, check-tarball-compliance ran in the PR lane ONLY: supply-chain's
// publish job went `npm run build` -> `npm publish` with nothing between, so no
// exit code the guard returned could stop a bad publish. The protection is one
// STEP, and it can be removed three ways that all leave every other test green
// — delete it, move it after the publish, or split it into its own job. This
// block is what makes each of those fail.
const publishJob = publish ?? '';

// The gate's RUN LINE — a line that DOES something — never a mention of it.
// Two properties are load-bearing, and both were learned from a defeat rather
// than reasoned out in advance (#752, found by QA):
//
//   1. ANCHORED to a whole line.
//   2. NOT A COMMENT. The `(?!\s*#)` is the half that an anchor requiring only
//      the literal "node " still misses, because the natural comment to write
//      above a step is one that QUOTES THE COMMAND THE STEP RUNS — and this
//      workflow's gate carries exactly that kind of comment block.
//
// Resolving the gate by first textual mention lets a comment stand in for the
// step. Measured on a tree with the gate moved AFTER the publish: first-mention
// resolves into the comment, ahead of the publish, and the ordering check below
// PASSES on a tree that publishes before it verifies. Both defeat shapes are
// pinned further down; neither is hypothetical.
const TARBALL_RUN_LINE =
  /^(?!\s*#)[^\n]*node \.github\/scripts\/check-tarball-compliance\.mjs\b[^\n]*$/m;

/**
 * `build < gate < publish`, with the gate resolved from its run line.
 *
 * A function rather than three inline offsets so the decoys below exercise the
 * SAME resolution the live assertion uses. A decoy run against a copy of this
 * logic would prove only that the copy is sound (#679).
 */
function gateOrdering(jobText) {
  const run = TARBALL_RUN_LINE.exec(jobText);
  const buildAt = jobText.indexOf('npm run build');
  const gateAt = run ? run.index : -1;
  const publishAt = jobText.indexOf('npm publish');
  return {
    buildAt,
    gateAt,
    publishAt,
    ordered:
      buildAt !== -1 && gateAt !== -1 && publishAt !== -1 && buildAt < gateAt && gateAt < publishAt,
  };
}

const tarballRun = TARBALL_RUN_LINE.exec(publishJob);

check(
  'the publish job asserts tarball compliance before publishing',
  tarballRun !== null,
  'a PR-lane-only invocation proves the PR tree; the release publishes the release tree (#670)',
);

const { buildAt, gateAt, publishAt, ordered } = gateOrdering(publishJob);
check(
  'the gate sits between npm run build and npm publish',
  ordered,
  `build@${buildAt} gate@${gateAt} publish@${publishAt} — the guard packs, and npm pack reports dist/ only once built, so it must follow the build; after the publish it asserts nothing`,
);

// The gate's index being inside `publishJob` at all IS the "same job"
// assertion: jobBlock() returns only the publish job's own lines.
check(
  'the gate is a STEP in the publish job, not a separate job wired by needs:',
  gateAt !== -1,
  'id-token: write and the OIDC token --provenance consumes are JOB-scoped — a separate job would leave the permission apart from the publish and silently cost the attestation, while every checker stayed green (#698)',
);
check(
  'the publish job still declares id-token: write alongside the gate',
  /id-token:\s*write/.test(publishJob),
  'the gate must not have displaced the permission that makes provenance possible',
);

check(
  'the gate does not swallow its exit code',
  tarballRun !== null && !/\|\||continue-on-error/.test(tarballRun[0]),
  `EXIT_DIVERGENCE (1) and EXIT_CANNOT_CHECK (2) must BOTH block: ${tarballRun ? tarballRun[0].trim() : '(absent)'}`,
);
// Matches the KEY form (`continue-on-error:` at the start of a line), never the
// bare word. The step's own comment says "NO continue-on-error" for the reader,
// and a substring test flags that comment as the very violation it warns
// against — which is how a guard ends up forbidding its own documentation.
check(
  'no step in the publish job is continue-on-error',
  !/^\s*continue-on-error\s*:/m.test(publishJob),
  'immediately before an irreversible publish, "I could not establish this" is a stop, not a shrug — refusing to publish is recoverable, publishing an unverified artifact is not',
);

check(
  'the PR-lane invocation is retained, not moved',
  testWorkflow.includes('check-tarball-compliance.mjs'),
  'the PR lane is the cheapest refusal available; the release gate is additional to it, not a relocation of it',
);

// --- A COMMENT MUST NOT STAND IN FOR THE STEP (#752) -------------------------
// The ordering assertion above is what `check-tarball-compliance.mjs`'s header
// cites when it says its fresh-pack substitution is safe BECAUSE the gate
// provably precedes the publish. That makes the assertion's discrimination a
// load-bearing claim rather than a nicety, on the path guarding an IRREVERSIBLE
// publish — so the ways it can stop discriminating are pinned here.
//
// Every fixture below publishes BEFORE it verifies. The correct verdict is
// always `ordered === false`; a fixture that returns true is a tree that would
// publish unverified while this suite reported green.
const decoyJob = (mention) =>
  [
    '  publish:',
    '    steps:',
    '      - run: npm run build',
    `      ${mention}`,
    '      - name: Publish',
    '        run: npm publish --workspaces --provenance --access public',
    '      - name: Packed tarballs carry README, LICENSE and NOTICE',
    '        run: node .github/scripts/check-tarball-compliance.mjs .',
  ].join('\n');

// The shape QA found. Today's real comment says the script name WITHOUT the
// extension, so adding four characters to it was the entire margin.
const decoyName = decoyJob('# THE RELEASE GATE. See check-tarball-compliance.mjs for what it packs.');
// The shape an anchor requiring only "node " still admits: a comment quoting
// the command. This is the likelier of the two to be written by hand.
const decoyCommand = decoyJob('# THE RELEASE GATE. It runs: node .github/scripts/check-tarball-compliance.mjs .');

check(
  'a comment NAMING the script does not satisfy the ordering assertion',
  gateOrdering(decoyName).ordered === false,
  `gate resolved to ${gateOrdering(decoyName).gateAt}, publish at ${gateOrdering(decoyName).publishAt}`,
);
check(
  'a comment QUOTING the command does not satisfy it either',
  gateOrdering(decoyCommand).ordered === false,
  `gate resolved to ${gateOrdering(decoyCommand).gateAt}, publish at ${gateOrdering(decoyCommand).publishAt}`,
);

// WITHOUT THIS PAIR the two assertions above are satisfied by any resolution
// that never finds the gate at all — including a broken regex. They assert the
// decoys are genuinely decoys: under first-mention resolution each one PASSES,
// which is the defect being pinned.
// Assembled, not written literally: a literal first-mention lookup on the
// script name here would be flagged by the source scan at the foot of this
// block as the very call it forbids — the guard-forbids-its-own-documentation
// shape (#740), arriving in an assertion instead of a comment.
const SCRIPT_NAME = 'check-tarball-compliance.mjs';

check(
  'the NAMING decoy really would pass under first-mention resolution',
  decoyName.indexOf(SCRIPT_NAME) < decoyName.indexOf('npm publish'),
  'if this fails the fixture no longer reproduces the defect, and the assertion above proves nothing',
);
check(
  'the QUOTING decoy really would pass under a "node "-only anchor',
  /^[^\n]*node \.github\/scripts\/check-tarball-compliance\.mjs\b[^\n]*$/m.exec(decoyCommand).index <
    decoyCommand.indexOf('npm publish'),
  'if this fails the fixture no longer distinguishes the two anchorings',
);

// The positive control. Same shape, same comment, gate moved back before the
// publish: excluding comments must not cost the assertion its true case.
check(
  'the same job with the gate BEFORE the publish still passes',
  gateOrdering(
    [
      '  publish:',
      '    steps:',
      '      - run: npm run build',
      '      # THE RELEASE GATE. It runs: node .github/scripts/check-tarball-compliance.mjs .',
      '      - name: Packed tarballs carry README, LICENSE and NOTICE',
      '        run: node .github/scripts/check-tarball-compliance.mjs .',
      '      - name: Publish',
      '        run: npm publish --workspaces --provenance --access public',
    ].join('\n'),
  ).ordered === true,
  'the comment-exclusion must reject decoys without rejecting the real arrangement',
);

// The decoys prove the RESOLUTION is sound. They cannot prove the live check
// still calls it — inlining a first-mention lookup at the call site would leave
// every assertion above green while the real assertion stopped discriminating,
// which is the #679 shape. So this reads the file's own source.
//
// Anchored per line, and matching only a real call: the negative lookahead for
// a line comment keeps this prose from being read as the violation it forbids.
const ownSource = readFileSync('.github/scripts/check-release-gate-wiring.test.mjs', 'utf8');
check(
  'the gate is never resolved by a bare first-mention lookup anywhere in this file',
  !/^(?!\s*\/\/)(?!\s*\*).*\.indexOf\(\s*['"]check-tarball-compliance/m.test(ownSource),
  'resolve the gate from TARBALL_RUN_LINE; a first-mention lookup matches comments',
);

// ...and the resolution itself, read from the LIVE function object rather than
// from a textual guess at where it lives. Pins the shape, so replacing the
// anchored lookup with any other resolution reddens here by name.
const orderingSource = gateOrdering.toString();
check(
  'gateOrdering resolves the gate from the anchored run line',
  /TARBALL_RUN_LINE\.exec\(/.test(orderingSource) &&
    /const gateAt = run \? run\.index : -1;/.test(orderingSource),
  orderingSource,
);

// --- the gateway suite's dist/ precondition (#702) ----------------------------
// packages/gateway/src/__tests__/cli.test.ts spawns the BUILT dist/cli.js — the
// artifact `npx` and the Dockerfile ENTRYPOINT actually execute, and the only
// assertion that can see a stale or mis-built dist/ at all. When dist/ is
// absent those cases now report as SKIPPED rather than passing silently (#702).
//
// THAT MAKES THE FAILURE VISIBLE. It does not PREVENT it: a CI run that stopped
// building the gateway would report three permanent skips that nobody is
// watching for, and the most valuable check in that file would cover nothing.
// The protection is POSITIONAL — one build step ahead of one test step — and it
// can be removed three ways that leave every other test green: drop the `-w
// packages/gateway` flag, reorder the steps, or split the job. This block is
// what makes each of those fail.
//
// Same technique as the tarball gate above, for the same reason: compare
// INDICES within the job's own block, so "same job" and "correct order" are one
// assertion rather than two that can drift apart.
const gatewayJob = jobBlock(testWorkflow, 'test-gateway') ?? '';
check(
  'test.yml declares a test-gateway job',
  gatewayJob !== '',
  'the block below asserts nothing if the job name changed and this lookup silently returned empty',
);

const gwBuildAt = gatewayJob.search(/npm run build[^\n]*-w packages\/gateway\b/);
const gwTestAt = gatewayJob.indexOf('npm test --workspace=packages/gateway');
check(
  'the gateway suite is built before it is run',
  gwBuildAt !== -1 && gwTestAt !== -1 && gwBuildAt < gwTestAt,
  `build@${gwBuildAt} test@${gwTestAt} — cli.test.ts spawns packages/gateway/dist/cli.js, so without ` +
    'that build the three spawned cases skip and the built artifact is covered by nothing (#702)',
);

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
