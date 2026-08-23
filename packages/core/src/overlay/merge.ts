// SPDX-License-Identifier: Apache-2.0
/**
 * Applying overlays, and recording why each value won (§5.3, #55).
 *
 * ## Provenance is recorded as decisions are made
 *
 * Not reconstructed afterwards. A reconstruction would be a SECOND
 * implementation of the precedence rules, and two implementations of the same
 * rules drift — at which point the Explorer's "why is this value here?" answer
 * and the value itself disagree, which is worse than not offering the answer.
 *
 * So `resolveField` is the only place a field is chosen, and it writes the
 * provenance entry in the same breath.
 */

import {
  outranks,
  type OverlayConflict,
  type OverlayDocument,
  type OverlayOperationPatch,
  type ProvenanceMap,
  type ProvenanceSource,
} from './types.js';
import type { ProvenanceEntry } from '../types.js';

/**
 * JSON Merge Patch (RFC 7386) — used for schema patches.
 *
 * Two properties matter here and both come from the RFC rather than from
 * taste:
 *
 *   - objects merge RECURSIVELY, so a patch touching one property of a nested
 *     schema leaves its siblings alone;
 *   - `null` REMOVES the key, which is exactly §55's "setting a field to null
 *     in the overlay explicitly removes it".
 *
 * Arrays REPLACE rather than merge. That is the RFC's rule and the right one
 * for schemas: element-wise merging `required: ['a','b']` against
 * `required: ['c']` has no defensible answer, and picking one silently is how
 * a required field goes missing.
 */
export function jsonMergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null) return undefined; // caller deletes the key
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;

  const base: Record<string, unknown> =
    typeof target === 'object' && target !== null && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};

  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    const merged = jsonMergePatch(base[key], value);
    if (merged === undefined) delete base[key];
    else base[key] = merged;
  }

  return base;
}

/** A field's current value and where it came from. */
export interface FieldState<T> {
  readonly value: T | undefined;
  readonly source: ProvenanceSource;
}

export interface ResolveOptions {
  readonly operationId: string;
  readonly field: string;
  readonly conflicts: OverlayConflict[];
}

/**
 * Decide whether `candidate` replaces `incumbent`, and record why.
 *
 * Three cases, and the third is the one §55 asks for explicitly:
 *
 *   - candidate outranks incumbent -> candidate wins.
 *   - incumbent outranks candidate -> incumbent stands.
 *   - EQUAL rank -> candidate wins (it was applied later), and a conflict is
 *     RECORDED.
 *
 * Last-writer-wins at equal rank is the deterministic rule §55 names — two
 * overlays, later file wins. The recorded warning is the half that is easy to
 * drop and the more important one: a silent overwrite is indistinguishable
 * from an overlay that never loaded, which is precisely the confusion
 * overlays-plus-provenance exist to remove.
 */
export function resolveField<T>(
  incumbent: FieldState<T>,
  candidateValue: T | undefined,
  candidateSource: ProvenanceSource,
  options: ResolveOptions,
): FieldState<T> {
  if (candidateValue === undefined) return incumbent;

  if (incumbent.value === undefined || outranks(candidateSource.kind, incumbent.source.kind)) {
    return { value: candidateValue, source: candidateSource };
  }

  if (outranks(incumbent.source.kind, candidateSource.kind)) return incumbent;

  // Equal rank: later wins, and the collision is reported.
  options.conflicts.push({
    operationId: options.operationId,
    field: options.field,
    winner: candidateSource.location ?? candidateSource.kind,
    loser: incumbent.source.location ?? incumbent.source.kind,
  });

  return { value: candidateValue, source: candidateSource };
}

/** An operation as the overlay pass sees it: fields plus their provenance. */
export interface OverlayTarget {
  readonly id: string;
  name?: string;
  description?: string;
  effects?: Record<string, unknown>;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  visibility?: Record<string, unknown>;
}

export interface ApplyOverlaysResult {
  readonly operation: OverlayTarget;
  readonly provenance: ProvenanceMap;
  readonly conflicts: readonly OverlayConflict[];
  /** Overlay entries naming an operation that does not exist. */
  readonly unmatched: readonly string[];
}

function sourceFor(document: OverlayDocument, id: string, field: string): ProvenanceSource {
  // A JSON pointer into the overlay, so provenance points at the LINE an
  // adopter edits rather than merely naming the file.
  return { kind: 'overlay', location: `${document.location}#/operations/${id}/${field}` };
}

/**
 * Apply every overlay to one operation, in order, tracking provenance.
 *
 * `baseProvenance` is what the earlier passes established — `source` for
 * fields that came from the spec, `inference` for what was derived. Fields an
 * overlay does not mention keep it.
 */
export function applyOverlaysToOperation(
  operation: OverlayTarget,
  overlays: readonly OverlayDocument[],
  baseProvenance: ProvenanceMap,
  conflicts: OverlayConflict[],
): { operation: OverlayTarget; provenance: ProvenanceMap } {
  const next: OverlayTarget = { ...operation };
  const provenance: Record<string, ProvenanceSource> = { ...baseProvenance };

  const defaultSource = (field: string): ProvenanceSource =>
    // `openapi` stands for §5.3 level 4 when nothing earlier recorded one —
    // `framework` ranks identically, so the choice does not affect precedence.
    provenance[field] ?? ({ kind: 'openapi' } as ProvenanceSource);

  for (const document of overlays) {
    const patch: OverlayOperationPatch | undefined = document.operations[operation.id];
    if (patch === undefined) continue;

    // --- scalar fields -----------------------------------------------------
    for (const field of ['name', 'description'] as const) {
      if (!(field in patch)) continue;
      const candidate = patch[field];

      const resolved = resolveField(
        { value: next[field], source: defaultSource(field) },
        candidate === null ? undefined : candidate,
        sourceFor(document, operation.id, field),
        { operationId: operation.id, field, conflicts },
      );

      if (candidate === null) {
        // Explicit null removes the field (§55). Recorded as an overlay
        // decision, not as an absence — "the overlay deleted this" and "nobody
        // ever set it" are different answers to "why is this not here?".
        delete next[field];
        provenance[field] = sourceFor(document, operation.id, field);
        continue;
      }

      if (resolved.value !== undefined) next[field] = resolved.value as string;
      provenance[field] = resolved.source;
    }

    // --- effects -----------------------------------------------------------
    if (patch.effects !== undefined) {
      if (patch.effects === null) {
        delete next.effects;
        provenance['effects'] = sourceFor(document, operation.id, 'effects');
      } else {
        const effects: Record<string, unknown> = { ...(next.effects ?? {}) };
        for (const [key, value] of Object.entries(patch.effects)) {
          const field = `effects.${key}`;
          const resolved = resolveField(
            { value: effects[key], source: defaultSource(field) },
            value === null ? undefined : value,
            sourceFor(document, operation.id, field),
            { operationId: operation.id, field, conflicts },
          );

          if (value === null) {
            delete effects[key];
            provenance[field] = sourceFor(document, operation.id, field);
            continue;
          }

          effects[key] = resolved.value;
          provenance[field] = resolved.source;
        }
        next.effects = effects;
      }
    }

    // --- visibility --------------------------------------------------------
    if (patch.visibility !== undefined) {
      if (patch.visibility === null) {
        delete next.visibility;
        provenance['visibility'] = sourceFor(document, operation.id, 'visibility');
      } else {
        const visibility: Record<string, unknown> = { ...(next.visibility ?? {}) };
        for (const [key, value] of Object.entries(patch.visibility)) {
          const field = `visibility.${key}`;
          if (value === null) {
            delete visibility[key];
          } else {
            visibility[key] = value;
          }
          provenance[field] = sourceFor(document, operation.id, field);
        }
        next.visibility = visibility;
      }
    }

    // --- schema patches (JSON Merge Patch) ---------------------------------
    for (const [side, target] of [
      ['input', 'rawInput'],
      ['output', 'rawOutput'],
    ] as const) {
      const entry = patch[side];
      if (entry === undefined) continue;

      if (entry === null || entry.overrideSchema === null) {
        delete next[target];
        provenance[side] = sourceFor(document, operation.id, side);
        continue;
      }
      if (entry.overrideSchema === undefined) continue;

      const merged = jsonMergePatch(next[target], entry.overrideSchema);
      if (merged !== undefined) next[target] = merged as Record<string, unknown>;
      else delete next[target];
      provenance[side] = sourceFor(document, operation.id, side);
    }

    // --- annotations -------------------------------------------------------
    if (patch.annotations !== undefined) {
      if (patch.annotations === null) {
        delete next.annotations;
      } else {
        const merged = jsonMergePatch(next.annotations, patch.annotations);
        if (merged !== undefined) next.annotations = merged as Record<string, unknown>;
        else delete next.annotations;
      }
      provenance['annotations'] = sourceFor(document, operation.id, 'annotations');
    }
  }

  return { operation: next, provenance };
}

/**
 * Overlay entries that matched no operation.
 *
 * Surfaced rather than ignored: an overlay keyed on an id that no longer
 * exists — renamed upstream, or mistyped — is a customisation that silently
 * does nothing, and the adopter has no way to tell that from one that applied.
 */
export function unmatchedOverlayIds(
  overlays: readonly OverlayDocument[],
  knownIds: ReadonlySet<string>,
): readonly string[] {
  const missing: string[] = [];

  for (const document of overlays) {
    for (const id of Object.keys(document.operations)) {
      if (!knownIds.has(id)) missing.push(`${document.location}#/operations/${id}`);
    }
  }

  return missing;
}

/**
 * Convert the working map into the `ProvenanceEntry[]` the definition carries.
 *
 * `OperationDefinition.provenance` is already an ARRAY and is already
 * serialised by snapshot-io, so this is what actually leaves the compiler. The
 * map is the working form — keyed lookup is what the merge needs — and this is
 * the single place the two representations meet, rather than both being
 * maintained.
 *
 * Sorted by field so a snapshot hash does not move because two overlays were
 * applied in a different order on a rebuild. The registry hash is compared
 * across deployments (#64); a provenance array whose ORDER varied would make
 * identical registries hash differently.
 */
export function provenanceEntries(map: ProvenanceMap): ProvenanceEntry[] {
  return Object.entries(map)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([field, source]) =>
      source.location === undefined
        ? { field, kind: source.kind }
        : { field, kind: source.kind, location: source.location },
    );
}
