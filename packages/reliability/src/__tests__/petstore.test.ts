// SPDX-License-Identifier: Apache-2.0
/**
 * Reference-Petstore layer (§51 acceptance).
 *
 * "Every layer above runs green against a reference Petstore server." QA
 * round 1 found no such scenario existed — every other scenario ran against
 * hand-built operations. These run the layers against operations produced by
 * the real discover-then-compile path.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';

import type { OperationDefinition } from '@askturret/mcp-core';

import { loadPetstoreOperations, petstoreLayers } from '../scenarios/petstore.js';

describe('reference Petstore server (§51 acceptance)', () => {
  let operations: readonly OperationDefinition[];

  beforeAll(async () => {
    operations = await loadPetstoreOperations();
  });

  it('compiles the reference spec into real operations', () => {
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.map((op) => op.id).sort()).toEqual(['getPetById', 'listPets']);
  });

  it('produces operations that differ from the hand-built ones in ways the suite cares about', () => {
    const listPets = operations.find((op) => op.id === 'listPets');

    // A real upstream binding — this is what makes breaker assignment resolve
    // by URL prefix rather than by annotation, a branch of assignBreaker that
    // no synthetic scenario reaches.
    expect((listPets?.executor.config as { baseUrl?: string } | undefined)?.baseUrl).toBe(
      'https://petstore.example.com/api/v1',
    );
    // Derived from the spec's GET verb, not set by hand.
    expect(listPets?.effects.retryable).toBe(true);
    expect(listPets?.effects.readOnly).toBe(true);
  });

  it('runs every §51 layer green against it', async () => {
    const result = await petstoreLayers(operations);

    // Report per layer rather than one boolean: a bare `allGreen` failure
    // says the suite broke without saying which layer, which is the least
    // useful shape for whoever picks this up.
    const failed = result.layers.filter((l) => !l.ok);
    expect(
      failed.map((l) => `${l.layer}: ${JSON.stringify(l.detail)}`),
    ).toEqual([]);
    expect(result.allGreen).toBe(true);

    // Every §51 layer is actually represented — a suite that silently stopped
    // running one would otherwise still report all-green.
    expect(result.layers.map((l) => l.layer).sort()).toEqual([
      'chaos',
      'load',
      'partial-failure',
      'reload-under-load',
      'shutdown-under-load',
      'slow-upstream',
    ]);
  }, 30_000);
});
