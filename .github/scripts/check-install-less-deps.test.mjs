#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for check-install-less-deps.mjs (#743).
 *
 * A guard that cannot go red is not a check (ADR-024), so every arm is driven
 * here: the clean case, the forbidden import, the transitive one, and all four
 * cannot-check paths.
 *
 * THE CENTRAL CASE IS THE DISCRIMINATOR. The same bare import is placed in two
 * fixtures that differ ONLY in whether the job runs `npm ci`, and the guard
 * must fail one and pass the other. Without that pair a guard that simply
 * rejected every bare import anywhere would pass this file while being a
 * completely different — and wrong — check.
 *
 * EXIT CODES ARE ASSERTED AS LITERALS, NEVER IMPORTED FROM THE GUARD. #746 was
 * exactly that defect one file over: a self-test that compared the guard's
 * exported constants against themselves holds no matter what those constants
 * are, so mutating `EXIT_CANNOT_CHECK` to 0 left every assertion green while
 * the cannot-check arm silently became a pass. Literals here are the whole
 * point — if someone renumbers the contract, this file goes red.
 *
 * Spawns the guard rather than importing it, which is check-runners.test.mjs's
 * convention and what lets the guard run unconditionally — see the note at the
 * foot of the guard for why an `import.meta.url` entry check fails silently on
 * a checkout path containing a space.
 *
 * Run: node .github/scripts/check-install-less-deps.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, 'check-install-less-deps.mjs');
const REPO_ROOT = resolve(HERE, '..', '..');

// Deliberately literal. See the header.
const EXIT_OK = 0;
const EXIT_FORBIDDEN_DEPENDENCY = 1;
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

function runGuard(repoRoot) {
  const r = spawnSync(process.execPath, [GUARD, repoRoot], { encoding: 'utf-8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const roots = [];
function repo(label) {
  const root = mkdtempSync(join(tmpdir(), `check-install-less-deps-${label}-`));
  roots.push(root);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, '.github', 'scripts'), { recursive: true });
  return root;
}

function writeWorkflow(root, name, body) {
  writeFileSync(join(root, '.github', 'workflows', name), body);
}

function writeScript(root, name, body) {
  const path = join(root, '.github', 'scripts', name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** A job that runs `script` with NO install step. */
function installLessWorkflow(script) {
  return [
    'name: lane',
    'on: [push]',
    'jobs:',
    '  lane-claim:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    `      - run: node .github/scripts/${script}`,
    '',
  ].join('\n');
}

/** The same job, with an install step ahead of the script. */
function installFullWorkflow(script, installCommand = 'npm ci') {
  return [
    'name: lane',
    'on: [push]',
    'jobs:',
    '  lane-claim:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    `      - run: ${installCommand}`,
    `      - run: node .github/scripts/${script}`,
    '',
  ].join('\n');
}

const BUILTIN_ONLY = "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync);\n";
const BARE_IMPORT = "import yaml from 'js-yaml';\nconsole.log(yaml);\n";

try {
  // --- the real repository passes ---------------------------------------------
  {
    const { status, out } = runGuard(REPO_ROOT);
    check(
      'the real repository passes — every install-less script is builtin-only',
      status === EXIT_OK,
      `exit ${status}\n${out.trim()}`,
    );
    check(
      'a passing run PRINTS the derived inventory — exit 0 with no output is a silent no-op',
      status === EXIT_OK && /install-less job\(s\)/.test(out),
      out.trim(),
    );
    check(
      'the inventory names the jobs it derived, so the count never has to be written down',
      /lane-check\.yml::lane-claim/.test(out) && /supply-chain\.yml::readiness/.test(out),
      out.trim(),
    );
  }

  // --- THE DISCRIMINATOR: identical script, install vs no install --------------
  {
    const noInstall = repo('bare-no-install');
    writeWorkflow(noInstall, 'lane.yml', installLessWorkflow('offender.mjs'));
    writeScript(noInstall, 'offender.mjs', BARE_IMPORT);
    const bad = runGuard(noInstall);

    const withInstall = repo('bare-with-install');
    writeWorkflow(withInstall, 'lane.yml', installFullWorkflow('offender.mjs'));
    writeScript(withInstall, 'offender.mjs', BARE_IMPORT);
    const good = runGuard(withInstall);

    check(
      'a bare import in an INSTALL-LESS job fails',
      bad.status === EXIT_FORBIDDEN_DEPENDENCY,
      `exit ${bad.status}\n${bad.out.trim()}`,
    );
    check(
      'the SAME bare import in a job that runs `npm ci` passes',
      good.status === EXIT_OK,
      `exit ${good.status}\n${good.out.trim()}`,
    );
    check(
      'the failure names the offending script and the specifier',
      /offender\.mjs/.test(bad.out) && /js-yaml/.test(bad.out),
      bad.out.trim(),
    );
    check(
      'the failure names the job that would have broken',
      /lane\.yml::lane-claim/.test(bad.out),
      bad.out.trim(),
    );
  }

  // --- builtins and relative imports are allowed -------------------------------
  {
    const root = repo('builtins');
    writeWorkflow(root, 'lane.yml', installLessWorkflow('clean.mjs'));
    writeScript(root, 'clean.mjs', "import { readFileSync } from 'node:fs';\nimport { join } from 'path';\nimport './helper.mjs';\nconsole.log(readFileSync, join);\n");
    writeScript(root, 'helper.mjs', BUILTIN_ONLY);
    const { status, out } = runGuard(root);
    check(
      'node: builtins, unprefixed builtins and relative imports all pass',
      status === EXIT_OK,
      `exit ${status}\n${out.trim()}`,
    );
  }

  // --- the walk is TRANSITIVE ---------------------------------------------------
  {
    const root = repo('transitive');
    writeWorkflow(root, 'lane.yml', installLessWorkflow('entry.mjs'));
    writeScript(root, 'entry.mjs', "import './lib/helper.mjs';\n");
    writeScript(root, 'lib/helper.mjs', BARE_IMPORT);
    const { status, out } = runGuard(root);
    check(
      'a dependency reached through a relative import two levels down is caught',
      status === EXIT_FORBIDDEN_DEPENDENCY,
      `exit ${status}\n${out.trim()}`,
    );
    check('the failure names the transitive file, not just the entry point', /helper\.mjs/.test(out), out.trim());
  }

  // --- dynamic import() and require() are seen ---------------------------------
  {
    const dyn = repo('dynamic');
    writeWorkflow(dyn, 'lane.yml', installLessWorkflow('dyn.mjs'));
    writeScript(dyn, 'dyn.mjs', "const y = await import('js-yaml');\nconsole.log(y);\n");
    const dynResult = runGuard(dyn);
    check(
      "a dynamic import('js-yaml') is caught, not just a static one",
      dynResult.status === EXIT_FORBIDDEN_DEPENDENCY,
      `exit ${dynResult.status}\n${dynResult.out.trim()}`,
    );

    const req = repo('require');
    writeWorkflow(req, 'lane.yml', installLessWorkflow('req.cjs'));
    writeScript(req, 'req.cjs', "const y = require('js-yaml');\nconsole.log(y);\n");
    const reqResult = runGuard(req);
    check(
      "a require('js-yaml') in a .cjs script is caught",
      reqResult.status === EXIT_FORBIDDEN_DEPENDENCY,
      `exit ${reqResult.status}\n${reqResult.out.trim()}`,
    );

    const dynBuiltin = repo('dynamic-builtin');
    writeWorkflow(dynBuiltin, 'lane.yml', installLessWorkflow('ok.mjs'));
    writeScript(dynBuiltin, 'ok.mjs', "const { appendFileSync } = await import('node:fs');\nconsole.log(appendFileSync);\n");
    const okResult = runGuard(dynBuiltin);
    check(
      "a dynamic import('node:fs') is still a builtin and passes",
      okResult.status === EXIT_OK,
      `exit ${okResult.status}\n${okResult.out.trim()}`,
    );
  }

  // --- other package managers count as installing ------------------------------
  {
    for (const cmd of ['pnpm install', 'yarn install', 'npm i']) {
      const root = repo(`pm-${cmd.replace(/\W+/g, '-')}`);
      writeWorkflow(root, 'lane.yml', installFullWorkflow('offender.mjs', cmd));
      writeScript(root, 'offender.mjs', BARE_IMPORT);
      const { status, out } = runGuard(root);
      check(`\`${cmd}\` counts as installing, so the job is out of scope`, status === EXIT_OK, `exit ${status}\n${out.trim()}`);
    }
  }

  // --- a job with no scripts at all is not in the inventory ---------------------
  {
    const root = repo('no-scripts');
    writeWorkflow(root, 'lane.yml', ['name: lane', 'on: [push]', 'jobs:', '  build:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo hello', ''].join('\n'));
    const { status, out } = runGuard(root);
    check('a workflow that runs no .github/scripts code passes with an empty inventory', status === EXIT_OK, `exit ${status}\n${out.trim()}`);
  }

  // --- CANNOT CHECK arms --------------------------------------------------------
  {
    const missingDir = mkdtempSync(join(tmpdir(), 'check-install-less-deps-nodir-'));
    roots.push(missingDir);
    const r1 = runGuard(missingDir);
    check(
      'no .github/workflows directory is CANNOT CHECK (exit 2), not a pass',
      r1.status === EXIT_CANNOT_CHECK,
      `exit ${r1.status}\n${r1.out.trim()}`,
    );
    check('it says nothing was verified', /NOT a pass/.test(r1.out), r1.out.trim());

    const empty = repo('empty');
    const r2 = runGuard(empty);
    check(
      'an empty workflows directory is CANNOT CHECK (exit 2)',
      r2.status === EXIT_CANNOT_CHECK,
      `exit ${r2.status}\n${r2.out.trim()}`,
    );

    const unparseable = repo('unparseable');
    // The construct from fca8746 — a colon-space inside an unquoted scalar.
    writeWorkflow(unparseable, 'broken.yml', ['name: lane', 'on: [push]', 'jobs:', '  x:', '    steps:', '      - run: echo "Integrated tree under test: $GITHUB_SHA"', ''].join('\n'));
    const r3 = runGuard(unparseable);
    check(
      'an unparseable workflow is CANNOT CHECK (exit 2) — its jobs cannot join the inventory',
      r3.status === EXIT_CANNOT_CHECK,
      `exit ${r3.status}\n${r3.out.trim()}`,
    );

    const absent = repo('absent-script');
    writeWorkflow(absent, 'lane.yml', installLessWorkflow('not-on-disk.mjs'));
    const r4 = runGuard(absent);
    check(
      'a script named by a job but absent from disk is CANNOT CHECK (exit 2), not a pass',
      r4.status === EXIT_CANNOT_CHECK,
      `exit ${r4.status}\n${r4.out.trim()}`,
    );
    check('the cannot-check names the missing script', /not-on-disk\.mjs/.test(r4.out), r4.out.trim());
  }

  // --- the three outcomes are genuinely distinct --------------------------------
  {
    check(
      'the three exit codes are pairwise distinct (0 pass, 1 finding, 2 cannot-check)',
      EXIT_OK !== EXIT_FORBIDDEN_DEPENDENCY &&
        EXIT_OK !== EXIT_CANNOT_CHECK &&
        EXIT_FORBIDDEN_DEPENDENCY !== EXIT_CANNOT_CHECK,
    );
  }
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
