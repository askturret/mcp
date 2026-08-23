// SPDX-License-Identifier: Apache-2.0
/**
 * Digests and safe references (§9.3 never-include list).
 */

import { describe, it, expect } from '@jest/globals';

import { auditEventId, canonicalize, digestInput, principalRef } from '../index.js';

describe('inputDigest stability (§48 acceptance)', () => {
  it('produces the same digest for the same input', () => {
    expect(digestInput({ a: 1, b: 'two' })).toBe(digestInput({ a: 1, b: 'two' }));
  });

  it('is independent of key insertion order', () => {
    // The whole reason canonicalization exists. `JSON.stringify` follows
    // INSERTION order, which follows however the input was parsed or built —
    // so without this, two records of the same call stop correlating.
    expect(digestInput({ a: 1, b: 2 })).toBe(digestInput({ b: 2, a: 1 }));
  });

  it('is independent of key order at every nesting depth', () => {
    const one = { outer: { z: 1, a: { y: 2, b: 3 } }, list: [{ q: 1, p: 2 }] };
    const two = { list: [{ p: 2, q: 1 }], outer: { a: { b: 3, y: 2 }, z: 1 } };

    expect(digestInput(one)).toBe(digestInput(two));
  });

  it('does NOT ignore array order', () => {
    // Sorting arrays too would make genuinely different inputs digest the
    // same, which is a worse failure than the one being fixed.
    expect(digestInput([1, 2])).not.toBe(digestInput([2, 1]));
  });

  it('distinguishes different values', () => {
    expect(digestInput({ a: 1 })).not.toBe(digestInput({ a: 2 }));
    expect(digestInput({ a: '1' })).not.toBe(digestInput({ a: 1 }));
  });

  it('returns undefined for absent input, not the digest of null', () => {
    // "There was no input" and "the input was null" are different facts and
    // must stay distinguishable in the record.
    expect(digestInput(undefined)).toBeUndefined();
    expect(digestInput(null)).toBeDefined();
  });

  it('never contains the input itself', () => {
    const digest = digestInput({ password: 'hunter2', card: '4111111111111111' });

    expect(digest).not.toContain('hunter2');
    expect(digest).not.toContain('4111');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('canonicalize', () => {
  it('sorts object keys', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('normalises undefined to null so the output is always valid JSON', () => {
    expect(canonicalize(undefined)).toBe('null');
  });
});

describe('principalRef (§9.3)', () => {
  it('never returns the raw identifier', () => {
    const ref = principalRef('alice@example.com');

    expect(ref).not.toContain('alice');
    expect(ref).not.toContain('@');
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is stable, so two records of one principal correlate', () => {
    // Deliberately unsalted. A per-process salt would be "safer" in a sense
    // that does not apply — this is a pseudonym, not a secret — and would
    // break correlation across restarts and instances, which is the one job
    // the field has.
    expect(principalRef('alice')).toBe(principalRef('alice'));
  });

  it('separates different principals', () => {
    expect(principalRef('alice')).not.toBe(principalRef('bob'));
  });
});

describe('auditEventId', () => {
  it('sorts lexicographically by creation time', () => {
    // §48 asks for ULID or UUIDv7; what the requirement is FOR is that
    // records sort by creation time under a plain string sort.
    const earlier = auditEventId(1_000);
    const later = auditEventId(2_000);

    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it('is unique within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 100 }, () => auditEventId(1_000)));

    expect(ids.size).toBe(100);
  });
});
