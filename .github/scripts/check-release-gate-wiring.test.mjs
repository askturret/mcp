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
 * Deliberately dependency-free: the `readiness` job runs without `npm ci` at
 * all, and a test that cannot run everywhere its subject runs is a test that
 * silently stops running.
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
const tarballRun = /^[^\n]*node \.github\/scripts\/check-tarball-compliance\.mjs\b[^\n]*$/m.exec(publishJob);

check(
  'the publish job asserts tarball compliance before publishing',
  tarballRun !== null,
  'a PR-lane-only invocation proves the PR tree; the release publishes the release tree (#670)',
);

const buildAt = publishJob.indexOf('npm run build');
const gateAt = publishJob.indexOf('check-tarball-compliance.mjs');
const publishAt = publishJob.indexOf('npm publish');
check(
  'the gate sits between npm run build and npm publish',
  buildAt !== -1 && gateAt !== -1 && publishAt !== -1 && buildAt < gateAt && gateAt < publishAt,
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

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
