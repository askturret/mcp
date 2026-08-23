// SPDX-License-Identifier: Apache-2.0
/**
 * Schema variance (§13).
 *
 * The direction is the whole contract and it inverts if read carelessly:
 * input TIGHTENING breaks callers, output LOOSENING breaks callers. Every test
 * here asserts one direction AND its mirror, because a comparator that flagged
 * everything as breaking would satisfy half of them.
 */

import { describe, it, expect } from '@jest/globals';
import { compareInputSchemas, compareOutputSchemas } from '../schema-compare.js';

const obj = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object',
  properties,
  ...(required === undefined ? {} : { required }),
});

describe('compareInputSchemas', () => {
  it('flags a newly required field, and does NOT flag a newly optional one', () => {
    const before = obj({ a: { type: 'string' } });

    const required = compareInputSchemas(before, obj({ a: { type: 'string' }, b: { type: 'string' } }, ['b']));
    expect(required.requiredFieldsAdded).toHaveLength(1);
    expect(required.optionalFieldsAdded).toHaveLength(0);

    const optional = compareInputSchemas(before, obj({ a: { type: 'string' }, b: { type: 'string' } }));
    expect(optional.requiredFieldsAdded).toHaveLength(0);
    expect(optional.optionalFieldsAdded).toHaveLength(1);
  });

  it('flags an EXISTING optional field becoming required', () => {
    // Distinct from "a new required field appeared": nothing was added, so a
    // comparator that only diffs property KEYS misses it entirely.
    const before = obj({ a: { type: 'string' } });
    const after = obj({ a: { type: 'string' } }, ['a']);

    expect(compareInputSchemas(before, after).requiredFieldsAdded).toHaveLength(1);
  });

  it('flags a narrowed type but not a widened one', () => {
    const narrowed = compareInputSchemas(
      obj({ a: { type: ['string', 'number'] } }),
      obj({ a: { type: 'string' } }),
    );
    expect(narrowed.typesNarrowed).toHaveLength(1);

    const widened = compareInputSchemas(
      obj({ a: { type: 'string' } }),
      obj({ a: { type: ['string', 'number'] } }),
    );
    expect(widened.typesNarrowed).toHaveLength(0);
  });

  it('treats a string type and a single-element array type as the same claim', () => {
    const delta = compareInputSchemas(
      obj({ a: { type: 'string' } }),
      obj({ a: { type: ['string'] } }),
    );
    expect(delta.typesNarrowed).toHaveLength(0);
  });

  it('flags a reduced enum, and an enum introduced where any value was accepted', () => {
    const reduced = compareInputSchemas(
      obj({ a: { type: 'string', enum: ['x', 'y'] } }),
      obj({ a: { type: 'string', enum: ['x'] } }),
    );
    expect(reduced.enumsReduced).toHaveLength(1);

    const introduced = compareInputSchemas(
      obj({ a: { type: 'string' } }),
      obj({ a: { type: 'string', enum: ['x'] } }),
    );
    expect(introduced.enumsReduced).toHaveLength(1);

    const widened = compareInputSchemas(
      obj({ a: { type: 'string', enum: ['x'] } }),
      obj({ a: { type: 'string', enum: ['x', 'y'] } }),
    );
    expect(widened.enumsReduced).toHaveLength(0);
  });

  it('flags tightened bounds in both directions of tightening', () => {
    const raisedMin = compareInputSchemas(
      obj({ a: { type: 'number', minimum: 1 } }),
      obj({ a: { type: 'number', minimum: 5 } }),
    );
    expect(raisedMin.constraintsTightened).toHaveLength(1);

    // The mirror: a LOWERED maximum tightens just as surely. §13 names only
    // "minimum increased"; implementing that alone would classify this
    // non-breaking.
    const loweredMax = compareInputSchemas(
      obj({ a: { type: 'string', maxLength: 100 } }),
      obj({ a: { type: 'string', maxLength: 10 } }),
    );
    expect(loweredMax.constraintsTightened).toHaveLength(1);

    const loosened = compareInputSchemas(
      obj({ a: { type: 'number', minimum: 5 } }),
      obj({ a: { type: 'number', minimum: 1 } }),
    );
    expect(loosened.constraintsTightened).toHaveLength(0);
  });

  it('treats an absent additionalProperties as permissive', () => {
    // JSON Schema's default is `true`, so "absent -> false" removes a
    // permission even though no key was removed. Reading absence as "unknown"
    // silently misses it.
    const delta = compareInputSchemas(
      obj({ a: { type: 'string' } }),
      { ...obj({ a: { type: 'string' } }), additionalProperties: false },
    );
    expect(delta.additionalPropertiesRemoved).toHaveLength(1);

    const reverse = compareInputSchemas(
      { ...obj({ a: { type: 'string' } }), additionalProperties: false },
      obj({ a: { type: 'string' } }),
    );
    expect(reverse.additionalPropertiesRemoved).toHaveLength(0);
  });

  it('recurses into nested object properties', () => {
    const delta = compareInputSchemas(
      obj({ outer: obj({ inner: { type: 'string' } }) }),
      obj({ outer: obj({ inner: { type: 'string' }, extra: { type: 'string' } }, ['extra']) }),
    );

    expect(delta.requiredFieldsAdded).toHaveLength(1);
    expect(delta.requiredFieldsAdded[0]?.path).toBe('outer.extra');
  });

  it('reports an unrecognised keyword change rather than ignoring it', () => {
    // oneOf/anyOf/$ref are not modelled. Silently treating them as unchanged
    // would let a real break through with a clean report — the one failure
    // this tool must not have.
    const delta = compareInputSchemas(
      obj({ a: { type: 'string', oneOf: [{ const: 'x' }] } }),
      obj({ a: { type: 'string', oneOf: [{ const: 'y' }] } }),
    );
    expect(delta.unrecognisedChanges).toHaveLength(1);
  });
});

describe('compareOutputSchemas', () => {
  it('flags a removed field but not an added one', () => {
    const removed = compareOutputSchemas(
      obj({ a: { type: 'string' }, b: { type: 'string' } }),
      obj({ a: { type: 'string' } }),
    );
    expect(removed.fieldsRemoved).toHaveLength(1);
    expect(removed.fieldsAdded).toHaveLength(0);

    const added = compareOutputSchemas(
      obj({ a: { type: 'string' } }),
      obj({ a: { type: 'string' }, b: { type: 'string' } }),
    );
    expect(added.fieldsRemoved).toHaveLength(0);
    expect(added.fieldsAdded).toHaveLength(1);
  });

  it('flags a WIDENED output type — the mirror of the input rule', () => {
    // A caller written against `string` cannot handle `string | null`.
    const widened = compareOutputSchemas(
      obj({ a: { type: 'string' } }),
      obj({ a: { type: ['string', 'null'] } }),
    );
    expect(widened.typesWidened).toHaveLength(1);

    // Narrowing output is safe: every value still satisfies the old promise.
    const narrowed = compareOutputSchemas(
      obj({ a: { type: ['string', 'null'] } }),
      obj({ a: { type: 'string' } }),
    );
    expect(narrowed.typesWidened).toHaveLength(0);
  });
});
