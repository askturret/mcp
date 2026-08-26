// SPDX-License-Identifier: Apache-2.0
/**
 * The content hash, in one place.
 *
 * ## Why this module exists (#347)
 *
 * `snapshot-io.ts` needs to verify a stored hash; the freeze-and-hash pass
 * needs to produce one. Its docblock framed that as a choice between two bad
 * options — duplicate the algorithm and let the two copies drift, or widen the
 * compiler's public surface. **There is a third option, and this file is it.**
 *
 * A module inside `compiler/` that `compiler/index.ts` does NOT re-export is
 * importable by anything in this package and by nothing outside it. The barrel
 * re-exports selectively — only `createSnapshot` from the freeze-and-hash pass
 * — so moving `computeHash` here changes the published surface not at all.
 * `packages/core/package.json` declares a single `.` export, so a deep import
 * from outside the package is not available either.
 *
 * **Do not re-export this from `compiler/index.ts` or `src/index.ts`.** Two
 * tests observe that, because "we chose not to widen the surface" is the kind
 * of claim that is true when written and quietly false a year later.
 */

import { createHash } from 'crypto';

import type { OperationDefinition } from '../types.js';

/**
 * Compute deterministic content-addressed hash of operations.
 *
 * Hash contract (ADR-004, Issue #12):
 * - **Included**: id, name, description, input, output, effects, executor, annotations
 * - **Excluded**: provenance (metadata, not contract), createdAt (timing, not content)
 * - **Format**: SHA-256 truncated to 16 hex chars (sufficient uniqueness at our scale)
 *
 * Determinism requirements:
 * - Object keys sorted alphabetically
 * - Operations sorted by ID
 * - No Date.now() or Math.random()
 * - Stable across Node versions and processes
 *
 * The determinism requirements are what make verification possible at all: a
 * hash recomputed in a different process, from a file, must equal the one
 * computed at capture time or the check is noise.
 */
export function computeHash(operations: readonly OperationDefinition[]): string {
  // Sort operations by ID for deterministic order
  const sorted = [...operations].sort((a, b) => a.id.localeCompare(b.id));

  // Filter operations to include only contract fields (exclude provenance)
  const contractFields = sorted.map(op => ({
    id: op.id,
    name: op.name,
    description: op.description,
    input: op.input,
    output: op.output,
    effects: op.effects,
    executor: op.executor,
    ...(op.annotations && { annotations: op.annotations }),
  }));

  // Serialize with sorted keys
  const canonical = JSON.stringify(contractFields, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Sort object keys alphabetically
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        sorted[key] = value[key];
      }
      return sorted;
    }
    return value;
  });

  // SHA-256 hash, truncated to 16 hex chars
  const fullHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return fullHash.substring(0, 16);
}
