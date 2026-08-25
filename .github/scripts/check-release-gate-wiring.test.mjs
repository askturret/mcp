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
 * Deliberately dependency-free: `js-yaml` is only hoisted into the root
 * `node_modules` via a transitive dependency, and the `readiness` job runs
 * without `npm ci` at all. A test that cannot run everywhere its subject runs
 * is a test that silently stops running.
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

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
