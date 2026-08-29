// SPDX-License-Identifier: Apache-2.0
/**
 * Shared dependency inventory for the supply-chain checks (#24).
 *
 * One source of truth for "what is installed, at what version, under what
 * licence, and is it runtime or dev" — used by the licence gate, the NOTICE
 * generator and the SBOM scope tagger, so the three cannot disagree.
 *
 * Reads the installed tree rather than a lockfile: package-lock.json is
 * gitignored in this repo, and the installed tree is what actually ships.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { didNotStart, spawnFailureDetail } from '../sdk-upgrade-drill.mjs';

/** Workspace packages are first-party; they are not third-party dependencies. */
export const FIRST_PARTY_SCOPE = '@askturret/';

/**
 * Interpret a completed `npm ls` spawn result as the set of package names in
 * that view.
 *
 * Separated from the spawn itself so the cannot-check rows are testable: a
 * process that fails to start cannot be produced on demand from a self-test,
 * and a signal-killed one cannot be produced at all.
 *
 * THROWS rather than returning an empty set whenever npm did not deliver a
 * tree. All three consumers (`check-licenses`, `generate-notice`,
 * `generate-sbom`) wrap `inventory()` in try/catch and `process.exit(2)`, so a
 * throw IS the existing cannot-check path. An empty set is not a weaker answer
 * than a throw — it is a confident and wrong one.
 *
 * @param {{status: number|null, stdout: string|null, stderr: string|null,
 *          error?: Error, signal?: string|null}} run
 * @param {boolean} omitDev - true for the runtime-only view
 */
export function npmLsNamesFrom(run, omitDev) {
  const label = `npm ls --all${omitDev ? ' --omit=dev' : ''}`;

  // Tested BEFORE parsing, because the parse is what destroys the distinction.
  // A spawn that never started has `stdout: null`, and the old
  // `JSON.parse(run.stdout || '{}')` turned that into a valid tree with no
  // dependencies. `inventory()` then classifies every package as `development`
  // (nothing is in the runtime set), and `generate-notice` rewrites NOTICE to
  // say the product bundles no third-party dependencies — and exits 0. That is
  // an Apache-2.0 §4(d) attribution failure presenting as a clean pass (#464).
  //
  // `didNotStart` is imported rather than reimplemented: this repo already owns
  // that vocabulary (#371), and an inlined copy is what dropped the defence
  // below in #443 finding 2.
  if (didNotStart(run)) {
    throw new Error(
      `${label} never started, so the dependency set is UNKNOWN: ${spawnFailureDetail(run)}\n` +
        'Refusing to report an empty dependency set, which would be indistinguishable ' +
        'from a project that genuinely bundles nothing third-party.',
    );
  }

  // A non-zero exit is NOT by itself cannot-check: `npm ls` exits non-zero on
  // peer-dependency complaints while still emitting a complete tree, which is
  // the tolerance the original `|| '{}'` was reaching for. No output at all is
  // a different thing, and it is the row that must not be tolerated.
  if (typeof run.stdout !== 'string' || run.stdout.trim() === '') {
    throw new Error(
      `${label} ran but produced no output, so the dependency set is UNKNOWN:\n` +
        `${(run.stderr || '').slice(0, 2000)}`,
    );
  }

  let tree;
  try {
    tree = JSON.parse(run.stdout);
  } catch {
    throw new Error(`${label} produced unparseable output:\n${(run.stderr || '').slice(0, 2000)}`);
  }

  const names = new Set();
  const walk = (node) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      names.add(name);
      if (child && typeof child === 'object') walk(child);
    }
  };
  walk(tree);
  return names;
}

/**
 * Run `npm ls` and return the set of package names in that view.
 *
 * @param {string} repoRoot
 * @param {boolean} omitDev - true for the runtime-only view
 */
function npmLsNames(repoRoot, omitDev) {
  const args = ['ls', '--all', '--json'];
  if (omitDev) args.push('--omit=dev');

  const run = spawnSync('npm', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });

  return npmLsNamesFrom(run, omitDev);
}

/**
 * Normalise a package.json licence field to an SPDX expression string.
 *
 * Returns null when the package declares no usable licence — which the gate
 * treats as a failure, not as "probably fine".
 */
export function licenseOf(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();

  // Deprecated shapes still in the wild.
  if (pkg.license && typeof pkg.license === 'object' && typeof pkg.license.type === 'string') {
    return pkg.license.type.trim();
  }
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const types = pkg.licenses
      .map((l) => (typeof l === 'string' ? l : l?.type))
      .filter((t) => typeof t === 'string' && t.trim());
    if (types.length === 1) return types[0].trim();
    if (types.length > 1) return `(${types.join(' OR ')})`;
  }
  return null;
}

/** Recursively collect every installed package directory under a node_modules root. */
function collectInstalled(nodeModulesDir, out) {
  if (!existsSync(nodeModulesDir)) return out;

  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.package-lock.json') continue;

    const full = join(nodeModulesDir, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    if (entry.name.startsWith('@')) {
      // Scoped: one level deeper.
      if (!existsSync(full)) continue;
      for (const scoped of readdirSync(full, { withFileTypes: true })) {
        addPackage(join(full, scoped.name), out);
      }
      continue;
    }
    addPackage(full, out);
  }
  return out;
}

function addPackage(dir, out) {
  const manifest = join(dir, 'package.json');
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    return; // broken symlink
  }
  if (!stats.isDirectory() || !existsSync(manifest)) {
    collectInstalled(join(dir, 'node_modules'), out);
    return;
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest, 'utf-8'));
  } catch {
    return;
  }

  if (typeof pkg.name === 'string') {
    const key = `${pkg.name}@${pkg.version ?? '0.0.0'}`;
    if (!out.has(key)) {
      out.set(key, {
        name: pkg.name,
        version: pkg.version ?? '0.0.0',
        license: licenseOf(pkg),
        dir,
      });
    }
  }

  // Nested dependencies (npm dedupes, but not always).
  collectInstalled(join(dir, 'node_modules'), out);
}

/**
 * Build the full dependency inventory.
 *
 * @returns {{name: string, version: string, license: string|null, dir: string,
 *            scope: 'runtime'|'development', firstParty: boolean}[]}
 */
export function inventory(repoRoot) {
  const runtimeNames = npmLsNames(repoRoot, true);
  const installed = collectInstalled(join(repoRoot, 'node_modules'), new Map());

  const rows = [];
  for (const entry of installed.values()) {
    rows.push({
      ...entry,
      scope: runtimeNames.has(entry.name) ? 'runtime' : 'development',
      firstParty: entry.name.startsWith(FIRST_PARTY_SCOPE),
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return rows;
}
