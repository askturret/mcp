#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Reliability suite runner (§51 CI wiring).
 *
 * Runs the scenarios and PRINTS THE EVIDENCE, rather than only asserting.
 * The nightly job needs numbers it can compare against yesterday's — a suite
 * that reports only pass/fail cannot show a regression that is still inside
 * its threshold, which is precisely how a slow degradation ships.
 *
 * Scale with RELIABILITY_SCALE=nightly, or individually via
 * RELIABILITY_CONCURRENCY / RELIABILITY_CALLS / RELIABILITY_CHAOS_ROUNDS.
 */

import {
  boundedResourceUsage,
  canMeasureHeap,
  chaosPreservesTypedErrors,
  overlappingSwapsUnderLoad,
  partialFailureIsolatesGroups,
  reloadDuringDrain,
  retryHoldsBulkheadPermit,
  saturationDoesNotTripBreaker,
  scaleFromEnv,
  shutdownUnderLoad,
} from '../dist/index.js';

const scale = scaleFromEnv();
const json = process.argv.includes('--json');

const scenarios = [
  ['saturation-does-not-trip-breaker', () => saturationDoesNotTripBreaker(scale)],
  ['retry-holds-bulkhead-permit', () => retryHoldsBulkheadPermit(scale)],
  ['partial-failure-isolates-groups', () => partialFailureIsolatesGroups(scale)],
  ['reload-during-drain', () => reloadDuringDrain()],
  ['overlapping-swaps-under-load', () => overlappingSwapsUnderLoad(scale)],
  ['shutdown-under-load', () => shutdownUnderLoad(scale)],
  ['chaos-preserves-typed-errors', () => chaosPreservesTypedErrors(scale)],
  ['bounded-resource-usage', () => boundedResourceUsage(scale)],
];

const results = {};

for (const [name, run] of scenarios) {
  const startedAt = Date.now();
  try {
    results[name] = { ok: true, durationMs: 0, evidence: await run() };
    results[name].durationMs = Date.now() - startedAt;
  } catch (error) {
    results[name] = {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

const summary = {
  scale,
  heapAssertable: canMeasureHeap(),
  results,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('');
  console.log('AskTurret MCP — reliability suite');
  console.log(`scale: concurrency=${scale.concurrency} calls=${scale.totalCalls} chaos=${scale.chaosRounds}`);
  console.log(`heap assertions: ${canMeasureHeap() ? 'ENABLED (--expose-gc)' : 'reported only (run with --expose-gc to assert)'}`);
  console.log('');
  for (const [name, result] of Object.entries(results)) {
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${name}  (${result.durationMs}ms)`);
    if (!result.ok) console.log(`      ${result.error}`);
    else console.log(`      ${JSON.stringify(result.evidence)}`);
  }
  console.log('');
}

process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1);
