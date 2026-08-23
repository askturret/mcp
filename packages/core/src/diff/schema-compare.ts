// SPDX-License-Identifier: Apache-2.0
/**
 * JSON Schema comparison for §13's tightened/loosened rules.
 *
 * ## The asymmetry is the whole point
 *
 * Input and output are compared in OPPOSITE directions, and mixing them up
 * inverts every verdict:
 *
 * - **Input tightened** breaks callers. A caller that sent a valid request
 *   yesterday must still be valid today, so anything that shrinks the accepted
 *   set — a new required field, a narrower type, a reduced enum — is breaking.
 *   Widening input is safe.
 * - **Output loosened** breaks callers. A caller relying on a promised field
 *   breaks when it disappears or when its type widens to something the caller
 *   cannot handle. Tightening output is safe.
 *
 * This is ordinary contract variance, but it reads backwards the first time,
 * which is exactly why it is written down here rather than inferred at each
 * call site.
 *
 * ## Scope, stated rather than implied
 *
 * This is a STRUCTURAL comparison of the schema subset the compiler emits:
 * `type`, `properties`, `required`, `enum`, `additionalProperties`, and the
 * numeric/length/size bounds. It deliberately does NOT resolve `$ref`, and does
 * not reason about `oneOf`/`anyOf`/`allOf`/`not`.
 *
 * A schema using those constructs is not silently declared unchanged: an
 * unrecognised construct that DIFFERS is reported as a change whose severity
 * errs toward breaking for input and output alike. Reporting a false breaking
 * change costs a reviewer one look; missing a real one is the failure this
 * tool exists to prevent.
 */

import type { JSONSchema } from '../types.js';

/** Keywords this comparator understands. Anything else is "unrecognised". */
const KNOWN_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'enum',
  'additionalProperties',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'items',
  'description',
  'title',
  'default',
  'examples',
  'format',
]);

/** Keywords that carry no contractual weight — prose, not shape. */
const COSMETIC_KEYWORDS = new Set(['description', 'title', 'examples']);

export interface SchemaFieldChange {
  readonly path: string;
  readonly detail: string;
}

export interface InputSchemaDelta {
  readonly requiredFieldsAdded: readonly SchemaFieldChange[];
  readonly fieldsRemoved: readonly SchemaFieldChange[];
  readonly optionalFieldsAdded: readonly SchemaFieldChange[];
  readonly typesNarrowed: readonly SchemaFieldChange[];
  readonly enumsReduced: readonly SchemaFieldChange[];
  readonly constraintsTightened: readonly SchemaFieldChange[];
  readonly additionalPropertiesRemoved: readonly SchemaFieldChange[];
  readonly unrecognisedChanges: readonly SchemaFieldChange[];
}

export interface OutputSchemaDelta {
  readonly fieldsRemoved: readonly SchemaFieldChange[];
  readonly typesWidened: readonly SchemaFieldChange[];
  readonly fieldsAdded: readonly SchemaFieldChange[];
  readonly unrecognisedChanges: readonly SchemaFieldChange[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Normalise `type` to a set. `"string"` and `["string"]` are the same claim. */
function typeSet(schema: Record<string, unknown>): Set<string> | undefined {
  const raw = schema['type'];
  if (typeof raw === 'string') return new Set([raw]);
  if (Array.isArray(raw) && raw.every((t) => typeof t === 'string')) {
    return new Set(raw as string[]);
  }
  return undefined;
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function properties(schema: Record<string, unknown>): Record<string, unknown> {
  return asRecord(schema['properties']) ?? {};
}

function requiredSet(schema: Record<string, unknown>): Set<string> {
  const raw = schema['required'];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((r): r is string => typeof r === 'string'));
}

function enumSet(schema: Record<string, unknown>): Set<string> | undefined {
  const raw = schema['enum'];
  if (!Array.isArray(raw)) return undefined;
  // Serialized so non-primitive enum members still compare by value.
  return new Set(raw.map((v) => JSON.stringify(v)));
}

function join(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

/**
 * `additionalProperties` defaults to permissive when absent.
 *
 * So "absent -> false" IS a removal of permission even though nothing was
 * literally removed, and treating absence as unknown would miss it.
 */
function allowsAdditional(schema: Record<string, unknown>): boolean {
  const raw = schema['additionalProperties'];
  if (raw === undefined) return true;
  if (raw === false) return false;
  return true;
}

/**
 * Bounds, paired with the direction that TIGHTENS them.
 *
 * §13 names only "minimum increased". The others are included because the
 * reasoning is identical — a caller whose value was accepted must still be
 * accepted — and implementing only `minimum` would leave `maxLength` reduced,
 * which breaks callers just as surely, silently classified non-breaking.
 * Flagged for QA as a deliberate superset of the written rule.
 */
const BOUNDS: readonly { key: string; tightensWhen: 'increases' | 'decreases' }[] = [
  { key: 'minimum', tightensWhen: 'increases' },
  { key: 'exclusiveMinimum', tightensWhen: 'increases' },
  { key: 'minLength', tightensWhen: 'increases' },
  { key: 'minItems', tightensWhen: 'increases' },
  { key: 'maximum', tightensWhen: 'decreases' },
  { key: 'exclusiveMaximum', tightensWhen: 'decreases' },
  { key: 'maxLength', tightensWhen: 'decreases' },
  { key: 'maxItems', tightensWhen: 'decreases' },
];

function boundTightened(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string,
): SchemaFieldChange[] {
  const out: SchemaFieldChange[] = [];

  for (const { key, tightensWhen } of BOUNDS) {
    const b = before[key];
    const a = after[key];
    if (typeof a !== 'number') continue;

    // Absent before, present after: a bound appeared where there was none,
    // which constrains callers that previously had no limit at all.
    if (typeof b !== 'number') {
      if (b === undefined) {
        out.push({ path: join(path, key), detail: `${key} constraint added (${a})` });
      }
      continue;
    }

    const tightened = tightensWhen === 'increases' ? a > b : a < b;
    if (tightened) {
      out.push({ path: join(path, key), detail: `${key} ${tightensWhen === 'increases' ? 'increased' : 'decreased'} ${b} -> ${a}` });
    }
  }

  return out;
}

function unrecognisedDifferences(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string,
): SchemaFieldChange[] {
  const out: SchemaFieldChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    if (KNOWN_KEYWORDS.has(key)) continue;
    const b = JSON.stringify(before[key]);
    const a = JSON.stringify(after[key]);
    if (b !== a) {
      out.push({
        path: join(path, key),
        detail: `unrecognised schema keyword '${key}' changed; diff cannot classify it and errs toward breaking`,
      });
    }
  }

  return out;
}

/**
 * Compare two INPUT schemas. Tightening is breaking.
 */
export function compareInputSchemas(before: JSONSchema, after: JSONSchema): InputSchemaDelta {
  const requiredFieldsAdded: SchemaFieldChange[] = [];
  const fieldsRemoved: SchemaFieldChange[] = [];
  const optionalFieldsAdded: SchemaFieldChange[] = [];
  const typesNarrowed: SchemaFieldChange[] = [];
  const enumsReduced: SchemaFieldChange[] = [];
  const constraintsTightened: SchemaFieldChange[] = [];
  const additionalPropertiesRemoved: SchemaFieldChange[] = [];
  const unrecognisedChanges: SchemaFieldChange[] = [];

  const walk = (b: Record<string, unknown>, a: Record<string, unknown>, path: string): void => {
    if (allowsAdditional(b) && !allowsAdditional(a)) {
      additionalPropertiesRemoved.push({
        path: join(path, 'additionalProperties'),
        detail: 'additionalProperties no longer permitted',
      });
    }

    const bTypes = typeSet(b);
    const aTypes = typeSet(a);
    if (bTypes && aTypes && !isSubset(bTypes, aTypes)) {
      typesNarrowed.push({
        path: join(path, 'type'),
        detail: `type narrowed [${[...bTypes].sort().join(', ')}] -> [${[...aTypes].sort().join(', ')}]`,
      });
    }

    const bEnum = enumSet(b);
    const aEnum = enumSet(a);
    if (aEnum && (!bEnum || !isSubset(bEnum, aEnum))) {
      // An enum appearing where there was none is also a reduction: previously
      // any value of the type was accepted.
      enumsReduced.push({
        path: join(path, 'enum'),
        detail: bEnum ? 'enum values removed' : 'enum constraint added where any value was accepted',
      });
    }

    constraintsTightened.push(...boundTightened(b, a, path));
    unrecognisedChanges.push(...unrecognisedDifferences(b, a, path));

    const bProps = properties(b);
    const aProps = properties(a);
    const bRequired = requiredSet(b);
    const aRequired = requiredSet(a);

    for (const key of Object.keys(aProps)) {
      if (key in bProps) continue;
      const target = aRequired.has(key) ? requiredFieldsAdded : optionalFieldsAdded;
      target.push({
        path: join(path, key),
        detail: aRequired.has(key) ? 'new required input field' : 'new optional input field',
      });
    }

    for (const key of Object.keys(bProps)) {
      if (!(key in aProps)) {
        fieldsRemoved.push({ path: join(path, key), detail: 'input field removed' });
        continue;
      }
      // Field became required without being newly added.
      if (!bRequired.has(key) && aRequired.has(key)) {
        requiredFieldsAdded.push({
          path: join(path, key),
          detail: 'existing optional input field is now required',
        });
      }

      const bChild = asRecord(bProps[key]);
      const aChild = asRecord(aProps[key]);
      if (bChild && aChild) walk(bChild, aChild, join(path, key));
    }
  };

  const b = asRecord(before) ?? {};
  const a = asRecord(after) ?? {};
  walk(b, a, '');

  return {
    requiredFieldsAdded,
    fieldsRemoved,
    optionalFieldsAdded,
    typesNarrowed,
    enumsReduced,
    constraintsTightened,
    additionalPropertiesRemoved,
    unrecognisedChanges,
  };
}

/**
 * Compare two OUTPUT schemas. Loosening is breaking.
 */
export function compareOutputSchemas(before: JSONSchema, after: JSONSchema): OutputSchemaDelta {
  const fieldsRemoved: SchemaFieldChange[] = [];
  const typesWidened: SchemaFieldChange[] = [];
  const fieldsAdded: SchemaFieldChange[] = [];
  const unrecognisedChanges: SchemaFieldChange[] = [];

  const walk = (b: Record<string, unknown>, a: Record<string, unknown>, path: string): void => {
    const bTypes = typeSet(b);
    const aTypes = typeSet(a);
    // Widened: the after-set is a strict superset. A caller written against
    // `string` cannot handle `string | null`.
    if (bTypes && aTypes && !isSubset(aTypes, bTypes)) {
      typesWidened.push({
        path: join(path, 'type'),
        detail: `type widened [${[...bTypes].sort().join(', ')}] -> [${[...aTypes].sort().join(', ')}]`,
      });
    }

    unrecognisedChanges.push(...unrecognisedDifferences(b, a, path));

    const bProps = properties(b);
    const aProps = properties(a);

    for (const key of Object.keys(bProps)) {
      if (!(key in aProps)) {
        fieldsRemoved.push({ path: join(path, key), detail: 'promised output field removed' });
        continue;
      }
      const bChild = asRecord(bProps[key]);
      const aChild = asRecord(aProps[key]);
      if (bChild && aChild) walk(bChild, aChild, join(path, key));
    }

    for (const key of Object.keys(aProps)) {
      if (!(key in bProps)) {
        fieldsAdded.push({ path: join(path, key), detail: 'new output field' });
      }
    }
  };

  const b = asRecord(before) ?? {};
  const a = asRecord(after) ?? {};
  walk(b, a, '');

  return { fieldsRemoved, typesWidened, fieldsAdded, unrecognisedChanges };
}

/**
 * Do two schemas differ in any way that is NOT purely cosmetic?
 *
 * Used by rename detection, where the question is "is this structurally the
 * same operation", and a reworded field description must not answer no.
 */
export function schemasStructurallyEqual(before: JSONSchema, after: JSONSchema): boolean {
  return JSON.stringify(stripCosmetic(before)) === JSON.stringify(stripCosmetic(after));
}

function stripCosmetic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCosmetic);
  const record = asRecord(value);
  if (!record) return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (COSMETIC_KEYWORDS.has(key)) continue;
    out[key] = stripCosmetic(record[key]);
  }
  return out;
}
