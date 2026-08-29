#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace-artifact composite check (#324).
 *
 * Adding a workspace member invalidates artifacts that no local build or test
 * command consults: `npm ci` reads a lockfile that local installs ignore, and
 * `NOTICE` and the licence policy read the *installed dependency set*. None of
 * it is reachable from "build it and run the tests", which is why PR #322's
 * local verification was real, thorough, and blind to both.
 *
 * ## Why one composite rather than three guards
 *
 * Because CI runs them in sequence and they fail in sequence. On `51c126d`
 * every job died at `npm ci` — which runs before anything else — so the NOTICE
 * check never executed. Fixing the lockfile did not *cause* a new failure; it
 * made an existing one REACHABLE. That cost two red round-trips for one
 * change, and separate guards reproduce it exactly.
 *
 * So this is a COLLECT-THEN-REPORT loop, deliberately: every item runs, every
 * result is collected, and all findings are reported together. There is no
 * `&&` and no early return anywhere in `runChecks`. A version that exits on
 * the first finding would rebuild the very sequencing this exists to remove —
 * which is why the self-test's central case is *both drifted, both named in
 * one report*, and why it also asserts that later runners were still INVOKED
 * after an earlier one failed. Checking the output alone would pass a guard
 * that short-circuits and happens to print a stale summary.
 *
 * ## "Could not check" is never a pass
 *
 * `check-licenses.mjs` needs `node_modules`; the other two do not. So the item
 * most likely to be skipped on a developer's machine is exactly the one that
 * would silently report clean if absence were treated as success. It is
 * reported as `COULD NOT CHECK` and the process exits non-zero.
 *
 * That is this repository's most expensive recurring defect (#5646): "I could
 * not check" quietly becoming "it passed".
 *
 * ## What this buys, stated honestly
 *
 * Both failures are ALREADY caught in CI today (`npm ci` in `test.yml`,
 * `generate-notice.mjs --check` in `supply-chain.yml`). Run in CI only, this
 * collapses two red round-trips into one. It does not eliminate them.
 *
 * Eliminating the round-trip needs the check to run BEFORE the push, and
 * nothing here enforces that: the repository has no git hooks, no `.husky`,
 * no `core.hooksPath`, and hooks are not shared by clone in any case. The npm
 * script and the CONTRIBUTING line make this DISCOVERABLE, not ENFORCED.
 *
 *   - run locally      -> the round-trip is eliminated
 *   - not run locally  -> halved, from two red pushes to one
 *   - never run        -> advisory only
 *
 * `sbom.cdx.json` is deliberately not covered: it regenerates identically and
 * CI builds it as an artifact rather than diffing it. Verified on #324, not
 * assumed — recorded here so nobody re-investigates it.
 *
 * Usage:
 *   node .github/scripts/check-workspace-artifacts.mjs [rootDir]
 *   npm run check:workspace-artifacts
 *
 * Exit codes:
 *   0 - every item passed
 *   1 - at least one item is KNOWN to have drifted
 *   2 - nothing drifted, but at least one item COULD NOT BE EVALUATED
 *
 * 1 outranks 2 because a known drift is the more actionable signal; both are
 * non-zero, so neither is ever mistaken for clean.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const PASS = 'pass';
export const FAIL = 'fail';
export const UNKNOWN = 'unknown';

/**
 * Run every check, collect every result, report them together.
 *
 * No short-circuit: the loop has no early return and no `&&`. Reporting the
 * findings together is the entire point of #324.
 *
 * @param {Array<{name: string, artifact: string, run: () => {status: string, detail: string}}>} checks
 * @returns {{results: Array<object>, code: number}}
 */
export function runChecks(checks) {
  const results = [];

  for (const check of checks) {
    let outcome;
    try {
      outcome = check.run();
    } catch (err) {
      // A runner that throws is a runner that did not answer. That is
      // "could not check", never "passed".
      outcome = { status: UNKNOWN, detail: `runner threw: ${err && err.message}` };
    }
    results.push({ name: check.name, artifact: check.artifact, ...outcome });
  }

  const anyFailed = results.some((r) => r.status === FAIL);
  const anyUnknown = results.some((r) => r.status === UNKNOWN);
  const code = anyFailed ? 1 : anyUnknown ? 2 : 0;

  return { results, code };
}

/** Render the collected results as one report naming every item. */
export function formatReport(results) {
  const label = { [PASS]: 'ok            ', [FAIL]: 'DRIFTED       ', [UNKNOWN]: 'COULD NOT CHECK' };
  const lines = results.map((r) => `  ${label[r.status]} ${r.artifact}${r.detail ? ` — ${r.detail}` : ''}`);

  const drifted = results.filter((r) => r.status === FAIL);
  const unknown = results.filter((r) => r.status === UNKNOWN);

  lines.push('');
  if (drifted.length === 0 && unknown.length === 0) {
    lines.push(`All ${results.length} workspace artifact(s) are up to date.`);
  } else {
    if (drifted.length > 0) {
      lines.push(
        `${drifted.length} of ${results.length} artifact(s) DRIFTED: ${drifted.map((r) => r.artifact).join(', ')}`,
      );
      lines.push('Regenerate them together, not one per push — that sequencing is #324.');
    }
    if (unknown.length > 0) {
      lines.push(
        `${unknown.length} of ${results.length} artifact(s) COULD NOT BE CHECKED: ${unknown
          .map((r) => r.artifact)
          .join(', ')}`,
      );
      lines.push('Not reported as a pass. "I could not check" is not "it passed".');
    }
  }

  return lines.join('\n');
}

/** Map a child process result onto our three states. */
function fromExit(res, { failDetail, unknownDetail }) {
  if (res.error || typeof res.status !== 'number') {
    return { status: UNKNOWN, detail: `${unknownDetail}: ${res.error ? res.error.message : 'no exit status'}` };
  }
  if (res.status === 0) return { status: PASS, detail: '' };
  if (res.status === 2) return { status: UNKNOWN, detail: unknownDetail };
  return { status: FAIL, detail: failDetail };
}

/** The real checks, in the order a reader would regenerate them. */
export function defaultChecks(rootDir) {
  return [
    {
      name: 'lockfile',
      artifact: 'package-lock.json',
      run: () => {
        const res = spawnSync('npm', ['ci', '--dry-run', '--offline'], {
          cwd: rootDir,
          encoding: 'utf8',
        });
        return fromExit(res, {
          failDetail: 'out of sync with package.json — regenerate with `npm install`',
          unknownDetail: 'could not run `npm ci --dry-run`',
        });
      },
    },
    {
      name: 'notice',
      artifact: 'NOTICE',
      run: () => {
        const res = spawnSync(process.execPath, [join(here, 'generate-notice.mjs'), '--check'], {
          cwd: rootDir,
          encoding: 'utf8',
        });
        return fromExit(res, {
          failDetail: 'stale — regenerate with `node .github/scripts/generate-notice.mjs`',
          unknownDetail: 'generate-notice.mjs could not evaluate the dependency inventory',
        });
      },
    },
    {
      name: 'licences',
      artifact: 'licence policy',
      run: () => {
        // Checked before spawning so the reason is specific. This is the item
        // most likely to be unevaluable locally, and a vague "could not check"
        // on the one that matters most would be its own defect.
        if (!existsSync(join(rootDir, 'node_modules'))) {
          return {
            status: UNKNOWN,
            detail: 'node_modules is absent, so the installed dependency set cannot be read — run `npm ci` first',
          };
        }
        const res = spawnSync(process.execPath, [join(here, 'check-licenses.mjs')], {
          cwd: rootDir,
          encoding: 'utf8',
        });
        return fromExit(res, {
          failDetail: 'a dependency licence violates policy — see LICENSE_EXCEPTIONS.md',
          unknownDetail: 'check-licenses.mjs could not read the dependency inventory',
        });
      },
    },
  ];
}

function isProcessEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry).endsWith('check-workspace-artifacts.mjs');
}

if (isProcessEntryPoint()) {
  const rootDir = resolve(process.argv[2] ?? join(here, '..', '..'));
  const { results, code } = runChecks(defaultChecks(rootDir));

  console.log('Workspace artifacts — every item checked, all findings reported together (#324):\n');
  console.log(formatReport(results));

  if (code === 1) console.error('::error::workspace artifacts have drifted');
  if (code === 2) console.error('::error::a workspace artifact could not be evaluated — failing closed');

  process.exit(code);
}
