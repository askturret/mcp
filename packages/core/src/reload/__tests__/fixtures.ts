// SPDX-License-Identifier: Apache-2.0
/**
 * Shared fixtures for reload tests.
 *
 * Snapshots are built through the REAL `createSnapshot`, so hashes are the
 * production hashes rather than hand-written strings. A test that invents a
 * hash cannot catch a swap that published the wrong snapshot, because every
 * hash it compares against is one the test made up.
 */

import { createSnapshot } from '../../compiler/passes/freeze-and-hash.js';
import type { OperationDefinition, RegistrySnapshot } from '../../types.js';

export function operation(id: string): OperationDefinition {
  return {
    id,
    name: id,
    description: `Operation ${id}`,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'test' },
  };
}

/**
 * Build a snapshot whose hash is genuinely derived from its contents.
 *
 * Distinct `ids` therefore produce distinct hashes, which is what lets the
 * tests assert on identity rather than on a label.
 */
export function snapshot(version: number, ids: readonly string[]): RegistrySnapshot {
  return createSnapshot(ids.map(operation), version);
}
