// SPDX-License-Identifier: Apache-2.0
/**
 * The conformance run (§42 Acceptance: "Both Express and Fastify pass the full
 * 8-category bank" / "CI shows both adapters' results side by side").
 *
 * Each category is one Jest case per adapter, so a failure names the adapter
 * AND the category rather than collapsing into "conformance failed". The
 * side-by-side table is printed once at the end, from the results actually
 * collected — not re-derived, so it cannot disagree with the assertions above it.
 */

import { describe, it, expect, afterAll } from '@jest/globals';

import {
  CATEGORIES,
  optionsWith,
  recordingExecutor,
  renderTable,
  rpc,
  runCategory,
  staticSource,
  type CategoryResult,
} from '../bank.js';
import { getAdapter, registeredAdapters, selectedAdapters } from '../registry.js';
import '../adapters.js';

const adapters = selectedAdapters();
const results: CategoryResult[] = [];

describe('adapter conformance', () => {
  it('has adapters registered to run against', () => {
    // Guards the guard. An empty selection registers ZERO cases and the suite
    // reports green having tested nothing — the exact false-negative a
    // conformance suite must never produce.
    //
    // The two assertions are deliberately different: the SELECTION may
    // legitimately be one adapter under `--adapter express`, but the REGISTRY
    // must still hold both. Asserting `>= 2` on the selection failed exactly
    // that documented invocation.
    expect(adapters.length).toBeGreaterThanOrEqual(1);
    expect(registeredAdapters()).toEqual(expect.arrayContaining(['express', 'fastify']));
  });

  it('runs every declared category', () => {
    // §42 names eight. If a category is deleted, this fails rather than the
    // suite quietly certifying a smaller contract.
    expect(CATEGORIES).toHaveLength(8);
    expect(CATEGORIES.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  for (const adapter of adapters) {
    describe(adapter, () => {
      for (const category of CATEGORIES) {
        it(`${category.id}. ${category.name}`, async () => {
          let note = '';
          let passed = false;
          try {
            // `runCategory`, not `category.run` (#253). The category budget
            // rejects BELOW the jest cap on this test, and that ordering is the
            // whole fix: when jest kills a test it ABANDONS the function, so
            // the `finally` that records the row never runs — the failure is
            // loud in jest's output and absent from the table CI publishes.
            note = await runCategory(category, { adapter, start: getAdapter(adapter) });
            passed = true;
          } catch (error) {
            note = error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            results.push({ adapter, category: category.name, id: category.id, passed, note });
          }

          // Explicit, even though `run` throws on failure. The placeholder-test
          // guard flagged the earlier version as asserting nothing, and it was
          // right to: a reader could not see what was being checked, and a
          // category that stopped throwing — returning early, say — would have
          // passed silently.
          //
          // The note is asserted too, because it is what the side-by-side table
          // prints. A category that passed while producing nothing to report
          // would leave a blank cell in the artifact CI publishes.
          expect(passed).toBe(true);
          expect(note.length).toBeGreaterThan(0);
        }, 30000);
      }
    });
  }
});

describe('cross-adapter parity', () => {
  it('every adapter exposes an identical discovered surface', async () => {
    // §42 category 1 asks for an "identical hash across both adapters". The
    // hash is not on the wire (see bank.ts), so the observable equivalent is
    // asserted here: the same sources must yield a byte-identical tools/list
    // on every adapter.
    //
    // This belongs across adapters rather than inside a per-adapter category —
    // a category run against one adapter has nothing to compare against, so it
    // could only ever re-assert what it was given.
    const surfaces = new Map<string, string>();

    for (const adapter of adapters) {
      const server = await getAdapter(adapter)(
        optionsWith(
          [staticSource('a', [{ id: 'alpha' }, { id: 'beta', input: { type: 'object', properties: { q: { type: 'string' } } } }])],
          recordingExecutor().executor,
        ),
      );
      try {
        const list = await rpc(server.url, 'tools/list');
        const tools = (list.body.result?.tools ?? [])
          .map((t) => ({ name: t.name, inputSchema: t.inputSchema }))
          .sort((x, y) => x.name.localeCompare(y.name));
        surfaces.set(adapter, JSON.stringify(tools));
      } finally {
        await server.close();
      }
    }

    const distinct = new Set(surfaces.values());
    if (distinct.size !== 1) {
      const detail = [...surfaces].map(([a, s]) => `${a}: ${s}`).join('\n');
      throw new Error(`adapters exposed different surfaces:\n${detail}`);
    }

    expect(distinct.size).toBe(1);
    expect(surfaces.size).toBe(adapters.length);
  }, 30000);
});

afterAll(() => {
  if (results.length === 0) return;
  // eslint-disable-next-line no-console
  console.log(`\nAdapter conformance — side by side\n\n${renderTable(results)}\n`);
});
