// SPDX-License-Identifier: Apache-2.0
/**
 * Every adapter is reachable at its documented subpath (#41 QA).
 *
 * ## What went wrong, and why nothing caught it
 *
 * The root `package.json` exports map had `.`, `./openapi`, `./express` and
 * `./otel` — but no `./fastify`. So `import { mcpFromOpenApi } from
 * '@askturret/mcp/fastify'` — the exact line in the issue, and the exact line
 * the README shipped in this PR — threw ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * A copy-paste from our own documentation failed on its first line, which
 * falsifies the adapter's whole thesis: "swap the import and change nothing
 * else" is precisely what a user could not do.
 *
 * The entire adapter test suite passed throughout, because every test imports
 * `../index.js` by relative path. Relative imports never consult the exports
 * map, so no amount of behavioural testing could see this. That is the gap this
 * file closes.
 *
 * ## Why it is written over ALL adapters rather than just Fastify
 *
 * Asserting only `./fastify` would fix today's bug and let the next adapter —
 * Koa, NestJS — reintroduce it verbatim. The invariant worth pinning is
 * "every adapter package is reachable through the public entry point", so the
 * test discovers `packages/adapters-*` from disk and requires an entry for each.
 *
 * It lives in this package because this is where the gap surfaced; a repo-wide
 * CI guard alongside the others in `.github/scripts/` is the tidier long-term
 * home, noted for follow-up rather than built here.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

interface RootManifest {
  readonly exports?: Record<string, { types?: string; import?: string }>;
}

const rootManifest = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
) as RootManifest;

/** `packages/adapters-fastify` -> `fastify` */
const adapterPackages = readdirSync(join(REPO_ROOT, 'packages')).filter((name) =>
  name.startsWith('adapters-'),
);

describe('public subpath exports', () => {
  it('finds the adapter packages it is meant to be checking', () => {
    // Guards the guard: a glob that silently matched nothing would make every
    // assertion below vacuously true — the failure mode this repo's other
    // guards are written to avoid.
    expect(adapterPackages).toEqual(expect.arrayContaining(['adapters-express', 'adapters-fastify']));
  });

  it.each(adapterPackages)('exposes %s at a public subpath', (packageDir) => {
    const subpath = `./${packageDir.replace(/^adapters-/, '')}`;
    const entry = rootManifest.exports?.[subpath];

    expect(entry).toBeDefined();
    expect(entry?.import).toBe(`./packages/${packageDir}/dist/index.js`);
    expect(entry?.types).toBe(`./packages/${packageDir}/dist/index.d.ts`);
  });

  it.each(adapterPackages)('points %s at a build output that is actually produced', (packageDir) => {
    // An exports entry naming a path the build never emits resolves at
    // install time and fails at import time — the same class of break, one
    // step later. Checked against tsconfig rather than the built artifact, so
    // this does not depend on test-run ordering.
    const tsconfig = join(REPO_ROOT, 'packages', packageDir, 'tsconfig.json');

    expect(existsSync(tsconfig)).toBe(true);
    expect(readFileSync(tsconfig, 'utf-8')).toContain('"outDir": "./dist"');
  });

  it('keeps the Fastify entry consistent with the Express one it mirrors', () => {
    // The specific asymmetry #41's QA pass found: Express resolved, Fastify did
    // not, and this PR is what introduced the difference.
    const express = rootManifest.exports?.['./express'];
    const fastify = rootManifest.exports?.['./fastify'];

    expect(fastify).toBeDefined();
    expect(Object.keys(fastify ?? {}).sort()).toEqual(Object.keys(express ?? {}).sort());
  });
});
