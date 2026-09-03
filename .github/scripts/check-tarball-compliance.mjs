#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tarball compliance guard (#583).
 *
 * Asserts that every PUBLIC workspace package's PUBLISHED TARBALL carries the
 * Apache-2.0 artifacts: README.md, LICENSE (§4(a), the licence copy) and
 * NOTICE (§4(d), the pass-through), plus a non-empty dist/.
 *
 * IT PACKS. IT DOES NOT READ THE DIRECTORY — and that distinction is the whole
 * issue.
 * ---------------------------------------------------------------------------
 * The first version of this guard called fs.existsSync() on the package
 * directory. That is precisely the inference #583 was filed to correct: the
 * source tree looked fine, docs/releasing.md's rehearsal criterion passed, and
 * the tarball was still wrong — caught by a human reading a rendered npm page.
 *
 * npm ships only what `files` names, PLUS a fixed always-included list:
 *
 *     package.json, README, LICENSE / LICENCE, the "main" file, the "bin" file(s)
 *
 * NOTICE is NOT on that list. So with `files: ["dist"]`, a NOTICE sitting in
 * the package directory is EXCLUDED from the tarball — and a directory check
 * exits 0 green while every published artifact is missing it. Directory
 * presence is not tarball presence, and the gap between the two IS this issue.
 * Only packing proves the tarball.
 *
 * Note the asymmetry this guard exists to survive: README.md and LICENSE would
 * ship today even if `files` did not name them, because npm always includes
 * them. NOTICE ships ONLY because `files` names it. The guard asserts the
 * packed result either way, so it does not depend on which of the two reasons
 * is doing the work — nor on npm's default list staying as it is.
 *
 * EXIT CODES
 * ---------------------------------------------------------------------------
 *   0  every public package's packed file list carries every required entry
 *   1  DIVERGENCE — a required file is missing from a tarball. The real failure
 *   2  CANNOT CHECK — packing could not produce a verdict (npm absent, npm
 *      pack failed, unparseable JSON, no file list, or the package is unbuilt)
 *
 * Precedence: 1 outranks 2 — a confirmed missing file beats an unknown — but
 * BOTH are always printed. Narrowing to one exit code must not narrow the
 * report.
 *
 * NEVER exit 0 when packing did not happen. "I could not check" is not "it
 * passed" (#281). This guard blocks a PR, so a cannot-check here is a red that
 * a human must resolve rather than a silent green — which is the correct
 * direction for a licence-compliance claim, unlike the networked case in
 * check-platform-claims.mjs where an upstream outage must not redden every PR.
 * There is no network here: npm packs from the local tree.
 *
 * ORDERING — THIS GUARD MUST RUN AFTER THE BUILD.
 * ---------------------------------------------------------------------------
 * `npm pack` reports dist/ only if the package has actually been built. An
 * unbuilt package is reported CANNOT CHECK (exit 2), never a pass: "unbuilt"
 * and "dist misconfigured out of the tarball" are indistinguishable from the
 * pack output alone, and an indistinguishable state must not resolve as
 * success.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Entries every public tarball must carry. */
export const REQUIRED_TARBALL_ENTRIES = ['README.md', 'LICENSE', 'NOTICE'];

export const EXIT_OK = 0;
export const EXIT_DIVERGENCE = 1;
export const EXIT_CANNOT_CHECK = 2;

/**
 * Public workspace packages, DISCOVERED rather than hardcoded.
 *
 * A hardcoded list is the shape that goes stale silently: a new public package
 * would simply not be checked, and nothing would say so. Discovery means a new
 * package is covered the day it appears, and a package that flips to private
 * drops out on the same day.
 */
export function discoverPublicPackages(repoRoot) {
  const packagesDir = join(repoRoot, 'packages');
  if (!existsSync(packagesDir)) return [];

  const found = [];
  const entries = readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  for (const entry of entries) {
    const dir = `packages/${entry.name}`;
    const manifestPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      // Unreadable, so its visibility is unknown. Surfaced as cannot-check
      // rather than skipped: skipping would drop a package out of the guard
      // on the strength of a parse error.
      found.push({ dir, name: null, unreadable: String(err && err.message) });
      continue;
    }

    if (manifest.private === true) continue;
    found.push({ dir, name: manifest.name, keywords: manifest.keywords });
  }
  return found;
}

/**
 * Default packer. `npm` is spawned BY NAME so a fake npm earlier on PATH can
 * decide the outcome — the seam the self-test drives the cannot-check arms
 * through without needing npm to be genuinely broken.
 */
function defaultPackRunner(repoRoot, pkgName) {
  return spawnSync('npm', ['pack', '--dry-run', '--json', '--workspace', pkgName], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Pack one package and return its file list, or the reason we have none. */
export function packPackage(repoRoot, pkgName, runner = defaultPackRunner) {
  const result = runner(repoRoot, pkgName);

  if (!result || result.error) {
    const code = (result && result.error && (result.error.code || result.error.message)) || 'unknown';
    return { ok: false, reason: `npm could not be started (${code})` };
  }
  if (result.status !== 0) {
    const tail = String(result.stderr || '').trim().split('\n').slice(-2).join(' | ');
    return { ok: false, reason: `npm pack exited ${result.status}${tail ? ` — ${tail}` : ''}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: 'npm pack --json produced output that is not JSON' };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, reason: 'npm pack --json reported no package entry' };
  }

  const entry = parsed.find((e) => e && e.name === pkgName) || parsed[0];
  if (!entry || !Array.isArray(entry.files)) {
    return { ok: false, reason: 'npm pack --json entry carried no file list' };
  }

  return { ok: true, files: entry.files.map((f) => f && f.path).filter((p) => typeof p === 'string') };
}

export function main(argv, runner = defaultPackRunner) {
  const repoRoot = argv[2] || '.';
  const packages = discoverPublicPackages(repoRoot);

  const divergences = [];
  const cannotCheck = [];
  const manifestIssues = [];

  if (packages.length === 0) {
    cannotCheck.push('no public packages were discovered under packages/ — nothing was verified');
  }

  for (const pkg of packages) {
    if (pkg.unreadable) {
      cannotCheck.push(`${pkg.dir}: package.json could not be parsed (${pkg.unreadable})`);
      continue;
    }

    const packed = packPackage(repoRoot, pkg.name, runner);
    if (!packed.ok) {
      cannotCheck.push(`${pkg.name}: ${packed.reason}`);
      continue;
    }

    const files = new Set(packed.files);
    for (const required of REQUIRED_TARBALL_ENTRIES) {
      if (!files.has(required)) {
        divergences.push(`${pkg.name}: ${required} is NOT in the published tarball`);
      }
    }

    if (packed.files.filter((f) => f.startsWith('dist/')).length === 0) {
      cannotCheck.push(
        `${pkg.name}: packed with no dist/ entries — the package looks UNBUILT, so this tarball is not ` +
          'representative. Run `npm run build` before this guard. Compliance NOT asserted.',
      );
    }

    // Manifest-level, and reported apart on purpose: package.json always ships,
    // so this is a discoverability defect rather than a tarball one. Folding it
    // in with the licence findings would blur exactly the distinction this
    // guard was rewritten to make.
    if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) {
      manifestIssues.push(`${pkg.name}: manifest has no keywords array`);
    }
  }

  const checked = packages.length - cannotCheck.length;
  console.log(
    `check-tarball-compliance: packed ${Math.max(checked, 0)} of ${packages.length} public package(s); ` +
      `${divergences.length} divergence(s), ${cannotCheck.length} cannot-check, ${manifestIssues.length} manifest issue(s).`,
  );

  // BOTH categories are always printed, whichever exit code wins below.
  if (divergences.length > 0) {
    console.error('\n❌ TARBALL DIVERGENCE — a required file is missing from the PUBLISHED tarball:');
    for (const d of divergences) console.error(`   ${d}`);
    console.error('   Fix: add the file to the package\'s `files` array in package.json.');
  }
  if (manifestIssues.length > 0) {
    console.error('\n❌ MANIFEST:');
    for (const m of manifestIssues) console.error(`   ${m}`);
  }
  if (cannotCheck.length > 0) {
    console.error('\n⚠️  CANNOT CHECK — packing did not produce a verdict for:');
    for (const c of cannotCheck) console.error(`   ${c}`);
    console.error('   This is NOT a pass. Nothing above was verified for these packages.');
  }

  if (divergences.length > 0 || manifestIssues.length > 0) {
    console.error(
      `\n::error::${divergences.length + manifestIssues.length} tarball compliance failure(s).`,
    );
    return EXIT_DIVERGENCE;
  }
  if (cannotCheck.length > 0) {
    console.error(`\n::error::CANNOT CHECK — ${cannotCheck.length} package(s) could not be verified.`);
    return EXIT_CANNOT_CHECK;
  }

  console.log('check-tarball-compliance: OK — every public tarball carries README.md, LICENSE and NOTICE.');
  return EXIT_OK;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exit(main(process.argv));
}
