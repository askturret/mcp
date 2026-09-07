#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for notify-nightly-status.mjs (#739).
 *
 * A guard that cannot go red is not a check (ADR-024) — and a ROUTER that
 * cannot go red is worse, because its whole job is to be the thing that speaks
 * when everything else is quiet.
 *
 * THE TWO CENTRAL CASES, both of which a naive router gets wrong:
 *
 *   1. `NO_DATA` vs `CANNOT_CHECK`. Both exit 2, so both arrive as `failure`.
 *      One must page and the other must not. A router that read severity would
 *      page on every quiet weekend and be tuned out — correctly — within a
 *      fortnight.
 *   2. `skipped` vs `failure`. `integrated-tree` and `ci-throughput` skip on
 *      `push: main` by design. A router that read skipped as failed would page
 *      on every qualifying push.
 *
 * Both are asserted as PAIRS that differ in exactly one input, because a
 * one-sided assertion is satisfied by a router that always pages or never does.
 *
 * NO NETWORK. `fetchImpl` is injected, so every API interaction is asserted by
 * recording the calls rather than by making them.
 *
 * Exit codes are LOCAL LITERALS, never imported from the module under test.
 * #746 was exactly that defect: constants compared against themselves hold no
 * matter what they are, so mutating one leaves every assertion green.
 *
 * Run: node .github/scripts/notify-nightly-status.test.mjs
 */

import {
  classify,
  dispositionFor,
  previousStateFrom,
  renderBody,
  renderComment,
  findTracker,
  main,
  TRACKER_MARKER,
} from './notify-nightly-status.mjs';

// Deliberately literal. See the header.
const EXIT_OK = 0;
const EXIT_CANNOT_CHECK = 2;

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

/** A fetch double that records calls and replays queued responses. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected call: ${opts.method} ${url}`);
    if (next.throw) throw new Error(next.throw);
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.json };
  };
  return { impl, calls };
}

const ENV = {
  GITHUB_REPOSITORY: 'askturret/mcp',
  GITHUB_TOKEN: 't0ken',
  TREE_SHA: 'abc1234',
  RUN_URL: 'https://example.invalid/run/1',
};

const GREEN_NEEDS = {
  reliability: { result: 'success', outputs: {} },
  'integrated-tree': { result: 'success', outputs: {} },
  'platform-claims': { result: 'success', outputs: {} },
  'release-registry-reconcile': { result: 'success', outputs: {} },
  'ci-throughput': { result: 'success', outputs: { outcome: 'REPORTED' } },
};

const silent = () => {};
const run = (env, fetchImpl) =>
  main({ env: { ...ENV, ...env }, fetchImpl, now: () => '2026-09-07T03:00:00Z', log: silent, errorLog: silent });

/* -- 1. the disposition table, pair by pair --------------------------------- */

check('a quiet window (NO_DATA) does NOT page, even though it arrives as failure', dispositionFor('failure', 'NO_DATA') === 'quiet');
check('an unreadable API (CANNOT_CHECK) DOES page — same exit code, opposite verdict', dispositionFor('failure', 'CANNOT_CHECK') === 'page');
check('a skipped job is silent, not failed', dispositionFor('skipped', null) === 'skipped');
check('a skipped job stays silent even carrying a token', dispositionFor('skipped', 'CANNOT_CHECK') === 'skipped');
check('an ordinary failure pages', dispositionFor('failure', null) === 'page');
check('a cancelled job pages', dispositionFor('cancelled', null) === 'page');
check('a success is healthy', dispositionFor('success', 'REPORTED') === 'healthy');
check('CANNOT_CHECK pages even on a green job — "could not check" is never "passed"', dispositionFor('success', 'CANNOT_CHECK') === 'page');
check('an UNRECOGNISED result fails CLOSED and pages', dispositionFor('weird-new-state', null) === 'page');

/* -- 2. classify over the whole needs blob ---------------------------------- */
{
  const green = classify(GREEN_NEEDS);
  check('all-green is not alerting', green.alerting === false);
  check('classify covers every job it was given (five today, not a hardcoded list)', green.rows.length === 5);

  const pushRun = classify({
    ...GREEN_NEEDS,
    'integrated-tree': { result: 'skipped', outputs: {} },
    'ci-throughput': { result: 'skipped', outputs: {} },
  });
  check('a push:main run — two jobs skipped — does NOT alert', pushRun.alerting === false, JSON.stringify(pushRun.rows));

  const quiet = classify({ ...GREEN_NEEDS, 'ci-throughput': { result: 'failure', outputs: { outcome: 'NO_DATA' } } });
  check('a quiet weekend does NOT alert', quiet.alerting === false);

  const cannot = classify({ ...GREEN_NEEDS, 'ci-throughput': { result: 'failure', outputs: { outcome: 'CANNOT_CHECK' } } });
  check('an unreadable API DOES alert — the pair differs only in the token', cannot.alerting === true);

  const broken = classify({ ...GREEN_NEEDS, 'integrated-tree': { result: 'failure', outputs: {} } });
  check('a failing integrated-tree alerts', broken.alerting === true);

  const noToken = classify({ ...GREEN_NEEDS, 'ci-throughput': { result: 'failure', outputs: {} } });
  check('a failure with a MISSING token pages — the surfacing breaking must not cause silence', noToken.alerting === true);
}

/* -- 3. the heartbeat body -------------------------------------------------- */
{
  const { rows, alerting } = classify(GREEN_NEEDS);
  const body = renderBody({ rows, alerting, runUrl: 'R', sha: 'deadbee', timestamp: 'TS' });
  check('the body carries the tracker marker so the next run finds this issue', body.includes(TRACKER_MARKER));
  check('the body records the state for transition detection', previousStateFrom(body) === 'healthy');
  check('the body names the tree SHA under test', body.includes('deadbee'));
  check('the body names the run URL', body.includes('R'));
  check('the body carries the timestamp — a stale one is how silence is detected', body.includes('TS'));
  check('the body names every job, including the green ones', rows.every((r) => body.includes(r.job)));

  const alertBody = renderBody({ ...classify({ ...GREEN_NEEDS, reliability: { result: 'failure' } }), runUrl: 'R', sha: 's', timestamp: 'TS' });
  check('an alerting body records state=alerting', previousStateFrom(alertBody) === 'alerting');
  check('previousStateFrom returns null when there is no marker to read', previousStateFrom('no marker here') === null);
}

/* -- 4. the comment --------------------------------------------------------- */
{
  const { rows } = classify({ ...GREEN_NEEDS, 'platform-claims': { result: 'failure', outputs: {} } });
  const comment = renderComment({ rows, runUrl: 'R', sha: 'cafe123', timestamp: 'TS' });
  check('the comment names the failing job', comment.includes('platform-claims'));
  check('the comment names the SHA and run URL', comment.includes('cafe123') && comment.includes('R'));
  check('the comment does NOT list the healthy jobs — it is an alarm, not a report', !comment.includes('release-registry-reconcile'));
}

/* -- 5. findTracker paginates ----------------------------------------------- */
{
  const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, body: 'unrelated' }));
  const page2 = [{ number: 999, body: `x ${TRACKER_MARKER} y` }];
  const { impl, calls } = fakeFetch([{ json: page1 }, { json: page2 }]);
  const hit = await findTracker({ fetchImpl: impl, token: 't', repo: 'a/b' });
  check('findTracker looks past page one — "not on page 1" must not mean "create a duplicate"', hit?.number === 999, JSON.stringify(calls.map((c) => c.url)));

  const { impl: impl2 } = fakeFetch([{ json: [{ number: 1, body: 'nope' }] }]);
  check('findTracker returns null when no tracker exists', (await findTracker({ fetchImpl: impl2, token: 't', repo: 'a/b' })) === null);
}

/* -- 6. end-to-end: heartbeat on green, no comment --------------------------- */
{
  const { impl, calls } = fakeFetch([
    { json: [{ number: 42, body: `${TRACKER_MARKER}\n<!-- nightly-state: healthy -->` }] },
    { json: { number: 42 } },
  ]);
  const code = await run({ NEEDS_JSON: JSON.stringify(GREEN_NEEDS) }, impl);
  check('a GREEN run still updates the body — the heartbeat is what makes silence checkable', code === EXIT_OK && calls.some((c) => c.method === 'PATCH'), JSON.stringify(calls.map((c) => c.method)));
  check('a GREEN run posts NO comment — body edits do not notify', !calls.some((c) => c.method === 'POST'));
}

/* -- 7. end-to-end: transition to non-green comments ------------------------- */
{
  const needs = { ...GREEN_NEEDS, 'integrated-tree': { result: 'failure', outputs: {} } };
  const { impl, calls } = fakeFetch([
    { json: [{ number: 42, body: `${TRACKER_MARKER}\n<!-- nightly-state: healthy -->` }] },
    { json: { number: 42 } },
    { json: { id: 1 } },
  ]);
  const code = await run({ NEEDS_JSON: JSON.stringify(needs) }, impl);
  const post = calls.find((c) => c.method === 'POST');
  check('a TRANSITION to non-green posts a comment', code === EXIT_OK && !!post, JSON.stringify(calls.map((c) => c.method)));
  check('the comment goes to the existing tracker, not a new issue', post?.url.includes('/issues/42/comments') === true, post?.url);
}

/* -- 8. end-to-end: a PERSISTENT failure does not comment again -------------- */
{
  const needs = { ...GREEN_NEEDS, 'integrated-tree': { result: 'failure', outputs: {} } };
  const { impl, calls } = fakeFetch([
    { json: [{ number: 42, body: `${TRACKER_MARKER}\n<!-- nightly-state: alerting -->` }] },
    { json: { number: 42 } },
  ]);
  const code = await run({ NEEDS_JSON: JSON.stringify(needs) }, impl);
  check('four failing nights are ONE problem — still-alerting posts no second comment', code === EXIT_OK && !calls.some((c) => c.method === 'POST'));
  check('...but the body is still refreshed, so the timestamp stays live', calls.some((c) => c.method === 'PATCH'));
}

/* -- 9. end-to-end: first run creates exactly one tracker -------------------- */
{
  const { impl, calls } = fakeFetch([{ json: [] }, { json: { number: 7 } }]);
  const code = await run({ NEEDS_JSON: JSON.stringify(GREEN_NEEDS) }, impl);
  const post = calls.find((c) => c.method === 'POST');
  check('the first run creates the tracking issue', code === EXIT_OK && post?.url.endsWith('/issues') === true);
  check('the created issue carries the marker so the next run updates it instead', post?.body?.body.includes(TRACKER_MARKER) === true);
  check('exactly ONE issue is created', calls.filter((c) => c.method === 'POST').length === 1);
}

/* -- 10. CANNOT-CHECK arms: every one is exit 2, never a silent pass --------- */
{
  const { impl } = fakeFetch([]);
  check('missing NEEDS_JSON is CANNOT CHECK (exit 2)', (await run({}, impl)) === EXIT_CANNOT_CHECK);
  check('unparseable NEEDS_JSON is CANNOT CHECK (exit 2)', (await run({ NEEDS_JSON: '{not json' }, impl)) === EXIT_CANNOT_CHECK);
  check('an EMPTY needs context is CANNOT CHECK — reporting on zero jobs is reporting nothing', (await run({ NEEDS_JSON: '{}' }, impl)) === EXIT_CANNOT_CHECK);

  const noTokenEnv = { NEEDS_JSON: JSON.stringify(GREEN_NEEDS), GITHUB_TOKEN: '' };
  check('a missing GITHUB_TOKEN is CANNOT CHECK, not a quiet success', (await run(noTokenEnv, impl)) === EXIT_CANNOT_CHECK);

  // THE MUTATION-OBSERVABILITY ARM. If the router throws mid-flight it must
  // report exit 2 rather than exiting 0 having routed nothing — the failure
  // mode this whole issue is about, one level up.
  const { impl: boom } = fakeFetch([{ throw: 'network is down' }]);
  check('an API failure is CANNOT CHECK (exit 2) — a router that cannot route must SAY so', (await run({ NEEDS_JSON: JSON.stringify(GREEN_NEEDS) }, boom)) === EXIT_CANNOT_CHECK);

  const { impl: notOk } = fakeFetch([{ ok: false, status: 403, json: {} }]);
  check('a 403 from the issues API is CANNOT CHECK (exit 2), not a pass', (await run({ NEEDS_JSON: JSON.stringify(GREEN_NEEDS) }, notOk)) === EXIT_CANNOT_CHECK);
}

/* -- 11. A FAILED COMMENT POST MUST NOT SILENCE THE NEXT NIGHT -------------- */
//
// QA's finding on PR #751, and the arm that pins the fix. The persisted
// `nightly-state` is what suppresses the next comment, so writing it BEFORE the
// comment lands means one transient POST failure silences the alarm FOREVER:
// night 1 exits 2 having notified nobody, and nights 2+ exit 0 looking green
// while integrated-tree is broken. That is #739's own defect, one level up.
//
// STATEFUL ON PURPOSE. The PATCH really mutates the stored body and the GET
// reads it back, so this runs consecutive nightlies against ONE tracking issue
// rather than asserting on call ORDER. An order assertion would also pass for a
// router that called them in the right sequence and still persisted the wrong
// thing; asserting the OUTCOME cannot be satisfied that way.
{
  function trackerFixture(initialBody, failPostNumber = 1) {
    let stored = initialBody;
    let posts = 0;
    let patches = 0;
    const impl = async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (method === 'GET') return { ok: true, status: 200, json: async () => [{ number: 42, body: stored }] };
      if (method === 'PATCH') {
        patches++;
        stored = JSON.parse(opts.body).body;
        return { ok: true, status: 200, json: async () => ({ number: 42 }) };
      }
      if (method === 'POST') {
        posts++;
        if (posts === failPostNumber) throw new Error('comment POST failed (transient)');
        return { ok: true, status: 200, json: async () => ({ id: 1 }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    return { impl, posts: () => posts, patches: () => patches, stored: () => stored };
  }

  const broken = { ...GREEN_NEEDS, 'integrated-tree': { result: 'failure', outputs: {} } };
  const t = trackerFixture(`${TRACKER_MARKER}\n<!-- nightly-state: healthy -->`);

  const night1 = await run({ NEEDS_JSON: JSON.stringify(broken) }, t.impl);
  check(
    'night 1: a failed comment POST is CANNOT CHECK (exit 2), never a silent success',
    night1 === EXIT_CANNOT_CHECK,
    `exit ${night1}`,
  );
  check(
    'night 1: the alerting state is NOT persisted, because the alarm never landed',
    previousStateFrom(t.stored()) === 'healthy',
    t.stored().slice(0, 140),
  );

  const night2 = await run({ NEEDS_JSON: JSON.stringify(broken) }, t.impl);
  check(
    'NIGHT 2 STILL COMMENTS — one transient POST failure must not silence the alarm forever',
    t.posts() === 2,
    `comment attempts: ${t.posts()}`,
  );
  check('night 2 succeeds once the comment lands', night2 === EXIT_OK, `exit ${night2}`);
  check(
    '...and only THEN is the alerting state persisted',
    previousStateFrom(t.stored()) === 'alerting',
    t.stored().slice(0, 140),
  );

  // The other half of the trade. Without this the "fix" could be "always
  // comment", which is a different defect — a notification every failing night.
  const night3 = await run({ NEEDS_JSON: JSON.stringify(broken) }, t.impl);
  check(
    'night 3: still alerting and now persisted — no THIRD comment',
    night3 === EXIT_OK && t.posts() === 2,
    `exit ${night3}, comment attempts: ${t.posts()}`,
  );
  check('...but the heartbeat still refreshed', t.patches() >= 2, `patches: ${t.patches()}`);
}

/* -- 12. the two exit codes are distinct ------------------------------------ */
check('the exit codes are distinct (0 routed, 2 could-not-route)', EXIT_OK !== EXIT_CANNOT_CHECK);

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
