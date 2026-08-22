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

/** Workspace packages are first-party; they are not third-party dependencies. */
export const FIRST_PARTY_SCOPE = '@askturret/';

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

  // `npm ls` exits non-zero on peer-dependency complaints while still emitting
  // a complete tree, so parse the output and only fail if it is unusable.
  let tree;
  try {
    tree = JSON.parse(run.stdout || '{}');
  } catch {
    throw new Error(
      `npm ls --all${omitDev ? ' --omit=dev' : ''} produced unparseable output:\n` +
        `${(run.stderr || '').slice(0, 2000)}`,
    );
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
