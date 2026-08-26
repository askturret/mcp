// SPDX-License-Identifier: Apache-2.0
/**
 * One hash implementation, and no new public surface (#347).
 *
 * `deserializeSnapshot` verifies the stored content hash, which means two
 * places now need the same algorithm. The docblock it replaced framed that as a
 * choice between duplicating the function — two implementations that drift,
 * surfacing as spurious "corrupt snapshot" errors — and widening the compiler's
 * public surface. `compiler/hash.ts` avoids both.
 *
 * **Both halves of that claim are the kind that is true when written and
 * quietly false a year later**, so both are observed here rather than asserted
 * in prose. #347's acceptance asked for the first to be "verified mechanically,
 * not asserted"; the second is the same shape and gets the same treatment.
 *
 * Two independent checks on the duplication half, because they fail for
 * different reasons:
 *
 * 1. **Behavioural** — `createSnapshot`'s hash equals `computeHash`'s over the
 *    same operations. This catches DRIFT: a second implementation that has
 *    diverged reddens here whatever it is called.
 * 2. **Structural** — the source contains one definition, and its users import
 *    it. This catches DUPLICATION BEFORE it drifts, which is the moment it is
 *    cheap to fix, and it is the only one of the two that can see a copy that
 *    currently agrees.
 *
 * Neither alone is enough: a fresh copy passes (1), and a drifted copy under a
 * new name passes (2).
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as compilerBarrel from '../index.js';
import * as coreBarrel from '../../index.js';
import { computeHash } from '../hash.js';
import { createSnapshot } from '../passes/freeze-and-hash.js';
import type { OperationDefinition } from '../../types.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function operation(id: string): OperationDefinition {
  return {
    id,
    name: id,
    description: `Operation ${id}`,
    input: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    output: { type: 'object', properties: { b: { type: 'number' } } },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: ['data-export'],
    },
    executor: { type: 'http' },
  } as OperationDefinition;
}

describe('the snapshot content hash has exactly one implementation', () => {
  it('createSnapshot produces the same hash the shared module computes', () => {
    // The drift detector. `createSnapshot` is the only route by which a
    // snapshot's hash is authored; if the pass ever grows its own copy of the
    // algorithm and that copy diverges by so much as a sorted key, this fails.
    const operations = [operation('b'), operation('a')];

    const snapshot = createSnapshot(operations, 7);

    expect(snapshot.hash).toBe(computeHash(operations));
    // Paired positive: a hash that is merely *absent* would satisfy the line
    // above if both sides returned undefined.
    expect(snapshot.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is defined in exactly one source file, and its users import it', () => {
    const files = sourceFiles(SRC);

    // Non-empty scan window. "No duplicates found" and "nothing was scanned"
    // render identically otherwise — the Decorative Guard shape.
    expect(files.length).toBeGreaterThan(50);

    const definitions: string[] = [];
    const users: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      const rel = relative(SRC, file).split(sep).join('/');

      if (/function computeHash\s*\(/.test(text)) definitions.push(rel);
      // A call, as opposed to the definition's own signature.
      if (/computeHash\(/.test(text) && !/function computeHash\s*\(/.test(text)) users.push(rel);
    }

    expect(definitions).toEqual(['compiler/hash.ts']);

    // The window for the users half must be non-empty too, and by name: an
    // empty `users` list would satisfy the `every` below vacuously.
    expect(users.sort()).toEqual(['compiler/passes/freeze-and-hash.ts', 'snapshot-io.ts']);

    for (const user of users) {
      const text = readFileSync(join(SRC, user), 'utf-8');
      expect(text).toMatch(/import \{ computeHash \} from '[^']*hash\.js'/);
    }
  });
});

describe('the compiler public surface is unchanged', () => {
  it('does not export the hash function from the compiler barrel', () => {
    // The third horn depends entirely on this staying true: `compiler/hash.ts`
    // is importable inside the package and invisible outside it only because
    // the barrel re-exports selectively.
    expect(Object.keys(compilerBarrel)).not.toContain('computeHash');
    expect(Object.keys(compilerBarrel).filter((k) => /hash/i.test(k))).toEqual([]);

    // Paired positive: the barrel is a real module with real exports, so the
    // two assertions above are not passing because there is nothing there.
    expect(Object.keys(compilerBarrel)).toContain('createSnapshot');
  });

  it('does not export the hash function from the package entry point', () => {
    // `src/index.ts` re-exports the compiler barrel wholesale, so this is the
    // assertion that would catch a re-export added one level down.
    expect(Object.keys(coreBarrel)).not.toContain('computeHash');
    expect(Object.keys(coreBarrel)).toContain('deserializeSnapshot');
  });
});
