#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Routes `reliability-nightly` outcomes to a tracking issue (#739).
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 *
 * `reliability-nightly.yml` runs FIVE jobs, and until this shipped a red run
 * notified nobody: no `if: failure()`, no `gh issue`, no workflow listening for
 * its completion. The run went red and the exposure lasted until a human
 * happened to open the Actions tab.
 *
 * That matters more than ordinary plumbing because `integrated-tree` is the
 * ONLY assertion in this repository over the merged tree. #687 dropped
 * `push: main` and bought ~24h of exposure explicitly on the condition that the
 * nightly would catch an integration failure — a trade that is only sound if a
 * nightly failure reaches someone.
 *
 * ---------------------------------------------------------------------------
 * IT ROUTES ON THE OUTCOME TOKEN, NEVER ON THE EXIT CODE
 * ---------------------------------------------------------------------------
 *
 * An exit code is a ONE-dimensional channel being asked to carry TWO dimensions
 * — *is the run red?* and *why?* Any assignment collapses one of them.
 * `ci-throughput-metric.mjs` exits 2 for BOTH `NO_DATA` (a genuinely quiet
 * window: nothing merged, nothing wrong) and `CANNOT_CHECK` (the API was
 * unreadable: a real problem). Routing on severity alone would page on every
 * quiet weekend, and a pager that cries wolf is tuned out within a fortnight —
 * correctly, by the reader, which is the worst kind of failure.
 *
 * So the discriminator is the TOKEN the script already computes and now
 * publishes as a step output. This has a property worth stating: the design is
 * INDEPENDENT of the still-open exit-contract ruling. If `NO_DATA` is later
 * moved to exit 0, nothing here changes, because nothing here reads the exit
 * code. It is likewise independent of #746's constant-pinning — if
 * `EXIT_CANNOT_CHECK` were ever mutated to 0 the job would go green, but the
 * token would still read `CANNOT_CHECK` and this would still page.
 *
 * ---------------------------------------------------------------------------
 * SKIPPED IS NOT FAILED, AND THAT DISTINCTION IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 *
 * `integrated-tree` and `ci-throughput` are gated to `schedule ||
 * workflow_dispatch`, so on a `push: main` run they SKIP. A router that read
 * `skipped` as failed would page on every qualifying push — which would train
 * the reader to ignore it before it ever reported a real failure.
 *
 * ---------------------------------------------------------------------------
 * A HEARTBEAT, NOT ONLY AN ALARM — WHO WATCHES THE NOTIFIER
 * ---------------------------------------------------------------------------
 *
 * A router that silently fails to route is THIS ISSUE'S OWN DEFECT ONE LEVEL
 * UP, and it fails invisibly in exactly the same way: if it throws, the nightly
 * goes red, and the thing nobody reads is the nightly.
 *
 * So on EVERY run — including green ones — this rewrites the tracking issue's
 * BODY with a status table, the run URL, the tree SHA and a timestamp. A body
 * edit does NOT notify, so the heartbeat is silent. Only a TRANSITION to
 * non-green posts a COMMENT, which does.
 *
 * The two halves together give what neither has alone: the alarm stays quiet
 * when things are fine, and SILENCE BECOMES CHECKABLE. A stale timestamp in
 * that body is evidence the notifier itself stopped working. Without it, "no
 * page" and "the pager is broken" are indistinguishable.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 *
 *   - It routes to an ISSUE, not to a person. Whether that issue reaches the
 *     founder is the pipeline's business, not this job's.
 *   - It is NOT purely a nightly concern. `platform-claims` and
 *     `release-registry-reconcile` run on `push: main` too, so those runs can
 *     page. That is correct — they are real failures — but it is why this is
 *     named for the workflow's outcomes rather than for "the nightly".
 *   - Recovery does not comment. A transition back to green updates the body
 *     only, deliberately: the alarm is for the onset.
 *
 * Zero dependencies: Node builtins and `fetch` only. `check-network-imports`
 * scopes to `packages/<pkg>/src`, and `check-release-registry-reconcile.mjs` is
 * the in-repo precedent for an API-calling guard (injectable `fetchImpl`,
 * `GITHUB_TOKEN`, typed exits).
 *
 * Run: node .github/scripts/notify-nightly-status.mjs
 */

import { isProcessEntryPoint } from './lib/entry-point.mjs';

export const EXIT_OK = 0;
export const EXIT_CANNOT_CHECK = 2;

/**
 * Identifies the tracking issue. Kept in the BODY rather than the title so a
 * human may retitle it without the router losing track and opening a second.
 */
export const TRACKER_MARKER = '<!-- operum-nightly-status-tracker -->';

/** The previous state, recorded where the next run can read it back. */
const STATE_MARKER = /<!--\s*nightly-state:\s*(\w+)\s*-->/;

export const TRACKER_TITLE = 'reliability-nightly status — automated tracker';

/**
 * How each (result, token) pair is dispositioned.
 *
 * ORDER MATTERS. `NO_DATA` is checked BEFORE failure because a quiet window
 * exits 2 and therefore arrives as `failure`; reading severity first would page
 * on it. `CANNOT_CHECK` is checked before success so a token that says the
 * check did not happen pages even if the job somehow went green — "I could not
 * check" is never "it passed".
 *
 * An UNRECOGNISED result pages. Failing closed is the safe direction for a
 * router: a spurious page is noticed and fixed, a swallowed one is not.
 */
export function dispositionFor(result, token) {
  if (result === 'skipped') return 'skipped';
  if (token === 'NO_DATA') return 'quiet';
  if (token === 'CANNOT_CHECK') return 'page';
  if (result === 'failure' || result === 'cancelled' || result === 'timed_out') return 'page';
  if (result === 'success') return 'healthy';
  return 'page';
}

/**
 * Turn the `needs` context into rows plus an overall verdict.
 *
 * `needs` is passed whole (`toJSON(needs)`) rather than as one env var per job,
 * so adding a sixth job to the workflow extends this automatically. The count
 * has already been wrong twice on this issue; nothing here restates it.
 */
export function classify(needs) {
  const rows = Object.entries(needs ?? {})
    .map(([job, data]) => {
      const result = data?.result ?? 'unknown';
      const token = data?.outputs?.outcome ?? null;
      return { job, result, token, disposition: dispositionFor(result, token) };
    })
    .sort((a, b) => a.job.localeCompare(b.job));

  return { rows, alerting: rows.some((r) => r.disposition === 'page') };
}

/** The state word recorded in a body, or null when there is none to read. */
export function previousStateFrom(body) {
  const m = STATE_MARKER.exec(body ?? '');
  return m ? m[1] : null;
}

const SYMBOL = { page: '🔴 PAGE', quiet: '🟢 quiet', skipped: '⚪ skipped', healthy: '🟢 ok' };

function table(rows) {
  return [
    '| job | result | outcome token | disposition |',
    '|---|---|---|---|',
    ...rows.map((r) => `| \`${r.job}\` | ${r.result} | ${r.token ?? '—'} | ${SYMBOL[r.disposition]} |`),
  ].join('\n');
}

/**
 * The tracking issue body — rewritten every run, including green ones.
 *
 * THE TIMESTAMP IS THE POINT. It advances on every run, so a stale one is
 * evidence the router stopped running. That is what makes silence checkable.
 */
export function renderBody({ rows, alerting, runUrl, sha, timestamp }) {
  return [
    TRACKER_MARKER,
    `<!-- nightly-state: ${alerting ? 'alerting' : 'healthy'} -->`,
    '',
    `## ${alerting ? '🔴 Attention needed' : '🟢 All green'}`,
    '',
    '**This body is rewritten by every run of `reliability-nightly`, including green ones.**',
    'A body edit does not notify, so this is silent by design. Only a transition to',
    'non-green posts a comment.',
    '',
    '**If the timestamp below is stale, the router itself has stopped working** — that is',
    'the failure this heartbeat exists to make visible, because otherwise "no page" and',
    '"the pager is broken" look identical.',
    '',
    table(rows),
    '',
    `- **Last run:** ${timestamp}`,
    `- **Tree under test:** \`${sha}\``,
    `- **Run:** ${runUrl}`,
    '',
    '---',
    '',
    'Routing reads each job\'s **outcome token**, never its exit code — `NO_DATA` (a quiet',
    'window, nothing merged) and `CANNOT_CHECK` (the check could not run) share exit 2 and',
    'are not alike for notification purposes. `skipped` is silent: `integrated-tree` and',
    '`ci-throughput` skip on `push: main` by design.',
    '',
    'This routes to an issue, not to a person (#739).',
    '',
    '---',
    '*Operum Engineer · [operum.ai](https://operum.ai)*',
  ].join('\n');
}

/** The comment posted on a transition to non-green. This is what notifies. */
export function renderComment({ rows, runUrl, sha, timestamp }) {
  const paging = rows.filter((r) => r.disposition === 'page');
  return [
    '<!-- operum-agent: engineer -->',
    '## 🔴 `reliability-nightly` went non-green',
    '',
    `${paging.length} job(s) need attention:`,
    '',
    table(paging),
    '',
    `- **Tree under test:** \`${sha}\``,
    `- **Run:** ${runUrl}`,
    `- **Detected:** ${timestamp}`,
    '',
    'The issue body above carries the full status of all jobs and is refreshed on every',
    'run. Comments are posted only on the TRANSITION to non-green, so a persistent',
    'failure does not comment nightly.',
    '',
    '---',
    '*Software Engineer - Operum AI*',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* I/O — every call takes an injectable fetchImpl so the self-test needs no net */
/* -------------------------------------------------------------------------- */

async function api(fetchImpl, token, method, url, body) {
  const headers = { accept: 'application/vnd.github+json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status}`);
  return r.json();
}

/**
 * The one tracking issue, found by marker across open issues.
 *
 * Paginates rather than reading the first page: this repository already has
 * dozens of open issues, and "not on page one" would silently mean "create a
 * second tracker" — the duplication this is supposed to prevent.
 */
export async function findTracker({ fetchImpl, token, repo, maxPages = 10 }) {
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`;
    const issues = await api(fetchImpl, token, 'GET', url);
    if (!Array.isArray(issues) || issues.length === 0) return null;
    const hit = issues.find((i) => typeof i.body === 'string' && i.body.includes(TRACKER_MARKER));
    if (hit) return hit;
    if (issues.length < 100) return null;
  }
  return null;
}

export async function main({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  log = console.log,
  errorLog = console.error,
} = {}) {
  const repo = env['GITHUB_REPOSITORY'];
  const token = env['GITHUB_TOKEN'];
  const sha = env['TREE_SHA'] ?? env['GITHUB_SHA'] ?? 'unknown';
  const runUrl = env['RUN_URL'] ?? '(run URL unavailable)';
  const labels = (env['TRACKER_LABELS'] ?? 'bug,priority:high,engineering')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!repo || !token) {
    errorLog('::error::CANNOT CHECK — GITHUB_REPOSITORY or GITHUB_TOKEN is unset, so nothing could be routed.');
    errorLog('  Nothing was reported. This is NOT a pass: a nightly failure would go unheard.');
    return EXIT_CANNOT_CHECK;
  }

  let needs;
  try {
    needs = JSON.parse(env['NEEDS_JSON'] ?? '');
  } catch {
    errorLog('::error::CANNOT CHECK — NEEDS_JSON is missing or unparseable, so no job result could be read.');
    errorLog('  Nothing was reported. This is NOT a pass.');
    return EXIT_CANNOT_CHECK;
  }

  const { rows, alerting } = classify(needs);
  if (rows.length === 0) {
    errorLog('::error::CANNOT CHECK — the needs context named no jobs.');
    errorLog('  A router that reports on zero jobs is reporting nothing at all.');
    return EXIT_CANNOT_CHECK;
  }

  const timestamp = now();
  const body = renderBody({ rows, alerting, runUrl, sha, timestamp });

  for (const r of rows) log(`${r.job}: result=${r.result} token=${r.token ?? '—'} -> ${r.disposition}`);

  try {
    const tracker = await findTracker({ fetchImpl, token, repo });

    if (!tracker) {
      // First run. Creating the issue notifies by itself, so no comment is
      // posted alongside it even when alerting — that would notify twice.
      const created = await api(fetchImpl, token, 'POST', `https://api.github.com/repos/${repo}/issues`, {
        title: TRACKER_TITLE,
        body,
        labels,
      });
      log(`created tracking issue #${created.number} (state: ${alerting ? 'alerting' : 'healthy'})`);
      return EXIT_OK;
    }

    const previous = previousStateFrom(tracker.body);

    // The heartbeat: always, green or not. Silent — body edits do not notify.
    await api(fetchImpl, token, 'PATCH', `https://api.github.com/repos/${repo}/issues/${tracker.number}`, { body });
    log(`updated tracking issue #${tracker.number} body (previous state: ${previous ?? 'unknown'})`);

    // The alarm: only on the TRANSITION to non-green.
    if (alerting && previous !== 'alerting') {
      await api(fetchImpl, token, 'POST', `https://api.github.com/repos/${repo}/issues/${tracker.number}/comments`, {
        body: renderComment({ rows, runUrl, sha, timestamp }),
      });
      log(`posted transition comment on #${tracker.number}`);
    } else if (alerting) {
      log('still alerting — body refreshed, no comment (a persistent failure is one problem, not one per night)');
    }

    return EXIT_OK;
  } catch (err) {
    errorLog(`::error::CANNOT CHECK — routing failed: ${err.message}`);
    errorLog('  A nightly outcome may have gone unreported. The tracking issue body will be');
    errorLog('  STALE, which is the signal that this router stopped working.');
    return EXIT_CANNOT_CHECK;
  }
}

if (isProcessEntryPoint(import.meta.url)) {
  process.exit(await main());
}
