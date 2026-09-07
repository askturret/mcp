#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * CI throughput, measured rather than asserted (#687 change 4).
 *
 * ---------------------------------------------------------------------------
 * THREE NUMBERS, AND WHY THE MIDDLE ONE IS THE SCOREBOARD
 * ---------------------------------------------------------------------------
 *
 *   outcome       PR opened -> merged            median + p90 hours
 *   attributable  JOB created -> JOB started     median + p90 minutes
 *   mechanism     runs created per merged PR     ratio
 *
 * The founder's ask is the OUTCOME number. It is the right goal and the wrong
 * scoreboard: it improves when review happens to be prompt and regresses when a
 * reviewer takes a day off, neither of which any CI change causes. QUEUE WAIT
 * moves only when the queue moves, so it is the number attributable to the
 * work. Both are reported, and the difference between them is stated here so a
 * reader cannot mistake one for the other.
 *
 * ---------------------------------------------------------------------------
 * WHY QUEUE WAIT IS MEASURED AT THE JOB LEVEL, NOT THE RUN LEVEL
 * ---------------------------------------------------------------------------
 *
 * The metric was specified as run `created_at` -> `run_started_at`. MEASURED ON
 * THIS REPOSITORY, THAT FIELD PAIR IS IDENTICALLY ZERO: over 100 consecutive
 * runs, `created_at === run_started_at` for every single one — 0 non-zero
 * deltas. GitHub stamps a run as started when it is created; the WAITING happens
 * when a JOB asks for a runner.
 *
 * Shipped as specified it would have been a constant printing `0 min` forever —
 * a number that cannot go up, cannot go down, and would have reported "no queue
 * wait" on the very afternoon nine jobs sat queued behind one run. That is the
 * ADR-024 defect (a measurement that can only report one answer), inherited from
 * the specification rather than introduced here.
 *
 * The job-level pair is real and moves: sampled across four `Test` runs on
 * 2026-09-07, per-run medians were 0.0, 0.0, 0.2 and 10.9 minutes with maxima
 * near 13. So `attributable` is job `created_at` -> job `started_at`.
 *
 * ---------------------------------------------------------------------------
 * TWO MORE NUMBERS, NOT PART OF THE RULED THREE
 * ---------------------------------------------------------------------------
 *
 *   lane hold     job started -> job completed   median + p90 minutes
 *   heaviest steps  the steps consuming the most runner-minutes, BY NAME
 *
 * Changes 1-3 all reduce how MANY runs are scheduled. None reduces how long one
 * job holds the lane, and on a single serial runner that is the binding
 * constraint — `test-integrity` clears ~65 steps in ~2 minutes and then holds
 * the runner on one report-only step with up to nine jobs queued behind it. A
 * throughput metric that cannot see that is measuring the wrong thing.
 *
 * The step breakdown is included because it costs NOTHING EXTRA: the jobs
 * payload already carries every step with its timings, so naming the heaviest
 * step is free once job-level queue wait is being fetched at all. Run against
 * the real API it identifies `Mutation audit (report-only)` in `test-integrity`
 * unprompted — the constraint the founder measured by hand.
 *
 * The cost that IS real is one jobs request per run, so the job/step figures are
 * computed over a BOUNDED SAMPLE of the most recent runs in the window
 * (`--job-sample`, default 25). The bound is printed in the predicate: these
 * figures describe that sample, not the whole window, and saying so is the
 * difference between a measurement and a claim.
 *
 * ---------------------------------------------------------------------------
 * THE BASELINE CANNOT BE MEASURED FROM HERE — ONLY RECONSTRUCTED
 * ---------------------------------------------------------------------------
 *
 * Changes 1-3 landed on 2026-09-05. Every window available to this script now
 * either starts after that (post-change, honest) or spans it (mixed). There is
 * no window that observes the "before" state, because the intervention already
 * happened. A "before" figure derived afterwards is an ESTIMATE WEARING THE
 * CLOTHES OF AN OBSERVATION.
 *
 * So the script says so IN ITS OWN OUTPUT, not only in the PR that introduced
 * it: any window reaching back past CHANGES_LANDED_AT is labelled RECONSTRUCTED
 * every time it runs. A caveat that lives only in a PR body is read once.
 *
 * ---------------------------------------------------------------------------
 * THE STALL, EXCLUDED BY DEFAULT AND SAID OUT LOUD
 * ---------------------------------------------------------------------------
 *
 * On 2026-09-05 one wedged runner held the only lane from ~11:00Z to ~18:10Z
 * with 20+ runs queued behind it. A window spanning that describes the OUTAGE,
 * not the concurrency work: queue wait during it is dominated by a stuck
 * process. Runs created inside that interval are EXCLUDED by default and the
 * count dropped is printed. `--include-stall` keeps them, for anyone who wants
 * the unfiltered picture.
 *
 * Excluding by default is the more honest bias here: including it would flatter
 * nothing (it makes the "before" look worse and any later window look better by
 * comparison), which is exactly the direction a self-serving metric would pick.
 *
 * ---------------------------------------------------------------------------
 * IT MUST BE ABLE TO SAY SOMETHING OTHER THAN "BETTER" (ADR-024)
 * ---------------------------------------------------------------------------
 *
 * This script reports NUMBERS, never a verdict. There is no "improved" branch to
 * be stuck in, because there is no comparison baked in: comparing two windows is
 * the reader's job, and both windows are printed with their predicates so the
 * comparison is checkable.
 *
 * Three OUTCOMES exist and are distinguishable, which is the property that
 * matters most:
 *
 *   REPORTED      (exit 0) — data found, numbers printed
 *   NO DATA       (exit 2) — the window is empty; nothing was measured
 *   CANNOT CHECK  (exit 2) — the API could not be read, or the data was
 *                            TRUNCATED so the window is only partly covered
 *
 * NO DATA and CANNOT CHECK are separate messages on purpose. "Nothing merged
 * this week" and "I could not read the API" are different facts, and a blank
 * dashboard cell must never be readable as either success or absence of change.
 * Both are non-zero, because neither measured anything — the same discipline
 * check-runners.mjs and check-release-registry-reconcile.mjs follow.
 *
 * TRUNCATION IS CANNOT CHECK, NOT A SMALLER SAMPLE. If pagination hits its cap
 * while the window still extends further back, the numbers describe a prefix of
 * the window while the predicate claims the whole of it. A median over a silent
 * subset is worse than no median.
 *
 * ---------------------------------------------------------------------------
 * STATE THE PREDICATE WITH THE COUNT (ADR-023)
 * ---------------------------------------------------------------------------
 *
 * Every number is printed with the window that produced it and the n it was
 * computed over. A median with no predicate cannot be checked, compared, or
 * reproduced.
 *
 * ---------------------------------------------------------------------------
 * ZERO-DEPENDENCY, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * Node builtins and the global `fetch` only. PR #742 declared `js-yaml` for a
 * guard that runs in a job which installs; that was argued for that one script
 * and is NOT blanket permission. FIVE jobs run `.github/scripts` code with no
 * `npm ci` — check-readiness-matrix, check-path-filters, check-platform-claims,
 * check-release-registry-reconcile and ci-coverage-status. This script is
 * wired into a nightly job that does not install either, so builtins it is.
 *
 * `fetchImpl` is injectable so the self-test drives every arm — including the
 * empty window and the truncation arm — without a network or a token.
 *
 * Run: node .github/scripts/ci-throughput-metric.mjs [--days N | --last-merged N]
 *                                                    [--since ISO] [--include-stall]
 *                                                    [--json] [--repo owner/name]
 */

import { argv, env, stdout, stderr } from 'node:process';

export const EXIT_REPORTED = 0;
export const EXIT_CANNOT_CHECK = 2;

/** When changes 1-3 landed. A window reaching back past this is reconstruction. */
export const CHANGES_LANDED_AT = '2026-09-05T00:00:00Z';

/** The wedged-runner outage: one runner held the only lane, 20+ runs behind it. */
export const STALL = {
  from: '2026-09-05T11:00:00Z',
  to: '2026-09-05T18:10:00Z',
  why: 'one wedged runner held the only lane with 20+ runs queued behind it',
};

/** Pagination cap. Exceeding it while still inside the window is CANNOT CHECK. */
const MAX_PAGES = 12;
const PER_PAGE = 100;

const ms = (iso) => Date.parse(iso);
const minutes = (a, b) => (ms(b) - ms(a)) / 60000;
const hours = (a, b) => (ms(b) - ms(a)) / 3600000;

/**
 * Percentile by nearest-rank on a sorted copy.
 *
 * Nearest-rank rather than interpolation: with the sample sizes here (often
 * under 30) an interpolated p90 invents a value between two observations and
 * reads as more precise than the data supports.
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export const median = (values) => percentile(values, 50);

const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

/** Inside the stall interval? */
export const inStall = (iso) => ms(iso) >= ms(STALL.from) && ms(iso) <= ms(STALL.to);

/**
 * Fetch one page, returning `{ ok, body }` rather than throwing.
 *
 * Every failure becomes a CANNOT CHECK with a reason the reader can act on,
 * instead of a stack trace that a CI log reader has to interpret.
 */
async function getPage(url, { token, fetchImpl }) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'askturret-ci-throughput-metric',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchImpl(url, { headers });
  } catch (err) {
    return { ok: false, reason: `request to ${url} failed: ${err?.message ?? err}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `${url} returned HTTP ${res.status}` };
  }
  try {
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, reason: `${url} returned unparseable JSON: ${err?.message ?? err}` };
  }
}

/**
 * Merged PRs, newest first, back to `sinceIso` (or the newest `limit` of them).
 *
 * `truncated` is returned rather than logged, so the caller can turn it into
 * CANNOT CHECK. A partial list that looks complete is the failure this guards.
 */
export async function fetchMergedPrs({ repo, sinceIso, limit, token, fetchImpl }) {
  const merged = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `https://api.github.com/repos/${repo}/pulls` +
      `?state=closed&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`;
    const r = await getPage(url, { token, fetchImpl });
    if (!r.ok) return { ok: false, reason: r.reason };
    const batch = Array.isArray(r.body) ? r.body : [];
    for (const pr of batch) {
      if (!pr.merged_at) continue;
      if (limit !== undefined) {
        if (merged.length < limit) merged.push(pr);
      } else if (ms(pr.merged_at) >= ms(sinceIso)) {
        merged.push(pr);
      }
    }
    if (limit !== undefined && merged.length >= limit) return { ok: true, prs: merged, truncated: false };
    if (batch.length < PER_PAGE) return { ok: true, prs: merged, truncated: false };
    // Sorted by UPDATED, so a page whose every entry predates the window still
    // does not prove the next one does. Stop only when the oldest UPDATE on the
    // page is comfortably older than the window.
    const oldestUpdate = batch[batch.length - 1]?.updated_at;
    if (limit === undefined && oldestUpdate && ms(oldestUpdate) < ms(sinceIso)) {
      return { ok: true, prs: merged, truncated: false };
    }
    if (page === MAX_PAGES) return { ok: true, prs: merged, truncated: true };
  }
  return { ok: true, prs: merged, truncated: true };
}

/** Workflow runs created at or after `sinceIso`, newest first. */
export async function fetchRuns({ repo, sinceIso, token, fetchImpl }) {
  const runs = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `https://api.github.com/repos/${repo}/actions/runs` +
      `?per_page=${PER_PAGE}&page=${page}&created=%3E%3D${sinceIso.slice(0, 10)}`;
    const r = await getPage(url, { token, fetchImpl });
    if (!r.ok) return { ok: false, reason: r.reason };
    const batch = Array.isArray(r.body?.workflow_runs) ? r.body.workflow_runs : [];
    for (const run of batch) {
      if (ms(run.created_at) >= ms(sinceIso)) runs.push(run);
    }
    if (batch.length < PER_PAGE) return { ok: true, runs, truncated: false };
    const oldest = batch[batch.length - 1]?.created_at;
    if (oldest && ms(oldest) < ms(sinceIso)) return { ok: true, runs, truncated: false };
    if (page === MAX_PAGES) return { ok: true, runs, truncated: true };
  }
  return { ok: true, runs, truncated: true };
}

/**
 * Jobs for the most recent `sample` runs, flattened.
 *
 * One request per run, which is why the sample is bounded. A run whose jobs
 * cannot be read is COUNTED as unreadable rather than skipped silently — a
 * sample that quietly shrinks is a predicate that quietly becomes false.
 */
export async function fetchJobsForRuns({ runs, sample, token, fetchImpl }) {
  const chosen = runs.filter((r) => r.status === 'completed').slice(0, sample);
  const jobs = [];
  let unreadable = 0;
  for (const run of chosen) {
    const url = `https://api.github.com/repos/${run.repository?.full_name ?? ''}/actions/runs/${run.id}/jobs?per_page=100`;
    const direct = run.jobs_url ? `${run.jobs_url}?per_page=100` : url;
    const r = await getPage(direct, { token, fetchImpl });
    if (!r.ok) {
      unreadable++;
      continue;
    }
    for (const j of r.body?.jobs ?? []) jobs.push(j);
  }
  return { jobs, runsSampled: chosen.length, unreadable };
}

/** Aggregate step timings into the heaviest consumers of runner time. */
export function heaviestSteps(jobs, top = 3) {
  const byName = new Map();
  for (const j of jobs) {
    for (const s of j.steps ?? []) {
      if (!s.started_at || !s.completed_at) continue;
      const mins = minutes(s.started_at, s.completed_at);
      if (!Number.isFinite(mins) || mins < 0) continue;
      const key = `${j.name} / ${s.name}`;
      const cur = byName.get(key) ?? { key, total: 0, max: 0, n: 0 };
      cur.total += mins;
      cur.max = Math.max(cur.max, mins);
      cur.n++;
      byName.set(key, cur);
    }
  }
  return [...byName.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, top)
    .map((s) => ({ key: s.key, total: round1(s.total), max: round1(s.max), n: s.n }));
}

/** Turn raw PRs and runs into the reported figures. */
export function computeMetrics({ prs, runs, jobs = [], includeStall }) {
  const droppedPrs = includeStall ? [] : prs.filter((p) => inStall(p.merged_at));
  const droppedRuns = includeStall ? [] : runs.filter((r) => inStall(r.created_at));
  const keptPrs = includeStall ? prs : prs.filter((p) => !inStall(p.merged_at));
  const keptRuns = includeStall ? runs : runs.filter((r) => !inStall(r.created_at));

  const openToMerge = keptPrs
    .filter((p) => p.created_at && p.merged_at)
    .map((p) => hours(p.created_at, p.merged_at))
    .filter((h) => Number.isFinite(h) && h >= 0);

  // JOB level, not run level: run created->started is identically zero on this
  // repository (measured, 0/100 non-zero), so the run-level pair could only ever
  // print 0. See the header.
  const keptJobs = includeStall ? jobs : jobs.filter((j) => !j.created_at || !inStall(j.created_at));

  const queueWait = keptJobs
    .filter((j) => j.created_at && j.started_at)
    .map((j) => minutes(j.created_at, j.started_at))
    .filter((m) => Number.isFinite(m) && m >= 0);

  // Incomplete jobs are excluded rather than measured to "now", which would
  // report a still-running job as a very long hold.
  const laneHold = keptJobs
    .filter((j) => j.started_at && j.completed_at)
    .map((j) => minutes(j.started_at, j.completed_at))
    .filter((m) => Number.isFinite(m) && m >= 0);

  return {
    outcome: { n: openToMerge.length, median: round1(median(openToMerge)), p90: round1(percentile(openToMerge, 90)) },
    // `max` is reported alongside p90 because on this repository most jobs are
    // trivial and a handful are long: with n=49 and three jobs over 7 minutes,
    // p90 lands below all of them, so p90 alone reads as "nothing holds the
    // lane" while a 7-minute hold sits in the same sample.
    attributable: {
      n: queueWait.length,
      median: round1(median(queueWait)),
      p90: round1(percentile(queueWait, 90)),
      max: round1(percentile(queueWait, 100)),
    },
    mechanism: {
      runs: keptRuns.length,
      mergedPrs: keptPrs.length,
      ratio: keptPrs.length === 0 ? null : round1(keptRuns.length / keptPrs.length),
    },
    laneHold: {
      n: laneHold.length,
      median: round1(median(laneHold)),
      p90: round1(percentile(laneHold, 90)),
      max: round1(percentile(laneHold, 100)),
    },
    steps: heaviestSteps(keptJobs),
    dropped: { prs: droppedPrs.length, runs: droppedRuns.length },
  };
}

export function parseArgs(args) {
  const opts = {
    repo: env['GITHUB_REPOSITORY'] || 'askturret/mcp',
    days: 7,
    lastMerged: undefined,
    since: undefined,
    includeStall: false,
    json: false,
    jobSample: 25,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--days') opts.days = Number(args[++i]);
    else if (a === '--job-sample') opts.jobSample = Number(args[++i]);
    else if (a === '--last-merged') opts.lastMerged = Number(args[++i]);
    else if (a === '--since') opts.since = args[++i];
    else if (a === '--repo') opts.repo = args[++i];
    else if (a === '--include-stall') opts.includeStall = true;
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

function fmt(v, unit) {
  return v === null || v === undefined ? '—' : `${v} ${unit}`;
}

export async function run({ args = [], token, fetchImpl, now }) {
  const opts = parseArgs(args);
  const nowIso = now ?? new Date().toISOString();

  const sinceIso =
    opts.since ??
    (opts.lastMerged !== undefined
      ? CHANGES_LANDED_AT // count-based: still needs a floor for the runs query
      : new Date(ms(nowIso) - opts.days * 86400000).toISOString());

  const predicate =
    opts.lastMerged !== undefined
      ? `the last ${opts.lastMerged} merged PRs (runs counted from ${sinceIso})`
      : `${opts.days} days: ${sinceIso} .. ${nowIso}`;

  const prResult = await fetchMergedPrs({
    repo: opts.repo,
    sinceIso,
    limit: opts.lastMerged,
    token,
    fetchImpl,
  });
  if (!prResult.ok) {
    return { outcome: 'CANNOT_CHECK', reason: prResult.reason, predicate, exit: EXIT_CANNOT_CHECK };
  }

  const runResult = await fetchRuns({ repo: opts.repo, sinceIso, token, fetchImpl });
  if (!runResult.ok) {
    return { outcome: 'CANNOT_CHECK', reason: runResult.reason, predicate, exit: EXIT_CANNOT_CHECK };
  }

  if (prResult.truncated || runResult.truncated) {
    return {
      outcome: 'CANNOT_CHECK',
      reason:
        `pagination hit its ${MAX_PAGES}-page cap while the window still extended further back ` +
        `(${prResult.truncated ? 'pull requests' : ''}${prResult.truncated && runResult.truncated ? ' and ' : ''}` +
        `${runResult.truncated ? 'workflow runs' : ''}). The numbers would describe a PREFIX of the ` +
        'window while the predicate claimed all of it. Narrow the window and re-run.',
      predicate,
      exit: EXIT_CANNOT_CHECK,
    };
  }

  if (prResult.prs.length === 0 && runResult.runs.length === 0) {
    return {
      outcome: 'NO_DATA',
      reason: 'no merged pull requests and no workflow runs in this window — nothing was measured',
      predicate,
      exit: EXIT_CANNOT_CHECK,
    };
  }

  const jobResult = await fetchJobsForRuns({
    runs: runResult.runs,
    sample: opts.jobSample,
    token,
    fetchImpl,
  });

  const metrics = computeMetrics({
    prs: prResult.prs,
    runs: runResult.runs,
    jobs: jobResult.jobs,
    includeStall: opts.includeStall,
  });

  if (metrics.outcome.n === 0 && metrics.attributable.n === 0) {
    return {
      outcome: 'NO_DATA',
      reason: opts.includeStall
        ? 'the window contains no usable timestamps — nothing was measured'
        : `every record in this window fell inside the excluded stall interval ` +
          `(${metrics.dropped.prs} PR(s), ${metrics.dropped.runs} run(s)) — nothing was measured`,
      predicate,
      exit: EXIT_CANNOT_CHECK,
    };
  }

  return {
    outcome: 'REPORTED',
    predicate,
    jobPredicate:
      `job and step figures cover the most recent ${jobResult.runsSampled} completed run(s) ` +
      `in the window (--job-sample ${opts.jobSample})` +
      (jobResult.unreadable > 0 ? `; ${jobResult.unreadable} run(s) had unreadable jobs` : ''),
    reconstructed: ms(sinceIso) < ms(CHANGES_LANDED_AT),
    includeStall: opts.includeStall,
    metrics,
    json: opts.json,
    exit: EXIT_REPORTED,
  };
}

export function render(result) {
  const lines = [];
  lines.push(`ci-throughput-metric — PREDICATE: ${result.predicate}`);

  if (result.outcome === 'CANNOT_CHECK') {
    lines.push('');
    lines.push('CANNOT CHECK — no measurement was made:');
    lines.push(`  ${result.reason}`);
    lines.push('  This is NOT "no change" and NOT a pass.');
    return lines.join('\n');
  }
  if (result.outcome === 'NO_DATA') {
    lines.push('');
    lines.push('NO DATA — the window is empty:');
    lines.push(`  ${result.reason}`);
    lines.push('  This is NOT "no change": nothing was measured, so nothing improved or regressed.');
    return lines.join('\n');
  }

  const m = result.metrics;
  lines.push(`  ${result.jobPredicate}`);
  lines.push('');
  lines.push(`  outcome       PR opened -> merged        median ${fmt(m.outcome.median, 'h')}   p90 ${fmt(m.outcome.p90, 'h')}   (n=${m.outcome.n})`);
  lines.push(`  attributable  job created -> job started median ${fmt(m.attributable.median, 'min')}   p90 ${fmt(m.attributable.p90, 'min')}   max ${fmt(m.attributable.max, 'min')}   (n=${m.attributable.n})`);
  lines.push(`  mechanism     runs per merged PR         ${m.mechanism.ratio ?? '—'}   (${m.mechanism.runs} runs / ${m.mechanism.mergedPrs} merged PRs)`);
  lines.push(`  lane hold     job started -> completed   median ${fmt(m.laneHold.median, 'min')}   p90 ${fmt(m.laneHold.p90, 'min')}   max ${fmt(m.laneHold.max, 'min')}   (n=${m.laneHold.n})`);
  if (m.steps.length > 0) {
    lines.push('');
    lines.push('  heaviest steps by runner-minutes consumed in the sample:');
    for (const s of m.steps) {
      lines.push(`    ${String(s.total).padStart(7)} min total   max ${s.max} min   x${s.n}   ${s.key}`);
    }
  }
  lines.push('');
  lines.push('  outcome is the goal; ATTRIBUTABLE is the scoreboard — outcome moves when review');
  lines.push('  is prompt or slow, queue wait moves only when the queue does.');
  lines.push('  QUEUE WAIT IS MEASURED PER JOB. The run-level pair this was specified as');
  lines.push('  (created_at -> run_started_at) is identically zero here: 0 of 100 consecutive');
  lines.push('  runs had any delta, so it could only ever print 0. See the header.');
  lines.push('  lane hold is how long ONE job occupies the serial runner. Changes 1-3 reduce run');
  lines.push('  COUNT, not hold time — which is why the step breakdown is here.');

  if (!result.includeStall) {
    lines.push('');
    lines.push(`  EXCLUDED: the ${STALL.from} .. ${STALL.to} runner stall`);
    lines.push(`            (${STALL.why}) — ${m.dropped.runs} run(s) and ${m.dropped.prs} PR(s) dropped.`);
    lines.push('            Pass --include-stall for the unfiltered picture.');
  } else {
    lines.push('');
    lines.push(`  INCLUDED: the ${STALL.from} .. ${STALL.to} runner stall is IN these numbers`);
    lines.push('            (--include-stall). They describe the outage as much as the queue.');
  }

  if (result.reconstructed) {
    lines.push('');
    lines.push(`  RECONSTRUCTED, NOT OBSERVED: this window reaches back past ${CHANGES_LANDED_AT},`);
    lines.push('  when changes 1-3 landed. No window available now observes the "before" state,');
    lines.push('  so any comparison across that boundary is an estimate, not a measurement.');
  }

  return lines.join('\n');
}

export async function main(args, deps = {}) {
  const result = await run({
    args,
    token: deps.token ?? env['GITHUB_TOKEN'],
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    now: deps.now,
  });

  if (result.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const text = render(result);
    (result.exit === EXIT_REPORTED ? stdout : stderr).write(`${text}\n`);
  }

  const summary = env['GITHUB_STEP_SUMMARY'];
  if (summary) {
    const { appendFileSync } = await import('node:fs');
    try {
      appendFileSync(summary, `### CI throughput (#687)\n\n\`\`\`\n${render(result)}\n\`\`\`\n`);
    } catch {
      // A summary that cannot be written must not change the verdict.
    }
  }

  // #739: publish the OUTCOME TOKEN as a step output so a router can read the
  // CAUSE instead of inferring it from severity.
  //
  // NO_DATA and CANNOT_CHECK both exit 2, because "I could not check" is never
  // "it passed" — but they are NOT alike for notification: a quiet window is
  // the system working and having nothing to say, while an unreadable API is a
  // real problem. An exit code is one channel carrying two dimensions, so it
  // cannot express both; this line is the second dimension.
  //
  // NOTHING about the outcome logic or the exit code changes here. The token is
  // computed by run() either way; this only publishes it. That is what keeps
  // the router independent of the open exit-contract ruling.
  const output = env['GITHUB_OUTPUT'];
  if (output) {
    const { appendFileSync } = await import('node:fs');
    try {
      appendFileSync(output, `outcome=${result.outcome}\n`);
    } catch {
      // A step output that cannot be written must not change the verdict.
      // The router fails CLOSED on a missing token, so this degrades to a page
      // rather than to silence.
    }
  }

  return result.exit;
}

/**
 * Offline smoke mode: render a canned result and exit.
 *
 * Exists so the self-test can prove — with NO network and NO token — that
 * spawning this file actually produces output. Exit 0 alone would not: the
 * failure being guarded against is a script that runs and does nothing.
 */
function smoke() {
  stdout.write(
    `${render({
      outcome: 'REPORTED',
      predicate: 'smoke: canned fixture, no API call',
      jobPredicate: 'job and step figures cover the most recent 1 completed run(s) in the window (--job-sample 25)',
      reconstructed: false,
      includeStall: false,
      metrics: computeMetrics({
        prs: [{ created_at: '2026-09-06T00:00:00Z', merged_at: '2026-09-06T02:00:00Z' }],
        runs: [{ created_at: '2026-09-06T00:00:00Z', status: 'completed' }],
        jobs: [
          {
            name: 'demo',
            created_at: '2026-09-06T00:00:00Z',
            started_at: '2026-09-06T00:05:00Z',
            completed_at: '2026-09-06T00:12:00Z',
            steps: [{ name: 'slow step', started_at: '2026-09-06T00:05:00Z', completed_at: '2026-09-06T00:12:00Z' }],
          },
        ],
        includeStall: false,
      }),
    })}\n`,
  );
  return EXIT_REPORTED;
}

// Runs unconditionally unless explicitly imported for testing.
//
// There is deliberately NO `import.meta.url === `file://${argv[1]}`` check here:
// argv[1] may be relative and import.meta.url is percent-encoded, so on any path
// containing a space the comparison is false, main() never runs, and the process
// exits 0 having done NOTHING. PR #742 shipped exactly that into a draft and it
// was caught only because a passing run printed nothing.
//
// An explicit env opt-out cannot fail that way: it is a value the caller sets on
// purpose, not a string equality that silently stops holding. The self-test sets
// it to import the exports, AND separately spawns this file in `--smoke` mode to
// prove that the unset path really does run and print.
if (!env['CI_THROUGHPUT_METRIC_IMPORT_ONLY']) {
  process.exit(argv.includes('--smoke') ? smoke() : await main(argv.slice(2)));
}
