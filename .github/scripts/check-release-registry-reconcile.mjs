#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * GitHub Releases vs the npm registry (#599).
 *
 * A GitHub Release existing has never been evidence that npm has the package,
 * and until this script nothing in the repository compared the two. That gap
 * cost ~19 hours of a `priority:critical` issue describing a condition which had
 * been resolved for 18 of them: the failure was invisible, the recovery was
 * invisible, and the only detector in either direction was a person deciding to
 * look.
 *
 * ## Why this is a scheduled OBSERVER and not a release-path GATE
 *
 * The obvious design — a `verify-published` job with `needs: [publish]` — cannot
 * work, and it fails in precisely the case it would exist for:
 *
 *   - `needs: [publish]` SKIPS when `publish` fails. A skipped job reports
 *     nothing. The one run that must speak is the one that goes quiet.
 *   - The manual publish that actually repaired the incident happened AFTER an
 *     already-red run, off the release path entirely. No event on that path
 *     would have observed the recovery.
 *
 * So this reads the REGISTRY on a SCHEDULE. It observes end state rather than
 * workflow outcome, which is the only thing that distinguishes "the publish
 * succeeded" from "the publish reported success".
 *
 * ## Two directions, and they detect different failures
 *
 *   RELEASE -> REGISTRY   a published Release whose version is absent from the
 *                         registry. THE PUBLISH DID NOT LAND. This is the
 *                         incident above.
 *
 *   REGISTRY -> RELEASE   a version on the registry with no corresponding
 *                         Release. A MANUAL PUBLISH — something reached the
 *                         registry without going through the release path, so
 *                         no provenance, no SBOM, no readiness matrix.
 *
 * Both are real. Neither implies the other, and dropping either leaves a whole
 * class of divergence unobserved.
 *
 * ## The baseline, and why it is entries rather than a cutoff
 *
 * `0.1.0` sits on the registry for every public package and no `v0.1.0` Release
 * was ever cut. Implemented literally the registry->release direction is red on
 * its first run and red every night after, for a fact nobody can now change —
 * and a detector that is always red is one people stop reading, which is the
 * same defect as having no detector.
 *
 * The baseline is therefore a list of NAMED, DATED, REASONED package+version
 * pairs in `.github/release-registry-baseline.json`. It is deliberately NOT a
 * "ignore anything older than X" cutoff: a cutoff silences the exact case this
 * direction exists to catch, because the next manual publish will also be
 * "older than" some later version. A new manual publish still fires. Weakening
 * the direction was the other available move and it is the wrong one.
 *
 * Every baseline entry is reported on every run, so a suppression is visible
 * rather than silent.
 *
 * ## Attestation is REPORTED, never asserted
 *
 * Provenance has never held on this project — neither `0.1.0` nor `0.1.1`
 * carries an attestation. Reporting it per version is what makes an unattested
 * version distinguishable from an automated one. It is an UNMET GUARANTEE, not
 * a regression, so it never contributes to the exit code.
 *
 * ## EXIT CODES
 *   0  releases and registry agree, modulo declared baseline entries
 *   1  DIVERGENCE in either direction
 *   2  CANNOT CHECK — live state could not be read
 *
 * EXIT 2 IS EXPECTED AND CORRECT when the registry or the API cannot be
 * reached. It reddens the nightly job and gates nothing (#535/#281). Do not
 * convert it to a pass, and do not move this into the PR path: a networked
 * check there has no good failure mode — cannot-read as fail reddens every PR
 * during an outage, cannot-read as pass is the #281 violation this exists to
 * prevent.
 *
 * Run: node .github/scripts/check-release-registry-reconcile.mjs [repoRoot] --live
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessEntryPoint } from './lib/entry-point.mjs';

export const EXIT_OK = 0;
export const EXIT_DIVERGENCE = 1;
export const EXIT_CANNOT_CHECK = 2;

export const BASELINE_REL = '.github/release-registry-baseline.json';

/** A release tag `v1.2.3` names version `1.2.3`. Anything else is not a release we publish from. */
export function versionOfTag(tag) {
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag ?? ''));
  return m ? m[1] : null;
}

/**
 * The public packages, DERIVED from the workspace rather than listed here.
 *
 * A hardcoded set of names is the tally this repository keeps having to remove:
 * it goes wrong the day a tenth package ships, and it goes wrong silently,
 * because a reconciler that does not know about a package cannot report it
 * missing. Reading `private` from each manifest cannot drift from the manifests.
 */
export function discoverPublicPackages(rootDir) {
  const dir = join(rootDir, 'packages');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (err) {
    return { packages: null, reason: `cannot read packages/ (${err?.message ?? err})` };
  }
  const packages = [];
  for (const d of entries) {
    const manifest = join(dir, d.name, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf-8'));
      if (pkg.private !== true && typeof pkg.name === 'string') packages.push(pkg.name);
    } catch (err) {
      return { packages: null, reason: `cannot parse ${d.name}/package.json (${err?.message ?? err})` };
    }
  }
  if (packages.length === 0) {
    // The vacuity guard. An empty set makes every comparison below trivially
    // true, which is how a check rots into decoration (#63).
    return { packages: null, reason: 'no public workspace packages were discovered, so nothing could be compared' };
  }
  return { packages: packages.sort() };
}

/** Baseline entries: exact package+version pairs, each with a reason and a date. */
export function readBaseline(rootDir) {
  const p = join(rootDir, BASELINE_REL);
  if (!existsSync(p)) return { entries: [], reason: null };
  try {
    const doc = JSON.parse(readFileSync(p, 'utf-8'));
    if (!Array.isArray(doc?.baseline)) return { entries: null, reason: `${BASELINE_REL} has no \`baseline\` array` };
    return { entries: doc.baseline };
  } catch (err) {
    return { entries: null, reason: `${BASELINE_REL} is not valid JSON (${err?.message ?? err})` };
  }
}

/**
 * LIVE READER — the only networked part, and the only part the self-test
 * replaces. Injected below so both arms (divergence and cannot-check) are
 * witnessable offline and deterministically.
 */
export async function readLiveState({
  owner = 'askturret',
  repo = 'mcp',
  token = process.env['GITHUB_TOKEN'],
  packages = [],
  fetchImpl = globalThis.fetch,
} = {}) {
  const unreadable = [];
  let releases = null;
  const registry = {};

  try {
    const headers = { accept: 'application/vnd.github+json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`, { headers });
    if (!r.ok) unreadable.push({ what: 'releases', reason: `GitHub releases API returned ${r.status}` });
    else {
      const body = await r.json();
      releases = body
        .filter((x) => x && x.draft !== true)
        .map((x) => ({ tag: x.tag_name, publishedAt: x.published_at, prerelease: x.prerelease === true }));
    }
  } catch (err) {
    unreadable.push({ what: 'releases', reason: `GitHub releases API unreachable (${err?.message ?? err})` });
  }

  for (const name of packages) {
    try {
      const r = await fetchImpl(`https://registry.npmjs.org/${name.replace('/', '%2f')}`);
      if (r.status === 404) { registry[name] = { versions: {}, absent: true }; continue; }
      if (!r.ok) { unreadable.push({ what: name, reason: `registry returned ${r.status}` }); continue; }
      const doc = await r.json();
      const versions = {};
      for (const [v, meta] of Object.entries(doc.versions ?? {})) {
        versions[v] = { attested: Boolean(meta?.dist?.attestations) };
      }
      registry[name] = { versions, absent: false };
    } catch (err) {
      unreadable.push({ what: name, reason: `registry unreachable (${err?.message ?? err})` });
    }
  }

  return { releases, registry, unreadable };
}

/**
 * THE COMPARISON — pure, so the self-test drives it directly with fixtures.
 *
 * `releases` may be null only when the reader said so; that is a cannot-check,
 * never an empty set. "I could not read the releases" and "there are no
 * releases" must not render identically (#281).
 */
export function reconcile({ releases, registry, packages, baseline = [] }) {
  const divergences = [];
  const cannotCheck = [];
  const attestations = [];
  const suppressed = [];

  // How much of the intended comparison actually happened. Carried out of here
  // so the report can state what WAS and was NOT compared instead of asserting
  // a flat "nothing" that is false the moment one package read fine (#649).
  const considered = packages.length;
  let compared = 0;

  if (releases === null) {
    cannotCheck.push('the release list could not be read, so neither direction could be compared');
    return { divergences, cannotCheck, attestations, suppressed, compared, considered };
  }

  const baselined = new Set(baseline.map((b) => `${b.package}@${b.version}`));
  const releaseVersions = new Set(releases.map((r) => versionOfTag(r.tag)).filter(Boolean));

  for (const name of packages) {
    const entry = registry[name];
    if (entry === undefined) {
      cannotCheck.push(`${name}: not read from the registry, so it could not be compared`);
      continue;
    }
    compared += 1;

    // ---- RELEASE -> REGISTRY. The publish did not land. ---------------------
    for (const version of [...releaseVersions].sort()) {
      if (entry.versions[version] === undefined) {
        divergences.push(
          `${name}@${version}: a GitHub Release exists for v${version} but the registry does NOT carry that ` +
            `version. The publish did not land — this is the failure a green release run cannot rule out.`,
        );
      }
    }

    // ---- REGISTRY -> RELEASE. Something published outside the path. ---------
    for (const version of Object.keys(entry.versions).sort()) {
      if (releaseVersions.has(version)) continue;
      const key = `${name}@${version}`;
      if (baselined.has(key)) { suppressed.push(key); continue; }
      divergences.push(
        `${name}@${version}: the registry carries this version but NO GitHub Release names v${version}. ` +
          `It reached npm outside the release path, so it has no provenance, no SBOM and no readiness verdict. ` +
          `If this is known and permanent, it needs a dated entry in ${BASELINE_REL} — never a version cutoff.`,
      );
    }

    // ---- Attestation: REPORTED, never asserted. -----------------------------
    for (const version of Object.keys(entry.versions).sort()) {
      attestations.push(`${name}@${version}: provenance ${entry.versions[version].attested ? 'PRESENT' : 'ABSENT'}`);
    }
  }

  return { divergences, cannotCheck, attestations, suppressed, compared, considered };
}

export async function checkLive({ rootDir, readState = readLiveState }) {
  const discovered = discoverPublicPackages(rootDir);
  if (discovered.packages === null) {
    return { code: EXIT_CANNOT_CHECK, divergences: [], cannotCheck: [discovered.reason], attestations: [], suppressed: [], compared: 0, considered: 0 };
  }
  const base = readBaseline(rootDir);
  if (base.entries === null) {
    return { code: EXIT_CANNOT_CHECK, divergences: [], cannotCheck: [base.reason], attestations: [], suppressed: [], compared: 0, considered: 0 };
  }

  const { releases, registry, unreadable } = await readState({ packages: discovered.packages });
  const result = reconcile({ releases, registry, packages: discovered.packages, baseline: base.entries });
  const cannotCheck = [...unreadable.map((u) => `${u.what}: ${u.reason}`), ...result.cannotCheck];

  // Cannot-check OUTRANKS divergence. A partial read can manufacture a
  // divergence that is really an unread package, so an incomplete comparison is
  // reported as incomplete rather than as a finding.
  const code = cannotCheck.length > 0 ? EXIT_CANNOT_CHECK : result.divergences.length > 0 ? EXIT_DIVERGENCE : EXIT_OK;
  return { ...result, cannotCheck, code };
}

/**
 * PRINTS the run. The exit code is `checkLive`'s ranking, never re-derived here.
 *
 * Split out of `main()` so the self-test can drive it offline with injected
 * sinks. The MIXED state — a genuine divergence AND an unreadable package in the
 * same run — is not exercised by either pure case, and it is the only state in
 * which the old reporting was wrong (#649).
 *
 * Cannot-check outranks divergence for the EXIT CODE, and that ordering stays:
 * an unread package can manufacture a "missing from the registry" finding that
 * is really an outage. But outranking a finding is not the same as deleting it.
 * Divergences are printed whenever they were found, and the incomplete-read
 * block then says why the run is still not a pass. Nothing computed is
 * discarded, and no sentence claims more than was actually compared — see
 * docs/adr/ADR-024-output-must-vary-with-the-fact.md.
 */
export function report(result, { log = console.log, error = console.error } = {}) {
  const { divergences, cannotCheck, attestations, suppressed, compared = 0, considered = 0 } = result;

  for (const a of attestations) log(`   ${a}`);
  if (suppressed.length > 0) {
    log(`\ncheck-release-registry-reconcile: ${suppressed.length} baselined pair(s), declared in ${BASELINE_REL}:`);
    for (const s of suppressed) log(`   ${s}`);
  }

  if (divergences.length > 0) {
    error('\ncheck-release-registry-reconcile: DIVERGENCE\n');
    for (const d of [...new Set(divergences)].sort()) error(`  - ${d}`);
    error(`\n${divergences.length} divergence(s).`);
  }

  if (cannotCheck.length > 0) {
    error('\ncheck-release-registry-reconcile: CANNOT CHECK — live state could not be read:');
    for (const c of cannotCheck) error(`   ${c}`);
    error(
      compared === 0
        ? '   Nothing was compared. This is NOT a pass.'
        : `   ${compared} of ${considered} package(s) were compared; the rest could not be read. ` +
            'This is NOT a pass — an incomplete comparison cannot rule out what it never read.',
    );
    if (divergences.length > 0) {
      error(
        `   The ${divergences.length} divergence(s) above were found among the packages that COULD be ` +
          'read, and stand as findings. Cannot-check outranks them for the exit code only.',
      );
    }
    return;
  }

  if (divergences.length > 0) return;

  log(
    `\ncheck-release-registry-reconcile: OK — every GitHub Release is on the registry and every registry ` +
      `version has a Release${suppressed.length ? `, modulo ${suppressed.length} declared baseline pair(s)` : ''}.`,
  );
}

export async function main(argv) {
  const rootDir = argv[2] && !argv[2].startsWith('--') ? argv[2] : '.';
  if (!argv.includes('--live')) {
    console.error(
      'check-release-registry-reconcile: refusing to run without --live.\n' +
        '   This check reads the network. It is a SCHEDULED observer, not a PR gate (#535).',
    );
    return EXIT_CANNOT_CHECK;
  }

  const result = await checkLive({ rootDir });
  report(result);
  return result.code;
}

if (isProcessEntryPoint(import.meta.url)) {
  process.exit(await main(process.argv));
}
