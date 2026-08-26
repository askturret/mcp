// SPDX-License-Identifier: Apache-2.0
/**
 * On-disk snapshot format (§13).
 *
 * `diff --before snapshot.json` is only as trustworthy as this round-trip: if
 * serialization drops a field, diff compares a snapshot that is not the one
 * that was captured and reports a clean result about the wrong thing.
 */

import { describe, it, expect } from '@jest/globals';

import { createSnapshot } from '../compiler/passes/freeze-and-hash.js';
import {
  SNAPSHOT_FORMAT_VERSION,
  SnapshotFormatError,
  deserializeSnapshot,
  serializeSnapshot,
} from '../snapshot-io.js';
import type { OperationDefinition } from '../types.js';

function operation(id: string, overrides: Partial<OperationDefinition> = {}): OperationDefinition {
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
    ...overrides,
  } as OperationDefinition;
}

describe('snapshot serialization', () => {
  it('round-trips a snapshot without losing operations or their contracts', () => {
    const original = createSnapshot([operation('b'), operation('a')], 7);

    const restored = deserializeSnapshot(JSON.parse(JSON.stringify(serializeSnapshot(original))));

    expect(restored.version).toBe(original.version);
    expect(restored.hash).toBe(original.hash);
    expect(restored.createdAt.toISOString()).toBe(original.createdAt.toISOString());
    expect([...restored.operations.keys()].sort()).toEqual(['a', 'b']);
    expect(restored.operations.get('a')).toEqual(original.operations.get('a'));
  });

  it('emits operations sorted by id, so the file is byte-stable', () => {
    // A file that reorders itself on every write produces diff noise that
    // trains reviewers to skip it — which defeats committing it at all.
    const one = serializeSnapshot(createSnapshot([operation('z'), operation('a')], 1));
    const two = serializeSnapshot(createSnapshot([operation('a'), operation('z')], 1));

    expect(one.operations.map((o) => o.id)).toEqual(['a', 'z']);
    expect(JSON.stringify(one.operations)).toBe(JSON.stringify(two.operations));
  });

  it('preserves optional annotations and provenance when present', () => {
    const withExtras = operation('a', {
      annotations: { source: 'openapi' },
      provenance: [{ field: 'description', kind: 'openapi' }],
    } as Partial<OperationDefinition>);

    const restored = deserializeSnapshot(
      JSON.parse(JSON.stringify(serializeSnapshot(createSnapshot([withExtras], 1)))),
    );

    expect(restored.operations.get('a')?.annotations).toEqual({ source: 'openapi' });
    expect(restored.operations.get('a')?.provenance).toHaveLength(1);
  });

  it('omits absent optional fields rather than materialising them as undefined', () => {
    const restored = deserializeSnapshot(
      JSON.parse(JSON.stringify(serializeSnapshot(createSnapshot([operation('a')], 1)))),
    );
    const op = restored.operations.get('a');

    expect(op && 'annotations' in op).toBe(false);
    expect(op && 'provenance' in op).toBe(false);
  });

  it('refuses a formatVersion newer than it understands', () => {
    // Best-effort parsing of a newer file would let diff report "no breaking
    // changes" about a comparison it could not fully perform.
    const future = {
      formatVersion: SNAPSHOT_FORMAT_VERSION + 1,
      version: 1,
      hash: 'h',
      createdAt: '2026-01-01T00:00:00.000Z',
      operations: [],
    };

    expect(() => deserializeSnapshot(future)).toThrow(/newer than this tool understands/);
  });

  it('rejects malformed input with a message naming the problem', () => {
    expect(() => deserializeSnapshot(null)).toThrow(SnapshotFormatError);
    expect(() => deserializeSnapshot({})).toThrow(/formatVersion/);
    expect(() =>
      deserializeSnapshot({ formatVersion: 1, version: 'x', hash: 'h', createdAt: 'z', operations: [] }),
    ).toThrow(/`version` must be a number/);
    expect(() =>
      deserializeSnapshot({
        formatVersion: 1,
        version: 1,
        hash: 'h',
        createdAt: 'not-a-date',
        operations: [],
      }),
    ).toThrow(/not a valid date/);
  });

  it('rejects duplicate operation ids', () => {
    // Every classification rule is keyed on "the operation with id X", so a
    // duplicate makes the comparison ambiguous rather than merely untidy.
    const dupe = {
      formatVersion: 1,
      version: 1,
      hash: 'h',
      createdAt: '2026-01-01T00:00:00.000Z',
      operations: [serializeOne('a'), serializeOne('a')],
    };

    expect(() => deserializeSnapshot(dupe)).toThrow(/duplicate operation id/);
  });
});

describe('content hash verification (#347)', () => {
  /** A genuine snapshot on its way to disk: real operations, real hash. */
  function onDisk(...ids: string[]) {
    return JSON.parse(
      JSON.stringify(serializeSnapshot(createSnapshot(ids.map((id) => operation(id)), 3))),
    ) as Record<string, unknown> & { hash: string; operations: Record<string, unknown>[] };
  }

  it('accepts a snapshot whose hash matches its operations', () => {
    // The paired positive. Without it, every rejection below is satisfied by a
    // verifier that refuses everything.
    const file = onDisk('a', 'b');

    expect(deserializeSnapshot(file).hash).toBe(file.hash);
  });

  it('rejects a hand-edited operation that the stored hash no longer covers', () => {
    // The defect the old docblock stated plainly and accepted: "a hand-edited
    // `snapshot.json` whose `hash` no longer matches its `operations` is
    // accepted". This is that file — the OPERATIONS are edited and the hash is
    // the original, which is the direction an actual tamper takes.
    const file = onDisk('a', 'b');
    const originalHash = file.hash;
    file.operations[0]!['description'] = 'quietly changed after capture';

    expect(() => deserializeSnapshot(file)).toThrow(SnapshotFormatError);
    expect(() => deserializeSnapshot(file)).toThrow(/does not match its operations/);
    // The stored hash is unchanged, so the file still LOOKS provenanced.
    expect(file.hash).toBe(originalHash);
  });

  it('rejects a wrong hash over untouched operations, naming both values', () => {
    // Asserting the MESSAGE, not merely the throw: a mismatch that reports
    // neither value tells the reader nothing about which side moved, and
    // status-only assertions are how a masked failure stays masked.
    const file = onDisk('a');
    const computed = file.hash;
    file.hash = '0000000000000000';

    expect(() => deserializeSnapshot(file)).toThrow(
      new RegExp(`'0000000000000000'.*computed '${computed}'`),
    );
  });

  it('reads a mismatched snapshot when the caller declares { verifyHash: false }', () => {
    // The opt-out, which is what makes verify-by-default adoptable: eight
    // golden fixtures carry mnemonic hashes on purpose. The declaration is
    // per-call and greppable, so the residual unverified set stays countable.
    const file = onDisk('a', 'b');
    file.hash = 'hash-mnemonic';

    const restored = deserializeSnapshot(file, { verifyHash: false });

    expect(restored.hash).toBe('hash-mnemonic');
    expect([...restored.operations.keys()].sort()).toEqual(['a', 'b']);
  });

  it('verifies by default — an omitted option is not an opt-out', () => {
    // `{}` and `{ verifyHash: undefined }` must both mean "verify". A truthy
    // test on the option would silently turn every caller that passes an
    // options object into an opt-out.
    const file = onDisk('a');
    file.hash = 'wrong';

    // `exactOptionalPropertyTypes` stops a TypeScript caller writing an
    // explicit `undefined`, so this case is cast rather than dropped: this
    // package ships to JavaScript consumers, for whom it is reachable.
    const explicitUndefined = { verifyHash: undefined } as unknown as { verifyHash?: boolean };

    expect(() => deserializeSnapshot(file, {})).toThrow(/does not match/);
    expect(() => deserializeSnapshot(file, explicitUndefined)).toThrow(/does not match/);
    expect(() => deserializeSnapshot(file, { verifyHash: true })).toThrow(/does not match/);
  });

  it('reports a structural problem rather than the hash when both are wrong', () => {
    // Verification runs last on purpose. "operations[0].name must be a string"
    // localises the defect; "the hash does not match" is what a half-parsed
    // file would say instead, and it would send the reader to the wrong place.
    const file = onDisk('a');
    file.hash = 'wrong-too';
    delete file.operations[0]!['name'];

    expect(() => deserializeSnapshot(file)).toThrow(/\.name must be a string/);
  });
});

function serializeOne(id: string): unknown {
  return JSON.parse(JSON.stringify(operation(id)));
}
