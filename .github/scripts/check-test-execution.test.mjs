#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the test-execution guard (#531).
 *
 * ## Why this file did not exist, and why that is the whole point
 *
 * The #431/#443 partition assigned this script to #443 "including writing their
 * self-tests". #443 closed as done via PR #507, which created
 * `generate-sbom.test.mjs` and never touched this one — and this script is not
 * among the four residuals that PR's own "deliberately not done" list names. So
 * it was an OMISSION, not a descope, and the remedy is a witness rather than an
 * exemption entry. Writing an exemption here would launder a delivery gap
 * through the ledger the exemption ledger exists to keep honest.
 *
 * ## NO SEAM REFACTOR WAS NEEDED, and that is a measurement rather than a view
 *
 * The cost note on #531 said this script exports nothing, so a self-test would
 * need a spawn seam injected first. Measured before writing any production
 * change: all three failure sites are reachable through the REAL entry point,
 * because the script is already parameterised by `process.argv[2]`.
 *
 * The third site looked like the exception — it fires only when npm cannot
 * start, and `CHILD_PATH` prepends `dirname(process.execPath)`, where npm lives
 * beside node. That is exactly #349's prior: a site that reads as unwitnessable
 * turning out to be witnessable with a fixture parameter. The parameter here is
 * WHERE THE INTERPRETER LIVES:
 *
 *   /usr/bin/npm and /bin/npm do not exist on this machine, so the only
 *   CHILD_PATH entry that supplies npm is `dirname(process.execPath)`. Run the
 *   guard with a node whose directory holds no npm, and an empty PATH, and npm
 *   is genuinely unresolvable.
 *
 * A SYMLINK will not do — Node resolves `process.execPath` through symlinks, so
 * the real directory comes back. A HARDLINK has no target to resolve, so
 * `execPath` becomes the link's own path. That is the trick, and it is stated
 * because it looks like a workaround and is load-bearing.
 *
 * Cross-device hardlinks fail, so the ladder is hardlink -> copy -> declare.
 * The declaration is a CANNOT CHECK that says which rung failed; it is never a
 * silent skip, because a case that quietly does not run is the empty pass this
 * repository has spent the week removing.
 *
 * ## The control is not decorative
 *
 * Three failure cases could all pass against a guard that fails everything, so
 * the exempt-package case pins that this guard reaches exit 0 on a clean tree.
 * It is cheap deliberately: a package declaring `askturret.testsNotRequired`
 * with no test files never spawns npm, so the control needs no installed
 * dependencies and no test runner.
 *
 * Run: node .github/scripts/check-test-execution.test.mjs
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  linkSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// `fileURLToPath`, NOT `new URL(...).pathname` — the latter percent-encodes, so a
// checkout path containing a space resolves to a file that does not exist. That is
// #110 exactly, and it caught this file while it was being written for the guard
// family whose own docs record it.
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-test-execution.mjs');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed += 1;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed += 1;
  }
}

/** A throwaway repo root: a root package.json plus the given packages. */
function fixture({ workspaces = ['packages/*'], packages = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'test-execution-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces }));
  for (const [name, { pkg, files = {} }] of Object.entries(packages)) {
    const pkgDir = join(dir, 'packages', name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(pkgDir, rel)), { recursive: true });
      writeFileSync(join(pkgDir, rel), body);
    }
  }
  return dir;
}

/** Run the guard against a fixture root, through its real entry point. */
function run(dir, { execPath = process.execPath, env = {} } = {}) {
  const r = spawnSync(execPath, [GUARD, dir], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------
// CONTROL — the guard reaches exit 0. Without this, every case below could pass
// against a guard that refuses everything.
// ---------------------------------------------------------------------------
{
  const dir = fixture({
    packages: { clean: { pkg: { name: 'clean', askturret: { testsNotRequired: 'a fixture' } } } },
  });
  const r = run(dir);
  check('CONTROL: a declared-exempt package with no test files passes', r.code, 0);
  check('CONTROL: ...and the run says what it examined', /1 package\(s\)/.test(r.out), true);
}

// ---------------------------------------------------------------------------
// SITE 1 (line 148) — an unsupported workspace pattern
// ---------------------------------------------------------------------------
{
  const dir = fixture({ workspaces: ['packages'], packages: {} });
  const r = run(dir);
  check('site: an unsupported workspace pattern exits 2', r.code, 2);
  check('site: ...and names the pattern it could not expand', /unsupported workspace pattern "packages"/.test(r.out), true);
}

// ---------------------------------------------------------------------------
// SITE 3 (line 504) — a package that executes no tests
// ---------------------------------------------------------------------------
{
  const dir = fixture({
    packages: { noop: { pkg: { name: 'noop', scripts: { test: 'exit 0' } } } },
  });
  const r = run(dir);
  check('site: a no-op test script exits 1', r.code, 1);
  check('site: ...and says a green job that ran nothing is worse than a red one', /do not execute any tests/.test(r.out), true);
  // The distinction this guard exists for: this is a COVERAGE failure, and must
  // not be reported as the environment failure below.
  check('site: ...and is NOT reported as unmeasurable', /COULD NOT BE CHECKED/.test(r.out), false);
}

// ---------------------------------------------------------------------------
// SITE 2 (line 494) — npm could not be run
//
// The site the cost note expected to need a seam. Reached by relocating the
// interpreter, per the header.
// ---------------------------------------------------------------------------
{
  const dir = fixture({
    packages: { real: { pkg: { name: 'real', scripts: { test: 'jest' } } } },
  });

  const binDir = mkdtempSync(join(tmpdir(), 'no-npm-bin-'));
  tmpDirs.push(binDir);
  const relocated = join(binDir, 'node');

  let rung = null;
  try {
    linkSync(process.execPath, relocated);
    rung = 'hardlink';
  } catch {
    try {
      copyFileSync(process.execPath, relocated);
      rung = 'copy';
    } catch {
      rung = null;
    }
  }

  // THE PRECONDITION THIS CASE RESTS ON, checked across EVERY directory the
  // guard will search (#531 re-QA).
  //
  // This check used to read `existsSync(join(binDir, 'npm'))` under the name
  // "so npm is unresolvable". It inspected ONE of the three directories and
  // claimed all of them. On a Linux runner with an apt/nodesource npm in
  // /usr/bin it passed while its own claim was false, npm started, and the
  // guard correctly took the no-tests branch instead — so the case failed and
  // the failure read as a guard defect. It was not: the name asserted three
  // times more than the check verified, which is the decorative class swept
  // five times on #540 and twice more on #541, here guarding the precondition
  // the whole case rests on.
  //
  // `/usr/bin` and `/bin` are appended UNCONDITIONALLY by the guard — my own
  // #429 PATH repair — so no fixture can remove them. The relocation trick
  // therefore works only where npm is absent from BOTH, which is true on macOS
  // (/opt/homebrew/bin) and false on many Linux images.
  // Deduped: `dirname(relocated)` IS `binDir` here, and a diagnostic that names
  // the same directory twice reads as a defect in the diagnostic.
  const childPathDirs = [...new Set([dirname(relocated), binDir, '/usr/bin', '/bin'])];
  const npmFoundIn = childPathDirs.filter((d) => existsSync(join(d, 'npm')));

  // The list above MIRRORS the guard's CHILD_PATH and cannot import it, because
  // importing a wired production script executes it. So pin the mirror: if the
  // guard's fallbacks ever change, this precondition silently goes wrong again
  // in exactly the way being fixed here.
  const guardSource = readFileSync(GUARD, 'utf-8');
  check(
    'site: the fallback list this fixture mirrors is still the guard\'s own',
    guardSource.includes("[dirname(process.execPath), process.env.PATH ?? '', '/usr/bin', '/bin']"),
    true,
  );

  if (rung === null || !existsSync(relocated)) {
    // CANNOT CHECK, said out loud. A case that quietly does not run is the
    // empty pass this repository has spent the week removing.
    console.log(
      'CANNOT CHECK - site: npm-cannot-start is unwitnessed here — the interpreter could not be ' +
        'relocated (hardlink and copy both failed), so `dirname(process.execPath)` could not be ' +
        'made npm-free. The site is reachable; this ENVIRONMENT could not reach it.',
    );
  } else if (npmFoundIn.length > 0) {
    // THE LADDER'S THIRD RUNG, reached for a second reason. Nothing about the
    // guard is in question and no expectation is weakened: the site is
    // reachable, and this HOST cannot reach it because npm sits in a directory
    // the guard always searches.
    console.log(
      `CANNOT CHECK - site: npm-cannot-start is unwitnessed here — npm is present in ` +
        `${npmFoundIn.join(', ')}, which the guard appends to the child PATH unconditionally, so ` +
        `no fixture can make npm unresolvable on this host. The site is reachable; this ` +
        `ENVIRONMENT cannot reach it.`,
    );
  } else {
    check(
      `site: the interpreter relocated via ${rung}, and npm is in none of ${childPathDirs.join(', ')}`,
      npmFoundIn.length,
      0,
    );
    const r = run(dir, { execPath: relocated, env: { PATH: binDir } });
    check('site: npm that cannot start exits 2', r.code, 2);
    check('site: ...and says it COULD NOT BE CHECKED', /COULD NOT BE CHECKED/.test(r.out), true);
    // THE DISTINCTION THIS SITE EXISTS FOR (#429): a measurement that could not
    // be taken must not be reported as a defect in the thing being measured.
    check(
      'site: ...and does NOT report it as a package that runs no tests',
      /do not execute any tests/.test(r.out),
      false,
    );
  }
}

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
