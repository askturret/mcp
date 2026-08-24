#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Collapse the per-package `*-status` wrapper jobs into one signal (#110).
 *
 * ## What these wrappers are for
 *
 * The test jobs are path-filtered, so on any given PR most of them SKIP. A
 * skipped job is not a passing job, and it is not a failing one either — so
 * something has to answer the only question a merge gate actually cares about:
 *
 *   > For every package this diff implicates, did a job actually test it and pass?
 *
 * That normalisation used to live in 13 separate wrapper jobs, one per package,
 * each burning a full runner slot to echo a string. This script is those 13 jobs,
 * and the workflow now runs it in one.
 *
 * ## The contract, preserved exactly
 *
 * For each `test-<key>` job:
 *   - implicated = `changes.outputs[<key>] == 'true'` OR `changes.outputs.workspace == 'true'`
 *   - implicated     -> that job's result MUST be `success`
 *   - not implicated -> satisfied, whatever the job did (it will have skipped)
 *
 * That is byte-for-byte the rule the wrappers applied. It is why a green
 * `core-status` next to a skipped `test-core` is CORRECT rather than a false
 * signal: on a cli-only PR, core is not implicated, so there is nothing to test
 * and the requirement is vacuously met.
 *
 * ## Two fail-CLOSED guards this adds
 *
 * Both are cases where the old wrappers reported success without evidence.
 *
 * 1. **The `changes` job did not succeed.** The wrappers ran under
 *    `if: always()`, so when `changes` failed or was cancelled every
 *    `needs.changes.outputs.*` interpolated to the empty string, every wrapper
 *    took its "not implicated" branch, and all 13 reported SUCCESS while zero
 *    tests had run. That is a false pass in precisely the scenario that
 *    motivated this issue — the 2026-08-21 runner-capacity outage, where jobs
 *    failed to be assigned a runner at all. Without the filter output there is no
 *    way to know what was implicated, and "I could not determine coverage" must
 *    never read as "coverage was satisfied".
 *
 * 2. **No test jobs were supplied at all.** An empty `needs` set would otherwise
 *    satisfy every requirement by having none, so the aggregate would pass while
 *    guarding nothing. A collapse from many jobs into one makes this failure mode
 *    newly reachable — a typo in the `needs` list — so it is asserted.
 *
 * A `test-<key>` whose `<key>` is not a declared filter output is treated as
 * ALWAYS implicated (must succeed) rather than ignored, which is the fail-closed
 * reading and is also correct for unfiltered always-run jobs.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{ result: string, outputs?: Record<string, string> }} NeedEntry */

/**
 * Decide the aggregate signal.
 *
 * Pure, so the self-test can drive every branch without a workflow run.
 *
 * @param {Record<string, NeedEntry>} needs - the `needs` context, as `toJSON(needs)` renders it
 * @returns {{ ok: boolean, rows: Array<{job: string, key: string, implicated: boolean, result: string, verdict: string}>, errors: string[], warnings: string[] }}
 */
export function evaluate(needs) {
  const errors = [];
  const warnings = [];
  const rows = [];

  const changes = needs?.changes;
  if (!changes) {
    errors.push("The 'changes' job is missing from `needs`; coverage cannot be determined.");
    return { ok: false, rows, errors, warnings };
  }

  // Guard 1 — see the header. No filter outputs means no way to know what was
  // implicated, which is not the same as nothing being implicated.
  if (changes.result !== 'success') {
    errors.push(
      `The 'changes' job concluded '${changes.result}', not 'success', so the path filters ` +
        'are unavailable. Refusing to report coverage: with no filter outputs, every package ' +
        'would look "not implicated" and this job would go green having tested nothing.',
    );
    return { ok: false, rows, errors, warnings };
  }

  const outputs = changes.outputs ?? {};
  const workspaceWide = outputs.workspace === 'true';

  const testJobs = Object.keys(needs)
    .filter((name) => name.startsWith('test-'))
    .sort();

  // Guard 2 — an empty set must not pass by vacuity.
  if (testJobs.length === 0) {
    errors.push(
      'No `test-*` jobs were supplied in `needs`. Refusing to pass: an empty requirement set ' +
        'is satisfied by having no requirements, which would guard nothing.',
    );
    return { ok: false, rows, errors, warnings };
  }

  for (const job of testJobs) {
    const key = job.slice('test-'.length);
    const declared = Object.prototype.hasOwnProperty.call(outputs, key);

    if (!declared) {
      // Fail-closed: an unknown key is assumed implicated. Correct both for a
      // genuinely unfiltered always-run job and for a filter someone forgot.
      warnings.push(
        `'${job}' has no matching '${key}' output on the changes job — treating it as always ` +
          'implicated (must pass). Add a path filter for it, or leave it if it always runs.',
      );
    }

    const implicated = !declared || outputs[key] === 'true' || workspaceWide;
    const result = needs[job]?.result ?? 'unknown';

    let verdict;
    if (!implicated) {
      verdict = 'not implicated';
      // Unreachable while a test job's `if:` mirrors its implication condition —
      // an unimplicated job skips, it does not run and fail. Surfaced as a
      // warning rather than an error because passing here is the contract the
      // wrappers had, and because the state means those two conditions have
      // drifted apart, which is worth seeing but is not this job's call to fail.
      if (result !== 'skipped' && result !== 'success') {
        warnings.push(
          `'${job}' was not implicated yet concluded '${result}' — it should have skipped. ` +
            "The job's `if:` condition and its path filter may have drifted apart.",
        );
      }
    } else if (result === 'success') {
      verdict = 'covered';
    } else {
      verdict = 'REQUIRED BUT NOT COVERED';
      errors.push(
        `'${job}' was required (${
          workspaceWide && outputs[key] !== 'true' ? 'workspace-wide change' : `'${key}' changed`
        }) but concluded '${result}'.`,
      );
    }

    rows.push({ job, key, implicated, result, verdict });
  }

  return { ok: errors.length === 0, rows, errors, warnings };
}

/** Render the decision as a table plus reasons. */
export function report(outcome) {
  const lines = [];
  const width = Math.max(...outcome.rows.map((r) => r.job.length), 12);

  lines.push('Per-package coverage:');
  lines.push('');
  for (const r of outcome.rows) {
    const mark = r.verdict === 'covered' ? 'x' : r.verdict === 'not implicated' ? '-' : '!';
    lines.push(`  [${mark}] ${r.job.padEnd(width)}  ${r.result.padEnd(9)}  ${r.verdict}`);
  }
  lines.push('');

  const covered = outcome.rows.filter((r) => r.verdict === 'covered').length;
  const skipped = outcome.rows.filter((r) => r.verdict === 'not implicated').length;
  lines.push(`  ${covered} covered, ${skipped} not implicated, ${outcome.rows.length} total`);

  if (outcome.warnings.length > 0) {
    lines.push('');
    for (const w of outcome.warnings) lines.push(`  WARNING: ${w}`);
  }
  if (outcome.errors.length > 0) {
    lines.push('');
    for (const e of outcome.errors) lines.push(`  ERROR: ${e}`);
  }

  return lines.join('\n');
}

/**
 * Is this module the process entry point (rather than imported by the self-test)?
 *
 * Compared as resolved FILESYSTEM PATHS, not as a hand-built `file://` string.
 * The naive `import.meta.url === \`file://${process.argv[1]}\`` fails whenever the
 * checkout path contains a character `import.meta.url` percent-encodes — a space
 * is enough — and it fails SILENTLY: the module loads, the entry block is
 * skipped, and the process exits 0 having evaluated nothing. For a script whose
 * job is to say whether a diff was tested, exiting 0 without running is the one
 * outcome that must be impossible. It was caught here by a worktree path
 * containing "Application Support".
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const raw = process.env.NEEDS_JSON;
  if (!raw) {
    console.error(
      'ERROR: NEEDS_JSON is unset. The workflow must pass `${{ toJSON(needs) }}` in that ' +
        'variable; without it this script cannot evaluate coverage and will not pass by default.',
    );
    process.exit(1);
  }

  let needs;
  try {
    needs = JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: NEEDS_JSON is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const outcome = evaluate(needs);
  console.log(report(outcome));

  if (!outcome.ok) {
    console.error('\nCoverage signal: FAILED');
    process.exit(1);
  }
  console.log('\nCoverage signal: OK');
}
