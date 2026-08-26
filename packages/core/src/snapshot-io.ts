// SPDX-License-Identifier: Apache-2.0
/**
 * On-disk snapshot format (§13 diff).
 *
 * ## Why this file had to exist before `diff` could
 *
 * `diff --before snapshot.json` presumes a documented, stable serialization of
 * `RegistrySnapshot`. There was none: `RegistrySnapshot.operations` is a
 * `ReadonlyMap` and `createdAt` is a `Date`, and `JSON.stringify` turns the
 * first into `{}` and the second into a string with no way back. So a snapshot
 * could be produced in memory and never written down.
 *
 * This is deliberately the SMALLEST format that round-trips what diff compares,
 * not a general persistence layer.
 *
 * ## Determinism
 *
 * Operations serialize as an ARRAY sorted by id, not as an object. Two reasons,
 * and the second is the one that matters:
 *
 * 1. A Map has no JSON object form that preserves ordering guarantees.
 * 2. A sorted array makes the FILE byte-stable for a given snapshot, so
 *    `snapshot.json` can be committed and reviewed in a PR. A file that
 *    reorders itself on every write produces diff noise that trains reviewers
 *    to skip it — which defeats the point of committing it at all.
 */

import { computeHash } from './compiler/hash.js';
import type {
  JSONSchema,
  OperationDefinition,
  OperationId,
  ProvenanceEntry,
  RegistrySnapshot,
} from './types.js';

/**
 * Format version for the file itself, NOT the snapshot's own `version`.
 *
 * Kept separate because they answer different questions: `version` is "which
 * generation of the registry is this", `formatVersion` is "can this reader
 * understand the bytes". Conflating them means a format change looks like a
 * registry change to every consumer.
 */
export const SNAPSHOT_FORMAT_VERSION = 1;

export interface SerializedSnapshot {
  readonly formatVersion: number;
  readonly version: number;
  readonly hash: string;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  readonly operations: readonly OperationDefinition[];
}

export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotFormatError';
  }
}

/**
 * Convert a snapshot to its on-disk form.
 */
export function serializeSnapshot(snapshot: RegistrySnapshot): SerializedSnapshot {
  const operations = [...snapshot.operations.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    version: snapshot.version,
    hash: snapshot.hash,
    createdAt: snapshot.createdAt.toISOString(),
    operations,
  };
}

/**
 * Parse a snapshot from its on-disk form, verifying its content hash.
 *
 * ## This used to accept an unverified hash (#347)
 *
 * The previous docblock framed verification as a choice between duplicating
 * the hash algorithm — two implementations that drift, surfacing as spurious
 * "corrupt snapshot" errors — and widening the compiler's public surface. Both
 * horns were real; the dilemma was not exhaustive. `compiler/index.ts`
 * re-exports selectively, so `compiler/hash.ts` is importable from here and
 * from the freeze-and-hash pass while staying invisible outside the package.
 * One implementation, no drift, no new public surface.
 *
 * ## Why an opt-out rather than an unconditional refusal
 *
 * This is the load-bearing decision, so it is recorded here rather than left
 * in a review thread. Three shapes were available, and they differ in what is
 * left unverified afterwards:
 *
 * | shape | floor raised | residual unverified set |
 * |---|---|---|
 * | unconditional refusal | most | empty |
 * | **verify + per-call opt-out** | **nearly as much** | **enumerable by grep** |
 * | `verified: boolean` on the returned value | least | NOT enumerable |
 *
 * The value-flag loses on both counts: its default path is the unsafe one, and
 * its residual cannot be counted — every consumer's handling of the flag would
 * have to be audited, including out-of-tree. `{ verifyHash: false }` attaches
 * the decision to a **call site**, which shows up in a diff and can be counted
 * at any moment with a grep, rather than to **data**, which travels everywhere
 * and is checked nowhere.
 *
 * The escape hatch is also what makes verify-by-default adoptable at all. This
 * repository holds eight legitimate snapshot fixtures whose hashes are mnemonic
 * on purpose (`hash-v1`, `hash-renamed`) — far more useful in a golden failure
 * message than `7e627b9b92551354`. An unconditional refusal would break the
 * diff regression suite on its first commit, and regenerating those fixtures
 * from `computeHash` would couple them to the code they exist to police: a
 * golden fixture regenerated from its subject has stopped being a check.
 *
 * ## What is still NOT guaranteed
 *
 * Stated rather than left to be discovered. After this change the hash is
 * server-authored **unless someone passed `{ verifyHash: false }`** — a
 * materially better position than an open set of construction paths, because
 * the residual is greppable, but still not an invariant. Code elsewhere should
 * not reason as though it were one.
 *
 * @param raw     parsed JSON of a snapshot file
 * @param options `verifyHash: false` skips the hash check. Intended for test
 *                fixtures with deliberately non-digest hashes; it should not
 *                appear on a production code path.
 */
export function deserializeSnapshot(
  raw: unknown,
  options: { readonly verifyHash?: boolean } = {},
): RegistrySnapshot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotFormatError('Snapshot must be a JSON object.');
  }

  const candidate = raw as Record<string, unknown>;

  const formatVersion = candidate['formatVersion'];
  if (typeof formatVersion !== 'number') {
    throw new SnapshotFormatError(
      'Snapshot is missing a numeric `formatVersion`. This does not look like a snapshot file.',
    );
  }
  if (formatVersion > SNAPSHOT_FORMAT_VERSION) {
    // Refuse rather than best-effort. A newer file may express distinctions
    // this reader cannot see, and diff silently ignoring them would report
    // "no breaking changes" about a comparison it did not fully perform —
    // the one wrong answer this tool must never give.
    throw new SnapshotFormatError(
      `Snapshot formatVersion ${formatVersion} is newer than this tool understands ` +
        `(${SNAPSHOT_FORMAT_VERSION}). Upgrade the CLI rather than trusting a partial comparison.`,
    );
  }

  const version = candidate['version'];
  if (typeof version !== 'number') {
    throw new SnapshotFormatError('Snapshot `version` must be a number.');
  }

  const hash = candidate['hash'];
  if (typeof hash !== 'string') {
    throw new SnapshotFormatError('Snapshot `hash` must be a string.');
  }

  const createdAtRaw = candidate['createdAt'];
  if (typeof createdAtRaw !== 'string') {
    throw new SnapshotFormatError('Snapshot `createdAt` must be an ISO-8601 string.');
  }
  const createdAt = new Date(createdAtRaw);
  if (Number.isNaN(createdAt.getTime())) {
    throw new SnapshotFormatError(`Snapshot \`createdAt\` is not a valid date: ${createdAtRaw}`);
  }

  const operationsRaw = candidate['operations'];
  if (!Array.isArray(operationsRaw)) {
    throw new SnapshotFormatError('Snapshot `operations` must be an array.');
  }

  const operations = new Map<OperationId, OperationDefinition>();
  for (const [index, entry] of operationsRaw.entries()) {
    const operation = parseOperation(entry, index);
    if (operations.has(operation.id)) {
      // A duplicate id makes "the operation with id X" ambiguous, and every
      // classification rule below is keyed on exactly that.
      throw new SnapshotFormatError(`Snapshot contains duplicate operation id '${operation.id}'.`);
    }
    operations.set(operation.id, operation);
  }

  // Last, deliberately. Every structural complaint above names a specific
  // malformed field and is more useful than "the hash does not match", which
  // is what a half-parsed file would produce if this ran earlier.
  if (options.verifyHash !== false) {
    const computed = computeHash([...operations.values()]);
    if (computed !== hash) {
      throw new SnapshotFormatError(
        `Snapshot hash '${hash}' does not match its operations (computed '${computed}'). ` +
          `The file has been edited since it was written, or was not produced by this tool. ` +
          `Pass { verifyHash: false } to read it anyway.`,
      );
    }
  }

  return { version, hash, createdAt, operations };
}

function parseOperation(entry: unknown, index: number): OperationDefinition {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new SnapshotFormatError(`operations[${index}] must be an object.`);
  }
  const op = entry as Record<string, unknown>;

  const id = op['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new SnapshotFormatError(`operations[${index}].id must be a non-empty string.`);
  }

  const requireString = (field: string): string => {
    const value = op[field];
    if (typeof value !== 'string') {
      throw new SnapshotFormatError(`operations[${index}] ('${id}').${field} must be a string.`);
    }
    return value;
  };

  const requireSchema = (field: string): JSONSchema => {
    const value = op[field];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SnapshotFormatError(
        `operations[${index}] ('${id}').${field} must be a JSON Schema object.`,
      );
    }
    return value as JSONSchema;
  };

  const effectsRaw = op['effects'];
  if (typeof effectsRaw !== 'object' || effectsRaw === null || Array.isArray(effectsRaw)) {
    throw new SnapshotFormatError(`operations[${index}] ('${id}').effects must be an object.`);
  }
  const effects = effectsRaw as Record<string, unknown>;

  const requireBool = (field: string): boolean => {
    const value = effects[field];
    if (typeof value !== 'boolean') {
      throw new SnapshotFormatError(
        `operations[${index}] ('${id}').effects.${field} must be a boolean.`,
      );
    }
    return value;
  };

  const classificationsRaw = effects['classifications'];
  if (!Array.isArray(classificationsRaw) || classificationsRaw.some((c) => typeof c !== 'string')) {
    throw new SnapshotFormatError(
      `operations[${index}] ('${id}').effects['classifications'] must be an array of strings.`,
    );
  }

  const executor = op['executor'];
  if (typeof executor !== 'object' || executor === null || Array.isArray(executor)) {
    throw new SnapshotFormatError(`operations[${index}] ('${id}').executor must be an object.`);
  }

  return {
    id,
    name: requireString('name'),
    description: requireString('description'),
    input: requireSchema('input'),
    output: requireSchema('output'),
    effects: {
      readOnly: requireBool('readOnly'),
      idempotent: requireBool('idempotent'),
      retryable: requireBool('retryable'),
      idempotencyKeyRequired: requireBool('idempotencyKeyRequired'),
      classifications: classificationsRaw as OperationDefinition['effects']['classifications'],
    },
    executor: executor as OperationDefinition['executor'],
    ...(op['annotations'] === undefined
      ? {}
      : { annotations: op['annotations'] as Readonly<Record<string, unknown>> }),
    ...(op['provenance'] === undefined
      ? {}
      : { provenance: op['provenance'] as readonly ProvenanceEntry[] }),
  };
}
