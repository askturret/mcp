// SPDX-License-Identifier: Apache-2.0
/**
 * Both adapters re-run when the packages they are built from change (#153).
 *
 * ## The near-miss
 *
 * `adapters-express` and `adapters-fastify` triggered only on their own
 * directory plus `packages/explorer` — not on `packages/core` or
 * `packages/transports`, which they are built from. So a core-only or
 * transports-only change would not re-run either adapter's suite.
 *
 * During #43 a real bulkhead bug (`assignBulkhead` throwing on a hand-built
 * `RegistrySnapshot`) did reach CI and was caught — but only because #42's
 * `adapter-conformance` filter happens to include those two packages. That is
 * coverage by SIDE EFFECT. It would have disappeared the day that filter was
 * narrowed, and nobody would have noticed, because the thing that vanishes is
 * a test run that never happened.
 *
 * ## Why this is a test and not just a config edit
 *
 * The config edit fixes it once. The failure mode in the issue is DRIFT — "if
 * that filter is ever narrowed later" — and a widened filter is invisible when
 * it is correct and equally invisible when it is not. Nothing else in CI
 * notices a job that quietly stopped running.
 *
 * ## Deliberately narrow (#153), with the general case now covered elsewhere
 *
 * This asserts the two adapters named in #153 and nothing else. The broader gap
 * it deferred to #213 — only some of the filters included `packages/core/**` —
 * has since been closed, and the general rule is enforced against package.json
 * by `.github/scripts/check-path-filters.mjs` rather than restated here. That
 * guard is what catches a NEW package; this file remains the record of the
 * specific near-miss #153 found.
 *
 * The workflow is read as text rather than through a YAML library: `filters` is
 * a YAML document embedded in a YAML string, and js-yaml is not a declared
 * dependency of this package. The block's shape is fixed and simple, and the
 * parser is guarded below against matching nothing.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WORKFLOW = join(REPO_ROOT, '.github/workflows/test.yml');

/**
 * Read the `filters: |` block into { filterName: [path, ...] }.
 *
 * Comment lines are skipped, so a path is only ever recorded from a real list
 * entry — a filter documented in a comment but not actually listed must not
 * read as present.
 */
function parseFilters(workflow: string): Record<string, string[]> {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'filters: |');
  if (start === -1) return {};

  const blockIndent = (lines[start]?.match(/^\s*/)?.[0].length ?? 0) + 2;
  const filters: Record<string, string[]> = {};
  let current: string | undefined;

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent < blockIndent) break; // out of the block

    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;

    const name = trimmed.match(/^([\w-]+):$/);
    if (name?.[1] !== undefined) {
      current = name[1];
      filters[current] = [];
      continue;
    }

    const entry = trimmed.match(/^-\s*'([^']+)'$/);
    if (entry?.[1] !== undefined && current !== undefined) {
      filters[current]?.push(entry[1]);
    }
  }

  return filters;
}

const filters = parseFilters(readFileSync(WORKFLOW, 'utf-8'));

describe('CI path filters for the adapters (#153)', () => {
  it('parsed the filter block it is meant to be checking', () => {
    // Guards the guard. A parser that silently matched nothing would make every
    // assertion below vacuous — `expect([]).not.toContain(x)` passes happily.
    expect(Object.keys(filters).length).toBeGreaterThanOrEqual(12);
    expect(filters['workspace']).toContain('.github/workflows/**');
    expect(filters['adapters-express']).toContain('packages/adapters-express/**');
  });

  it.each(['adapters-express', 'adapters-fastify'])(
    '%s re-runs when core or transports changes',
    (filter) => {
      // The acceptance criterion, as an executable statement. Both adapters are
      // built from both packages, so a change to either can break them without
      // touching an adapter file.
      expect(filters[filter]).toContain('packages/core/**');
      expect(filters[filter]).toContain('packages/transports/**');
    },
  );

  it.each([
    ['adapters-express', 'packages/explorer/**'],
    ['adapters-express', 'examples/petstore-light/**'],
    ['adapters-fastify', 'packages/explorer/**'],
  ])('%s keeps its existing trigger on %s', (filter, path) => {
    // "Existing filter behavior for adapter-only changes is unaffected" — the
    // second half of the acceptance criterion. Widening a filter by replacing
    // it would satisfy the first half and quietly lose these.
    expect(filters[filter]).toContain(path);
  });

  it('the #213 filters have since been widened too', () => {
    // This expectation was previously pinned INVERTED — asserting cli and
    // explorer did NOT include core — so that widening them had to be a
    // deliberate edit here rather than a drive-by. #213 is that deliberate
    // edit, so the pin is flipped rather than deleted: dropping it would lose
    // the signal that these two were once uncovered.
    //
    // The GENERAL rule — every filter covers every first-party dependency the
    // package declares — is now enforced from package.json by
    // .github/scripts/check-path-filters.mjs, which is where a new package gets
    // caught. This file stays scoped to #153's near-miss.
    expect(filters['cli']).toContain('packages/core/**');
    expect(filters['explorer']).toContain('packages/core/**');
  });
});
