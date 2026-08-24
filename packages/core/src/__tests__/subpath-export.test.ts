// SPDX-License-Identifier: Apache-2.0
/**
 * Every subpath this project documents actually resolves (#149).
 *
 * ## What went wrong
 *
 * README line 89 tells users to write:
 *
 * ```ts
 * import { confirmationForEffects, authenticated, allOf } from '@askturret/mcp/policies';
 * ```
 *
 * `./policies` was missing from the root `package.json` exports map, so that
 * line threw ERR_PACKAGE_PATH_NOT_EXPORTED. The same class as the `./fastify`
 * bug found in #41 — our own documented first line did not run.
 *
 * ## Why this does not extend #41's subpath-export.test.ts
 *
 * That file (`packages/adapters-fastify`) discovers `packages/adapters-*` from
 * disk and requires an exports entry per adapter. `./policies` is not an adapter
 * package — it is a subpath into `core` — so it does not fit that loop.
 *
 * More importantly, that test READS THE MANIFEST. It asserts the map contains
 * the string it expects. That is a genuine improvement over nothing, but it
 * cannot see a map that parses fine and still fails to resolve, and it cannot
 * see a documented import that was never added to the map at all — which is
 * exactly #149. This file resolves for real instead, so the two are
 * complementary rather than redundant.
 *
 * ## Why a subprocess
 *
 * Resolution is the behaviour under test, so it has to be Node's own resolver,
 * not Jest's. Jest resolves modules through its own registry, so an `import()`
 * inside a test proves nothing about what a user's Node would do. Each case
 * therefore spawns a real `node --input-type=module`.
 *
 * This works without `node_modules/@askturret/mcp` existing, via Node's
 * SELF-REFERENCE rule: a package can import its own `name` and be resolved
 * through its own `exports` map. That is why `cwd` is the repo root below —
 * self-reference resolves by walking up from the parent URL to the nearest
 * package.json, and the root manifest is the one that carries the map.
 *
 * ## Two tiers, deliberately
 *
 * `import.meta.resolve` MAPS a specifier without requiring the target to exist;
 * `import()` requires it. Verified, not assumed — see the table:
 *
 * | exports target | `import.meta.resolve` | `import()`             |
 * |----------------|-----------------------|------------------------|
 * | missing file   | succeeds              | ERR_MODULE_NOT_FOUND   |
 * | present file   | succeeds              | succeeds               |
 *
 * So resolution is asserted for EVERY documented subpath, and a real `import()`
 * only for `./policies`. That asymmetry is not laziness: `test-core` builds
 * core alone (`npm run build -w packages/core`), so importing `./express` here
 * would fail on an unbuilt sibling rather than on anything this test is about.
 * The build-output question is already covered, per-package, by #41's test.
 */

import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

interface RootManifest {
  readonly exports?: Record<string, { types?: string; import?: string }>;
}

const rootManifest = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
) as RootManifest;

const exportSubpaths = Object.keys(rootManifest.exports ?? {});

/** `.` -> `@askturret/mcp`, `./policies` -> `@askturret/mcp/policies` */
const specifierFor = (subpath: string): string =>
  subpath === '.' ? '@askturret/mcp' : `@askturret/mcp/${subpath.replace(/^\.\//, '')}`;

/** Run a module snippet in a real Node process rooted at the repo. */
function runInNode(script: string, specifier: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    env: { ...process.env, SUBPATH_SPEC: specifier },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

// `await` covers both shapes: import.meta.resolve returns a string on Node 20.6+
// and a promise on older releases. Awaiting a string is a no-op.
const RESOLVE_SCRIPT = `
  try {
    process.stdout.write('OK ' + (await import.meta.resolve(process.env.SUBPATH_SPEC)));
  } catch (e) {
    process.stdout.write('ERR ' + (e && e.code ? e.code : String(e)));
  }
`;

const NAMED_EXPORTS_SCRIPT = `
  const m = await import(process.env.SUBPATH_SPEC);
  process.stdout.write(JSON.stringify(Object.keys(m).sort()));
`;

// The README's own example, transcribed. If this stops running, the documented
// snippet is broken regardless of whether the subpath resolves.
const README_EXAMPLE_SCRIPT = `
  const { confirmationForEffects, authenticated, allOf } = await import(process.env.SUBPATH_SPEC);
  const policy = allOf([
    authenticated(),
    confirmationForEffects(['financial', 'destructive']),
  ]);
  if (!policy || typeof policy !== 'object') throw new Error('allOf did not return a policy');
  process.stdout.write('BUILT ' + String(policy.id ?? ''));
`;

/** Every markdown file in the repo, excluding dependency and build output. */
function markdownFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, found);
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

const docFiles = markdownFiles(REPO_ROOT);

/**
 * Every `@askturret/mcp[/subpath]` our own documentation tells a user to import.
 *
 * Scanned across all markdown rather than README.md alone. #149 was a README
 * line, but the bug class is "we documented an import and nothing checked it",
 * and that is not a property of one file.
 */
const documentedSpecifiers = [
  ...new Set(
    docFiles.flatMap((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/from\s+['"](@askturret\/mcp(?:\/[\w-]+)?)['"]/g)].map(
        (m) => m[1] as string,
      ),
    ),
  ),
].sort();

describe('documented subpath exports resolve', () => {
  it('finds the specifiers it is meant to be checking', () => {
    // Guards the guard, at both stages. A directory walk that found no markdown,
    // or a regex that matched nothing in it, would make every it.each below
    // vacuously true — zero cases is a passing suite, which is the failure mode
    // this repository's other guards are written to avoid.
    expect(docFiles.length).toBeGreaterThan(1);
    expect(docFiles.some((f) => f.endsWith('README.md'))).toBe(true);
    expect(documentedSpecifiers).toContain('@askturret/mcp/policies');
    expect(documentedSpecifiers.length).toBeGreaterThan(1);
    expect(exportSubpaths).toContain('.');
  });

  it.each(exportSubpaths)('resolves the %s entry in the exports map', (subpath) => {
    const { stdout } = runInNode(RESOLVE_SCRIPT, specifierFor(subpath));
    expect(stdout).toMatch(/^OK file:/);
  });

  it.each(documentedSpecifiers)('resolves %s, which our docs tell users to import', (specifier) => {
    // The #149 invariant. An entry can be absent from the map and nothing else
    // in this repository notices, because every internal import is relative and
    // relative imports never consult an exports map.
    const { stdout } = runInNode(RESOLVE_SCRIPT, specifier);
    expect(stdout).toMatch(/^OK file:/);
  });

  it('maps ./policies onto the policy engine entry point', () => {
    const { stdout } = runInNode(RESOLVE_SCRIPT, '@askturret/mcp/policies');
    expect(stdout).toContain('packages/core/dist/policy/index.js');
  });

  it('actually imports @askturret/mcp/policies and gets the documented symbols', () => {
    // Real resolution AND real evaluation: this is what an exports-map read
    // cannot tell you. Requires core's dist, which both jobs that run this
    // suite build first (see the header).
    const { stdout, stderr, status } = runInNode(NAMED_EXPORTS_SCRIPT, '@askturret/mcp/policies');
    expect(stderr).toBe('');
    expect(status).toBe(0);

    const names = JSON.parse(stdout) as string[];
    expect(names).toEqual(expect.arrayContaining(['allOf', 'authenticated', 'confirmationForEffects']));
  });

  it("runs the README's policy example against the resolved subpath", () => {
    const { stdout, stderr, status } = runInNode(README_EXAMPLE_SCRIPT, '@askturret/mcp/policies');
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toMatch(/^BUILT /);
    // The composed id proves the three symbols really combined, rather than
    // allOf returning some unrelated truthy object.
    expect(stdout).toContain('authenticated');
    expect(stdout).toContain('confirmationForEffects');
  });

  it('reports a missing subpath as ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
    // A control. Without it, every assertion above could be passing because the
    // helper always prints OK — this pins that a genuinely absent subpath is
    // reported, and names the exact error #149 was.
    const { stdout } = runInNode(RESOLVE_SCRIPT, '@askturret/mcp/definitely-not-a-subpath');
    expect(stdout).toBe('ERR ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});
