#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for ci-throughput-metric.mjs (#687 change 4).
 *
 * ADR-024's demand on a MEASUREMENT is sharper than on a guard: a guard must be
 * able to go red, but a metric must be able to report something OTHER THAN
 * IMPROVEMENT — and must distinguish "nothing happened in this window" from
 * "nothing changed". Those are different facts and a blank cell means neither.
 *
 * So the arms driven here are, in order of what they protect:
 *
 *   1. the three outcomes are REACHABLE and DISTINGUISHABLE
 *      REPORTED / NO DATA / CANNOT CHECK, each with its own message
 *   2. the numbers can get WORSE — the same code path on slower data reports
 *      larger figures, so no branch is pinned to "better"
 *   3. TRUNCATION is CANNOT CHECK, not a quietly smaller sample
 *   4. the stall exclusion actually excludes, and --include-stall actually
 *      includes, and each says which it did
 *   5. RECONSTRUCTED appears when the window predates the changes and not when
 *      it does not
 *   6. spawning the script PRINTS — the #742 silent-no-op regression
 *
 * `fetchImpl` is injected, so none of this needs a network or a token. The one
 * spawned case uses `--smoke`, which renders a canned fixture offline.
 *
 * Run: node .github/scripts/ci-throughput-metric.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env['CI_THROUGHPUT_METRIC_IMPORT_ONLY'] = '1';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, 'ci-throughput-metric.mjs');

const mod = await import('./ci-throughput-metric.mjs');
const { run, render, percentile, median, computeMetrics, inStall, EXIT_REPORTED, EXIT_CANNOT_CHECK } = mod;

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

/** A fetch stub keyed by URL fragment. */
function stubFetch(routes) {
  return async (url) => {
    for (const [frag, body] of Object.entries(routes)) {
      if (url.includes(frag)) {
        if (body === 'ERROR') return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: true, status: 200, json: async () => (url.includes('/actions/runs') ? { workflow_runs: [] } : []) };
  };
}

const NOW = '2026-09-07T12:00:00Z';

function pr(created, merged, number = 1) {
  return { number, created_at: created, merged_at: merged, updated_at: merged };
}
function wfRun(created, id = 1) {
  return {
    id,
    created_at: created,
    run_started_at: created,
    updated_at: created,
    status: 'completed',
    jobs_url: `https://api.github.com/repos/o/r/actions/runs/${id}/jobs`,
  };
}
function job(created, started, completed, stepMins = 1) {
  return {
    name: 'test-integrity',
    created_at: created,
    started_at: started,
    completed_at: completed,
    steps: [{ name: 'Mutation audit (report-only)', started_at: started, completed_at: completed }],
  };
}

// --- 1. the three outcomes are reachable and distinguishable ----------------
{
  const r = await run({
    args: ['--days', '7', '--repo', 'o/r'],
    fetchImpl: stubFetch({ '/pulls': [], '/actions/runs': { workflow_runs: [] } }),
    now: NOW,
  });
  check('an empty window is NO DATA, not a pass', r.outcome === 'NO_DATA' && r.exit === EXIT_CANNOT_CHECK, `got ${r.outcome}/${r.exit}`);
  const text = render(r);
  check('NO DATA says nothing was measured', /NOT "no change"/.test(text), text);
}
{
  const r = await run({
    args: ['--days', '7', '--repo', 'o/r'],
    fetchImpl: stubFetch({ '/pulls': 'ERROR' }),
    now: NOW,
  });
  check('an unreadable API is CANNOT CHECK', r.outcome === 'CANNOT_CHECK' && r.exit === EXIT_CANNOT_CHECK, `got ${r.outcome}`);
  check('CANNOT CHECK names the HTTP failure', /HTTP 500/.test(render(r)), render(r));
}
{
  // The load-bearing distinction: the two non-reporting outcomes must not be
  // the same string, or a dashboard cannot tell "quiet week" from "API down".
  const empty = render(await run({ args: ['--repo', 'o/r'], fetchImpl: stubFetch({ '/pulls': [], '/actions/runs': { workflow_runs: [] } }), now: NOW }));
  const broken = render(await run({ args: ['--repo', 'o/r'], fetchImpl: stubFetch({ '/pulls': 'ERROR' }), now: NOW }));
  check('NO DATA and CANNOT CHECK are DIFFERENT messages', empty !== broken && /NO DATA/.test(empty) && /CANNOT CHECK/.test(broken));
}

// --- 2. the numbers can get worse ------------------------------------------
{
  const fast = computeMetrics({
    prs: [pr('2026-09-06T00:00:00Z', '2026-09-06T01:00:00Z')],
    runs: [wfRun('2026-09-06T00:00:00Z')],
    jobs: [job('2026-09-06T00:00:00Z', '2026-09-06T00:01:00Z', '2026-09-06T00:03:00Z')],
    includeStall: false,
  });
  const slow = computeMetrics({
    prs: [pr('2026-09-06T00:00:00Z', '2026-09-06T09:00:00Z')],
    runs: [wfRun('2026-09-06T00:00:00Z')],
    jobs: [job('2026-09-06T00:00:00Z', '2026-09-06T00:30:00Z', '2026-09-06T01:20:00Z')],
    includeStall: false,
  });
  check('a slower window reports a LARGER outcome figure', slow.outcome.median > fast.outcome.median, `${slow.outcome.median} vs ${fast.outcome.median}`);
  check('a slower window reports a LARGER queue wait', slow.attributable.median > fast.attributable.median, `${slow.attributable.median} vs ${fast.attributable.median}`);
  check('a slower window reports a LARGER lane hold', slow.laneHold.median > fast.laneHold.median, `${slow.laneHold.median} vs ${fast.laneHold.median}`);
  check('the metric reports numbers, never a verdict word', !/improv|better|worse|regress/i.test(render({ outcome: 'REPORTED', predicate: 'p', jobPredicate: 'j', metrics: slow, includeStall: false, reconstructed: false })));
}

// --- 3. truncation is cannot-check, not a smaller sample --------------------
{
  // 100 merged PRs per page for every page => pagination never converges.
  const page = Array.from({ length: 100 }, (_, i) => pr('2026-09-06T00:00:00Z', '2026-09-06T01:00:00Z', i));
  const r = await run({ args: ['--days', '7', '--repo', 'o/r'], fetchImpl: stubFetch({ '/pulls': page }), now: NOW });
  check('hitting the pagination cap is CANNOT CHECK', r.outcome === 'CANNOT_CHECK', `got ${r.outcome}`);
  check('truncation explains that the numbers would describe a PREFIX', /PREFIX/.test(render(r)), render(r));
}

// --- 4. the stall is excluded, and saying so is part of the output ----------
{
  check('inStall() brackets the outage', inStall('2026-09-05T12:00:00Z') && !inStall('2026-09-05T19:00:00Z'));
  const during = job('2026-09-05T12:00:00Z', '2026-09-05T13:00:00Z', '2026-09-05T13:30:00Z');
  const after = job('2026-09-06T00:00:00Z', '2026-09-06T00:01:00Z', '2026-09-06T00:02:00Z');
  const excluded = computeMetrics({ prs: [], runs: [], jobs: [during, after], includeStall: false });
  const included = computeMetrics({ prs: [], runs: [], jobs: [during, after], includeStall: true });
  check('excluding the stall drops its records', excluded.attributable.n === 1 && included.attributable.n === 2, `${excluded.attributable.n} vs ${included.attributable.n}`);
  check('including the stall reports a worse queue wait', included.attributable.max > excluded.attributable.max);

  const rendered = render({ outcome: 'REPORTED', predicate: 'p', jobPredicate: 'j', metrics: excluded, includeStall: false, reconstructed: false });
  check('the output states that the stall was EXCLUDED', /EXCLUDED/.test(rendered), rendered);
  const renderedIn = render({ outcome: 'REPORTED', predicate: 'p', jobPredicate: 'j', metrics: included, includeStall: true, reconstructed: false });
  check('the output states when the stall was INCLUDED', /INCLUDED/.test(renderedIn), renderedIn);
}

// --- 5. reconstruction is labelled in the output, not just the PR -----------
{
  const base = { outcome: 'REPORTED', predicate: 'p', jobPredicate: 'j', metrics: computeMetrics({ prs: [], runs: [], jobs: [job('2026-09-06T00:00:00Z', '2026-09-06T00:01:00Z', '2026-09-06T00:02:00Z')], includeStall: false }), includeStall: false };
  check('a window predating the changes is labelled RECONSTRUCTED', /RECONSTRUCTED, NOT OBSERVED/.test(render({ ...base, reconstructed: true })));
  check('a post-change window is NOT labelled reconstructed', !/RECONSTRUCTED/.test(render({ ...base, reconstructed: false })));
}

// --- percentile arithmetic --------------------------------------------------
{
  // Nearest-rank, so an even sample takes the LOWER middle (rank ceil(n/2)),
  // not the mean of the two. Asserted explicitly because "median" invites the
  // interpolating assumption, and the choice is deliberate: with samples this
  // small an interpolated value is one no run actually exhibited.
  check('median of an even sample takes the lower middle (nearest-rank)', median([1, 2, 3, 4]) === 2, `got ${median([1, 2, 3, 4])}`);
  check('p90 of 1..10 is 9', percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90) === 9);
  check('percentile of an empty sample is null, not 0', percentile([], 50) === null);
  check('p100 is the maximum', percentile([1, 5, 2], 100) === 5);
}

// --- 6. the script is not a silent no-op (#742 regression) ------------------
{
  const r = spawnSync(process.execPath, [SCRIPT, '--smoke'], {
    encoding: 'utf-8',
    env: { ...process.env, CI_THROUGHPUT_METRIC_IMPORT_ONLY: '', GITHUB_STEP_SUMMARY: '' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  check('spawning the script PRODUCES OUTPUT — exit 0 with silence is the defect', r.status === EXIT_REPORTED && out.trim().length > 0, `exit ${r.status}, output ${JSON.stringify(out.slice(0, 120))}`);
  check('the spawned output carries the predicate', /PREDICATE/.test(out), out.slice(0, 200));
}

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
