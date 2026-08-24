/**
 * The declared `@modelcontextprotocol/sdk` peer range excludes the vulnerable
 * line (#140, GHSA-w48q-cv73-mx4w).
 *
 * ## Why a test rather than trusting `npm audit`
 *
 * `npm audit` is not run anywhere in CI — the only "audit" steps in
 * `test.yml` are the append-only audit-LOG guard, which is unrelated. So
 * nothing in the build would notice this range being moved back to `^0.5.0`,
 * and the advisory would return silently. That is the same invisible-regression
 * shape the repository's other guards exist for.
 *
 * Adding `npm audit` to CI would be the other option and is deliberately NOT
 * what this does: it reaches the registry on every run, so an advisory
 * published overnight against an unrelated transitive package would fail a PR
 * that changed nothing. This repository already declined external-URL checking
 * in the markdown link guard (#188) for exactly that reason. This assertion is
 * offline and deterministic — it pins the DECISION, not the ecosystem.
 *
 * ## What it does not claim
 *
 * It cannot tell you the installed tree is free of advisories; only that the
 * declared floor is not the one this advisory names. A future advisory against
 * a 1.x version needs its own decision, and this test is where the floor moves.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '../..');

/** The first version the advisory considers patched. */
const PATCHED_FLOOR = [1, 24, 0] as const;

function peerRange(packageJsonPath: string): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
    peerDependencies?: Record<string, string>;
  };
  const range = pkg.peerDependencies?.['@modelcontextprotocol/sdk'];
  if (range === undefined) {
    throw new Error(`no @modelcontextprotocol/sdk peer dependency in ${packageJsonPath}`);
  }
  return range;
}

/** Lowest version a `^x.y.z` range admits, as a comparable tuple. */
function floorOf(range: string): [number, number, number] {
  const match = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(range.trim());
  if (!match) throw new Error(`unsupported range syntax: ${range}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const atLeastFloor = (v: readonly [number, number, number]): boolean => {
  for (let i = 0; i < 3; i += 1) {
    if (v[i]! > PATCHED_FLOOR[i]!) return true;
    if (v[i]! < PATCHED_FLOOR[i]!) return false;
  }
  return true;
};

describe('@modelcontextprotocol/sdk peer range (#140)', () => {
  // Both files declare the peer dependency, and both must move together — a
  // consumer installing the workspace root and a consumer installing this
  // package alone would otherwise get different answers about the same
  // advisory.
  const declarations: ReadonlyArray<readonly [string, string]> = [
    ['repo root', join(repoRoot, 'package.json')],
    ['packages/transports', join(packageRoot, 'package.json')],
  ];

  it.each(declarations)('%s declares a range at or above the patched floor', (_label, file) => {
    const range = peerRange(file);

    expect(atLeastFloor(floorOf(range))).toBe(true);
    // The specific version this advisory names, asserted directly so the
    // failure message points at the reason rather than at a tuple comparison.
    expect(range).not.toMatch(/^\^?0\./);
  });

  it('keeps both declarations in agreement', () => {
    const [rootRange, transportsRange] = declarations.map(([, file]) => peerRange(file));

    expect(rootRange).toBe(transportsRange);
  });

  it('rejects the pre-fix range, so this test cannot pass vacuously', () => {
    // The control. Without it, a bug in `floorOf` or `atLeastFloor` that made
    // everything look fine would leave the assertions above green while
    // checking nothing — the "test that cannot fail" shape docs/TESTING.md
    // names.
    expect(atLeastFloor(floorOf('^0.5.0'))).toBe(false);
    expect(atLeastFloor(floorOf('^1.23.9'))).toBe(false);
    expect(atLeastFloor(floorOf('^1.24.0'))).toBe(true);
    expect(atLeastFloor(floorOf('^2.0.0'))).toBe(true);
  });
});
