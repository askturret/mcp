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
 * Three checks on the duplication half, because they fail for different
 * reasons:
 *
 * 1. **Behavioural** — `createSnapshot`'s hash equals `computeHash`'s over the
 *    same operations. Catches DRIFT: a second implementation that has diverged
 *    reddens here whatever it is called.
 * 2. **Structural, by NAME** — the identifier `computeHash` is defined once,
 *    and its users import it. Catches duplication BEFORE it drifts, which is
 *    when it is cheap to fix.
 * 3. **Structural, by BODY** — no other source file contains a
 *    whitespace-normalised copy of the hash body, taken from `hash.ts` itself
 *    rather than transcribed here.
 *
 * ## What these do NOT observe — stated rather than left to be discovered
 *
 * Check 2 was originally the only structural check, under a title claiming the
 * hash "has exactly one implementation". **It claimed more than it observed**,
 * and QA demonstrated the gap rather than arguing it: a byte-identical copy of
 * the real body under a different name passed the whole file, 4 of 4. Check 3
 * closes that specific escape and the titles below now say what each one tests.
 *
 * Two residuals, and the second corrects a claim this file used to make.
 *
 * **(a)** A copy that **renames internals** or **interleaves comments**
 * survives whitespace normalisation and check 3 does not see it. There is no
 * sound syntactic fix — *"is this the same algorithm?"* is a semantic question,
 * and a check covering one more shape while reading as covering the class is
 * the Unobserved Guarantee this repository spent today naming
 * (docs/TESTING.md §6).
 *
 * **(b)** A **dead** duplicate — defined, drifted, and never called — is seen by
 * nothing. Its body differs, so check 3 misses it; its name differs, so check 2
 * misses it; and nothing calls it, so check 1 cannot. Measured, not reasoned:
 * a drifted copy under a new name leaves the suite **fully green**.
 *
 * That last result corrects what this file previously implied. The original
 * mutation pair reported a drifted copy as loudly caught — but it was named
 * `computeHash`, so it **shadowed the import** and `createSnapshot` really did
 * call it. Rename it and the same copy is inert. QA could not reproduce the
 * pair and said so rather than implying they had; they were right, and the
 * corrected matrix is:
 *
 * | duplicate | reddens |
 * |---|---|
 * | identical, same name (shadows the import) | checks 2 and 3 |
 * | identical, different name | check 3 only — QA's escape, now closed |
 * | drifted, different name (dead code) | **nothing** |
 *
 * A dead drifted copy is inert until something calls it, and at that moment
 * check 1 fires. So the honest statement is: **duplication is observed in two
 * shapes, and drift is observed only once it is reachable.** Written down
 * rather than papered over with a wider-sounding assertion.
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

/** Collapse every whitespace run, so reindentation does not defeat a match. */
const normalise = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The body of `computeHash`, read from the production module.
 *
 * Taken from `hash.ts` at runtime rather than pasted here: a transcribed copy
 * would agree with itself after the real one changed, which is the Transcribed
 * Oracle antipattern and is exactly what this file exists to guard against.
 */
function hashBodyFromSource(): string {
  const text = readFileSync(join(SRC, 'compiler', 'hash.ts'), 'utf-8');
  const decl = text.indexOf('export function computeHash');
  const open = text.indexOf('{', decl);
  const close = text.indexOf('\n}', open);
  return normalise(text.slice(open + 1, close));
}

describe('duplication of the snapshot content hash — by name and by body', () => {
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

  it('no other source file contains a copy of the hash BODY', () => {
    // Check 3. QA's escape: a byte-identical copy of the real body under a
    // different name passed check 2 entirely, because that check reads the
    // IDENTIFIER. This one reads the code.
    const needle = hashBodyFromSource();

    // The needle must be real. A mis-parse yielding a short or empty string
    // would make every `includes` below pass or fail for the wrong reason —
    // the Decorative Guard shape, where the scan window is the defect.
    expect(needle.length).toBeGreaterThan(400);
    expect(needle).toContain("createHash('sha256')");
    expect(needle).toContain('localeCompare');

    // Positive control: the needle is findable in the file it came from. If
    // this fails, the extraction is wrong and every negative below is vacuous.
    const source = normalise(readFileSync(join(SRC, 'compiler', 'hash.ts'), 'utf-8'));
    expect(source).toContain(needle);

    const offenders = sourceFiles(SRC)
      .filter((f) => relative(SRC, f).split(sep).join('/') !== 'compiler/hash.ts')
      .filter((f) => normalise(readFileSync(f, 'utf-8')).includes(needle))
      .map((f) => relative(SRC, f).split(sep).join('/'));

    expect(offenders).toEqual([]);
  });

  it('the identifier `computeHash` is defined in exactly one source file, and its users import it', () => {
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
