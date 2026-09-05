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
 *
 * THE ENTRY POINT, NOT A COUNT OF dist/ ENTRIES (#592)
 * ---------------------------------------------------------------------------
 * "Carries at least one dist/ path" is the property this guard could see, not
 * the property that matters. A tarball carrying `dist/index.d.ts` and not
 * `dist/index.js` satisfies it completely: the types ship, the code does not,
 * and requiring the published package throws. So the files the manifest NAMES
 * — `main` and every `bin` target — are asserted individually.
 *
 * That also settles which exit code a codeless tarball earns, on evidence
 * rather than preference. Absence from the pack list always fires; the disk is
 * then consulted ONLY to separate two states that pack output renders
 * identically:
 *
 *   built on disk but absent from the tarball -> DIVERGENCE (exit 1). The build
 *     ran and the code still did not ship, so this is a fact, not an unknown.
 *   absent from both -> UNBUILT -> CANNOT CHECK (exit 2), as before.
 *
 * Note this does NOT reintroduce the directory inference the header above
 * rejects. That mistake was reading the DIRECTORY to conclude something about
 * the TARBALL. Here the tarball is always the thing asserted, and the
 * directory only explains a failure that has already been established.
 *
 * PAGE METADATA AND README LINKS (#596)
 * ---------------------------------------------------------------------------
 * #583 asked whether README.md is PRESENT. It shipped nine packages whose
 * READMEs were present and useless: three lines pointing at `../../README.md`,
 * a filesystem-relative path that resolves to nothing on an npm page, in
 * manifests carrying no `repository` — so npm rendered no Repository link and
 * had no base URL to rewrite the relative link against. Every tarball passed.
 *
 * "Useful" is not mechanically checkable and this guard does not pretend to
 * check it. Two NARROWER properties are, and they are the two that failed:
 *
 *   - the manifest carries `repository` (with a `directory` naming THIS
 *     package), `homepage` and `bugs` — without which the page has no route
 *     back to the source at all;
 *   - the README that ships contains no repository-relative link.
 *
 * WHY READING THE README HERE IS NOT THE MISTAKE THIS GUARD EXISTS TO AVOID.
 * The tree-versus-tarball distinction is about PRESENCE: `files` decides
 * whether a file ships, so a file on disk may be absent from the tarball. It is
 * not about CONTENT — npm copies the bytes of whatever it does ship verbatim.
 * So the content check is sound provided presence is established FIRST, from
 * the pack list, and that is the order used below: a README that the pack list
 * does not carry is reported as a divergence and its content is never read.
 *
 * Anchors (`#section`) are accepted: they resolve within the rendered README
 * itself and are correct on an npm page. Only links that escape the document
 * are rejected.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isProcessEntryPoint } from './lib/entry-point.mjs';

/** Entries every public tarball must carry. */
export const REQUIRED_TARBALL_ENTRIES = ['README.md', 'LICENSE', 'NOTICE'];

/**
 * Entries that must be BYTE-IDENTICAL to the repository root's copy (#587).
 *
 * PRESENT IS NOT CURRENT, and presence is all this guard used to assert. The
 * nine per-package copies are snapshots taken when #583 landed;
 * `generate-notice.mjs` writes only the ROOT `NOTICE`. So the moment a
 * dependency changes, the root regenerates, the nine keep the old content, and
 * this guard finds a file named NOTICE in each tarball and exits 0 — nine
 * tarballs shipping a stale attribution list with every gate agreeing they are
 * compliant. A presence check passes forever on a file whose content drifted.
 *
 * WHY BYTE EQUALITY rather than a hash or a normalised comparison. Measured on
 * this tree before choosing: all nine NOTICE copies and all nine LICENSE copies
 * are byte-identical to the root today. So byte equality is the STATUS QUO
 * being asserted, not a new constraint imposed on the tree — nothing has to
 * change to satisfy it.
 *   - A hash is byte equality with an extra step: same verdict, worse failure
 *     message. It can say "differs" but not what differs.
 *   - A normalised comparison (trim, collapse whitespace, ignore line endings)
 *     would accept a copy that RENDERS differently from the root, and the
 *     normalisation rule is itself a hand-maintained thing that can drift —
 *     a tuning surface on a compliance check, which is what this repository
 *     keeps finding it does not want. Byte equality has no tuning surface.
 *
 * WHY LICENSE IS HERE TOO, and it is a different risk rather than the same one.
 * NOTICE regenerates, so its drift is EXPECTED to happen eventually. LICENSE is
 * static Apache-2.0 text and does not regenerate, so it drifts only by hand
 * edit or by a licence change that updates the root and misses the copies —
 * lower probability, higher consequence. Same one-line comparison, same
 * canonical source, so it is asserted here rather than left inferred.
 *
 * WHY README.md IS DELIBERATELY ABSENT. It is NOT a mirror of the root: the
 * nine READMEs are per-package by design and all nine legitimately differ from
 * the root README — measured, not assumed. Byte equality would be WRONG for it.
 * README already has its own content-level assertion from #596 (no
 * repository-relative links), which is the right property for a file whose
 * whole point is to be different. Presence-versus-content does not apply to it
 * in this form.
 */
export const MIRRORED_ROOT_ENTRIES = ['NOTICE', 'LICENSE'];

export const EXIT_OK = 0;
export const EXIT_DIVERGENCE = 1;
export const EXIT_CANNOT_CHECK = 2;

/**
 * Link targets that render correctly on an npm package page.
 *
 * `#anchor` resolves inside the rendered README itself. Everything else here is
 * absolute. A repository-relative path is what #596 shipped, and it is exactly
 * what this list excludes.
 */
const ACCEPTABLE_LINK_TARGET = /^(https?:\/\/|mailto:|#)/;

/**
 * Every repository-relative link target in a markdown document.
 *
 * Both link forms are scanned. Reference definitions (`[label]: target`) carry
 * no `](`, so an inline-only scan would miss a whole syntax — none is used in
 * this repository today, which is precisely why a guard that ignored it could
 * go stale without anyone noticing.
 */
export function findRelativeLinks(markdown) {
  const targets = [];
  // Inline links and images: `](target)`, optionally followed by a "title".
  for (const m of markdown.matchAll(/\]\(\s*([^)\s]+)/g)) targets.push(m[1]);
  // Reference definitions: `[label]: target` at the start of a line.
  for (const m of markdown.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)) targets.push(m[1]);

  return targets.filter((t) => !ACCEPTABLE_LINK_TARGET.test(t));
}

/**
 * Manifest fields an npm page needs to be navigable, and why each one.
 *
 * `repository.directory` is checked against the package's OWN directory rather
 * than merely being present: nine manifests gaining this field in one change is
 * the classic copy-paste site, and a wrong `directory` points npm's "Repository"
 * link at another package's source while looking entirely correct in review.
 */
/**
 * The files a manifest NAMES as its entry points: `main`, and every `bin`
 * target. Paths are normalised to the form `npm pack --json` reports (no
 * leading `./`), so a manifest writing `./dist/cli.js` compares equal to a
 * pack list carrying `dist/cli.js`.
 *
 * WHY THESE AND NOT A COUNT. The pre-existing check asks whether the tarball
 * carries ANY `dist/` entry, which is the property it can see rather than the
 * property that matters (#592). A tarball carrying `dist/index.d.ts` and not
 * `dist/index.js` satisfies a count completely: types ship, the code does not,
 * and `require()` of the published package throws. Naming the entry point
 * turns "something was built" into "the thing this package IS was packed".
 *
 * `main` and `bin` are on npm's always-included list, so npm tries to pack
 * them whether or not `files` names them. Their absence therefore means the
 * file was not there to pack, or was actively excluded — never that npm merely
 * did not think to include it.
 */
export function expectedEntryPoints(manifest) {
  const out = [];
  const add = (v) => {
    if (typeof v === 'string' && v !== '') out.push(v.replace(/^\.\//, ''));
  };

  add(manifest.main);
  if (typeof manifest.bin === 'string') add(manifest.bin);
  else if (manifest.bin && typeof manifest.bin === 'object') for (const v of Object.values(manifest.bin)) add(v);

  return [...new Set(out)];
}

export function findManifestMetadataIssues(manifest, dir) {
  const issues = [];
  const repo = manifest.repository;

  if (!repo || typeof repo !== 'object' || typeof repo.url !== 'string' || repo.url === '') {
    issues.push('manifest has no `repository` — npm renders no Repository link and cannot resolve relative README links');
  } else if (typeof repo.directory !== 'string' || repo.directory === '') {
    issues.push('manifest `repository` has no `directory` — required for npm to locate this package inside the monorepo');
  } else if (repo.directory !== dir) {
    issues.push(`manifest \`repository.directory\` is "${repo.directory}" but this package lives in "${dir}"`);
  }

  if (typeof manifest.homepage !== 'string' || manifest.homepage === '') {
    issues.push('manifest has no `homepage`');
  }
  if (!manifest.bugs || typeof manifest.bugs.url !== 'string' || manifest.bugs.url === '') {
    issues.push('manifest has no `bugs.url` — `npm bugs` does not work for this package');
  }

  return issues;
}

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
    found.push({ dir, name: manifest.name, keywords: manifest.keywords, manifest });
  }
  return found;
}

/**
 * THE REPOSITORY ROOT MUST REFUSE TO PUBLISH (#591).
 *
 * The root manifest is named `@askturret/mcp`, a name nothing has claimed on
 * the registry — so a bare `npm publish` at the root collides with nothing, and
 * would ship the WHOLE repository: source, configs, `.github/`, `.operum/` and
 * the audit logs, under an immutable version that can only be superseded, never
 * withdrawn. Measured before this guard existed: 909 files, 6.3MB unpacked,
 * `.github/CODEOWNERS` and every guard script among them.
 *
 * Not hypothetical here. `0.1.1` was published to npm BY HAND from a local
 * machine rather than by CI, so a bare local invocation is how this project has
 * actually released.
 *
 * ## TWO properties, because the obvious one does not hold on its own
 *
 * `private: true` is the declarative statement and is asserted first. But it
 * DOES NOT BY ITSELF STOP A BARE ROOT PUBLISH. npm gates that check on the
 * publish being a WORKSPACE publish — `npm/lib/commands/publish.js`:
 *
 *     // if a workspace package is marked private then we skip it
 *     if (workspace && manifest.private) { throw EPRIVATE }
 *
 * A bare root publish has no workspace context, so the branch is never taken.
 * Verified on npm 11.8.0 BEFORE reading that source: with `private: true` set,
 * `npm publish --dry-run` at the root packed all 909 files and exited 0,
 * without mentioning `private` at all.
 *
 * So the second property is a `prepublishOnly` script that exits non-zero,
 * which npm runs before packing regardless of workspace context. That is what
 * actually refuses; `private: true` is what says so declaratively, and what
 * would refuse on an npm whose gate is not conditional.
 *
 * Both are asserted, because either alone is a half-measure — and the one a
 * reader would assume sufficient is the one that is not.
 */
export function findRootPublishGuardIssues(repoRoot) {
  const errors = [];
  const manifestPath = join(repoRoot, 'package.json');

  if (!existsSync(manifestPath)) {
    return { errors, cannotCheck: [`${manifestPath} does not exist, so the root cannot be checked`] };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return { errors, cannotCheck: [`root package.json is not valid JSON (${err && err.message})`] };
  }

  if (manifest.private !== true) {
    errors.push(
      'the root package.json is missing `"private": true` — a bare `npm publish` at the root ' +
        'would ship the entire repository to a public registry (#591)',
    );
  }

  const prepublish = manifest.scripts?.prepublishOnly;
  if (typeof prepublish !== 'string' || prepublish.trim() === '') {
    errors.push(
      'the root package.json has no `prepublishOnly` script — `private: true` alone does NOT stop ' +
        'a bare root publish, because npm gates that check on `workspace && manifest.private` (#591)',
    );
  }

  return { errors, cannotCheck: [] };
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
  const readmeIssues = [];

  // Checked BEFORE the per-package work, and independently of it: the root is
  // not one of the discovered packages — it is the one that must never become
  // one — so a run that discovers nothing must still report on it (#591).
  const rootGuard = findRootPublishGuardIssues(repoRoot);
  divergences.push(...rootGuard.errors);
  cannotCheck.push(...rootGuard.cannotCheck);

  if (packages.length === 0) {
    cannotCheck.push('no public packages were discovered under packages/ — nothing was verified');
  }

  // #587: the CANONICAL copies, read ONCE. Reading them inside the per-package
  // loop would emit the same unreadable-root message nine times for one cause,
  // which buries the finding in its own repetition.
  //
  // A root file that cannot be read is cannot-check, never a pass: the currency
  // claim has no canonical side to compare against, and "I could not check" is
  // not "it matched". It is deliberately NOT a divergence either — nothing is
  // known to have drifted; the question simply went unanswered.
  const rootMirrors = new Map();
  for (const entry of MIRRORED_ROOT_ENTRIES) {
    try {
      rootMirrors.set(entry, readFileSync(join(repoRoot, entry)));
    } catch (err) {
      cannotCheck.push(
        `the root ${entry} could not be read (${err && err.message}) — no package's ${entry} was ` +
          'checked for currency against it',
      );
    }
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

    // #587: CURRENCY, not presence — and only once the pack list has
    // established that this copy is the one that ships. Same ordering the
    // README content check below uses, for the same reason: when the entry is
    // absent the presence divergence above has already fired, and reading the
    // directory copy would be answering a question about a file the tarball
    // does not contain.
    for (const entry of MIRRORED_ROOT_ENTRIES) {
      if (!files.has(entry)) continue;
      const rootBytes = rootMirrors.get(entry);
      if (rootBytes === undefined) continue; // root unreadable — already reported once, above

      let pkgBytes;
      try {
        pkgBytes = readFileSync(join(repoRoot, pkg.dir, entry));
      } catch (err) {
        cannotCheck.push(
          `${pkg.name}: ${entry} is in the tarball but could not be read from ${pkg.dir} ` +
            `(${err && err.message}) — it was NOT checked against the root ${entry}`,
        );
        continue;
      }

      if (!rootBytes.equals(pkgBytes)) {
        divergences.push(
          `${pkg.name}: ${entry} ships but has DRIFTED from the root ${entry} — the tarball is ` +
            `compliant in FORM and its contents are stale. Copy the root ${entry} over ` +
            `${pkg.dir}/${entry}; note that generate-notice.mjs rewrites only the root, so the ` +
            'per-package copies do not follow it automatically.',
        );
      }
    }

    const hasDistEntries = packed.files.filter((f) => f.startsWith('dist/')).length > 0;
    if (!hasDistEntries) {
      cannotCheck.push(
        `${pkg.name}: packed with no dist/ entries — the package looks UNBUILT, so this tarball is not ` +
          'representative. Run `npm run build` before this guard. Compliance NOT asserted.',
      );
    }

    // #592: the ENTRY POINT, not a count of dist/ entries.
    //
    // The check above is satisfied by any single dist/ path, so a tarball
    // carrying dist/index.d.ts and not dist/index.js passes it while shipping
    // no code. This asserts the file the manifest actually names.
    //
    // THE DISK READ IS A DISAMBIGUATOR, NOT AN INFERENCE — and the distinction
    // is the one this guard's header exists to protect. Directory presence is
    // never taken as tarball presence: absence from the PACK LIST is what
    // fires, always. Disk is consulted only afterwards, to decide which of two
    // indistinguishable-from-pack-output states produced it:
    //
    //   built on disk, absent from tarball -> DIVERGENCE. The build ran and the
    //     tarball still lacks the code, so `files` (or .npmignore) excluded it.
    //     Nothing is unknown here, so reporting cannot-check would understate a
    //     fact we hold.
    //   absent both places -> UNBUILT, already reported cannot-check above.
    //     Exit 2 is kept for this deliberately: from pack output alone unbuilt
    //     and misconfigured are the same observation, and a guard must not
    //     assert a divergence the evidence cannot distinguish. Exit 2 already
    //     blocks, so nothing is let through by classifying it honestly.
    for (const entry of expectedEntryPoints(pkg.manifest || {})) {
      if (files.has(entry)) continue;
      if (existsSync(join(repoRoot, pkg.dir, entry))) {
        divergences.push(
          `${pkg.name}: ${entry} is named by the manifest and EXISTS on disk, but is NOT in the published ` +
            'tarball — the build ran and the tarball still carries no code. A consumer installing this ' +
            'version gets a package whose entry point is missing.',
        );
      } else if (hasDistEntries) {
        // Not on disk, so unbuilt — but the coarse dist/ check did NOT fire,
        // because the tarball carries some OTHER dist/ path. This is the exact
        // state that made a count insufficient: `dist/index.d.ts` ships, the
        // entry point does not, and without this branch the package exits 0.
        cannotCheck.push(
          `${pkg.name}: ${entry} is named by the manifest but is in neither the tarball nor ${pkg.dir} — ` +
            'the tarball carries other dist/ entries, so a count of them says "built" while the entry ' +
            'point is absent. Run `npm run build` before this guard. Compliance NOT asserted.',
        );
      }
      // else: absent from both AND no dist/ at all — already reported UNBUILT
      // by the check above. Reporting it twice would not add a fact.
    }

    // Manifest-level, and reported apart on purpose: package.json always ships,
    // so this is a discoverability defect rather than a tarball one. Folding it
    // in with the licence findings would blur exactly the distinction this
    // guard was rewritten to make.
    if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) {
      manifestIssues.push(`${pkg.name}: manifest has no keywords array`);
    }

    // #596: the page-metadata fields, same category and same reasoning.
    for (const issue of findManifestMetadataIssues(pkg.manifest || {}, pkg.dir)) {
      manifestIssues.push(`${pkg.name}: ${issue}`);
    }

    // #596: README CONTENT — and only once the pack list has established that
    // this README is the one that ships. When it is absent the divergence above
    // has already fired, so reading the directory copy would be answering a
    // question about a file the tarball does not contain.
    if (files.has('README.md')) {
      const readmePath = join(repoRoot, pkg.dir, 'README.md');
      let readme;
      try {
        readme = readFileSync(readmePath, 'utf-8');
      } catch (err) {
        cannotCheck.push(
          `${pkg.name}: README.md is in the tarball but could not be read from ${pkg.dir} (${err && err.message}) — its links were NOT checked`,
        );
      }
      if (readme !== undefined) {
        for (const target of findRelativeLinks(readme)) {
          readmeIssues.push(
            `${pkg.name}: README links to "${target}", a repository-relative path that resolves to nothing on the npm page`,
          );
        }
      }
    }
  }

  const checked = packages.length - cannotCheck.length;
  console.log(
    `check-tarball-compliance: packed ${Math.max(checked, 0)} of ${packages.length} public package(s); ` +
      `${divergences.length} divergence(s), ${cannotCheck.length} cannot-check, ${manifestIssues.length} manifest issue(s), ` +
      `${readmeIssues.length} README link issue(s).`,
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
    console.error('   Fix: add the field to the package\'s package.json. See #596 for the shape.');
  }
  if (readmeIssues.length > 0) {
    console.error('\n❌ README LINK — this renders as a dead link on the npm package page:');
    for (const r of readmeIssues) console.error(`   ${r}`);
    console.error('   Fix: make the link absolute (https://github.com/askturret/mcp/...). An npm page has');
    console.error('   no repository context, so a relative path has nothing to resolve against.');
  }
  if (cannotCheck.length > 0) {
    console.error('\n⚠️  CANNOT CHECK — packing did not produce a verdict for:');
    for (const c of cannotCheck) console.error(`   ${c}`);
    console.error('   This is NOT a pass. Nothing above was verified for these packages.');
  }

  if (divergences.length > 0 || manifestIssues.length > 0 || readmeIssues.length > 0) {
    console.error(
      `\n::error::${divergences.length + manifestIssues.length + readmeIssues.length} tarball compliance failure(s).`,
    );
    return EXIT_DIVERGENCE;
  }
  if (cannotCheck.length > 0) {
    console.error(`\n::error::CANNOT CHECK — ${cannotCheck.length} package(s) could not be verified.`);
    return EXIT_CANNOT_CHECK;
  }

  console.log(
    'check-tarball-compliance: OK — every public tarball carries README.md, LICENSE and NOTICE, ' +
      'every shipped NOTICE and LICENSE is byte-identical to the repository root copy, ' +
      'every manifest carries repository/homepage/bugs, and no shipped README links to a relative path.',
  );
  return EXIT_OK;
}

if (isProcessEntryPoint(import.meta.url)) {
  process.exit(main(process.argv));
}
