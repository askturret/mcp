// SPDX-License-Identifier: Apache-2.0
/**
 * Overlays and provenance (§5.3, ADR-019, #55).
 *
 * An overlay lets an adopter change what an operation looks like to an agent —
 * its description, its effect classifications, its visibility — without editing
 * the OpenAPI spec or the framework routes it was generated from. Those are
 * often owned by another team, or regenerated on every build.
 *
 * ## Provenance is the point, not a feature of it
 *
 * Once several things can define the same field, "why is this value here?"
 * stops being answerable by reading any one file. §5.3 calls that out: the
 * precedence chain is only trustworthy if the effective value can be explained.
 * So every field that survives compilation carries WHERE it came from, and the
 * resolver records the answer as it decides rather than reconstructing it
 * afterwards — a reconstruction is a second implementation of the precedence
 * rules, and the two drift.
 */

import type { ProvenanceEntry } from '../types.js';

type ProvenanceEntryKind = ProvenanceEntry['kind'];

/**
 * Where a value came from — §5.3's six levels, highest precedence first.
 *
 * The ORDER of this array is the precedence chain, and it is deliberately
 * data rather than a chain of `if`s: a comparison that reads its ranking from
 * one array cannot disagree with a documented table, whereas branching logic
 * spread over a merge function can and eventually does.
 */
export const PROVENANCE_PRECEDENCE = [
  'code', // 1. explicit code enhancement, via the plugin API's setup()
  'overlay', // 2. an MCP overlay file
  'x-mcp', // 3. source-native x-mcp metadata
  'openapi', // 4. the source definition itself…
  'framework', // 4. …in either of its two flavours
  'inference', // 5. conservative inference (GET -> readOnly)
  'preset', // 6. a preset default
] as const;

/**
 * Reuses `ProvenanceEntry['kind']` from core rather than defining a parallel
 * vocabulary.
 *
 * `OperationDefinition.provenance` already exists and is already serialised by
 * snapshot-io, so a second set of names would mean two things called
 * provenance that do not compare — the drift this module's header warns about,
 * one level up.
 *
 * Note §5.3 names six LEVELS while this has seven VALUES: `openapi` and
 * `framework` are both level 4, two flavours of "the source definition". They
 * therefore rank equally, which `provenanceRank` encodes explicitly.
 */
export type ProvenanceKind = ProvenanceEntryKind;

/** Rank of a provenance kind. Lower wins; `openapi` and `framework` tie. */
export function provenanceRank(kind: ProvenanceKind): number {
  // Collapsed so the two level-4 kinds compare equal, rather than whichever
  // happens to sit earlier in the array beating the other.
  const index = PROVENANCE_PRECEDENCE.indexOf(kind);
  return kind === 'framework' ? PROVENANCE_PRECEDENCE.indexOf('openapi') : index;
}

/**
 * Does `candidate` outrank `incumbent`?
 *
 * Strictly — equal ranks do NOT win. That is what makes two overlays touching
 * the same field a defined situation rather than a race: the later file is
 * applied second and must win explicitly (see `resolveField`), rather than
 * winning by accident of comparison.
 */
export function outranks(candidate: ProvenanceKind, incumbent: ProvenanceKind): boolean {
  return provenanceRank(candidate) < provenanceRank(incumbent);
}

export interface ProvenanceSource {
  readonly kind: ProvenanceKind;
  /** File and, where known, a JSON pointer into it. */
  readonly location?: string;
}

/** A value plus where it came from (§5.3). */
export interface SourcedValue<T> {
  readonly value: T;
  readonly source: ProvenanceSource;
}

/**
 * Per-field provenance for one operation.
 *
 * A parallel MAP rather than wrapping every field in `SourcedValue`, which §55
 * explicitly leaves to ergonomics. Wrapping would change the shape of
 * `OperationDefinition` itself — every consumer, every executor, every adapter
 * would have to unwrap `.value`, and the dispatcher's hot path would allocate a
 * wrapper per field per call. A sidecar keeps the definition exactly as it is
 * and costs nothing to ignore.
 *
 * Keys are dotted paths into the definition: `description`,
 * `effects.classifications`, `input`.
 */
export type ProvenanceMap = Readonly<Record<string, ProvenanceSource>>;

/** An operation's effective definition plus the provenance of each field. */
export interface ProvenancedOperation {
  readonly id: string;
  readonly provenance: ProvenanceMap;
}

// ---------------------------------------------------------------------------
// The overlay document
// ---------------------------------------------------------------------------

/**
 * What an overlay may set on one operation.
 *
 * A closed shape, and validated as one. An overlay naming a field we do not
 * support is far more likely to be a typo — `descriptoin`, `effect` for
 * `effects` — than a feature request, and silently ignoring it means an
 * adopter's customisation never takes effect with nothing to indicate why.
 */
export interface OverlayOperationPatch {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly effects?: {
    readonly classifications?: readonly string[] | null;
    readonly readOnly?: boolean | null;
    readonly idempotent?: boolean | null;
    readonly retryable?: boolean | null;
    readonly idempotencyKeyRequired?: boolean | null;
  } | null;
  readonly visibility?: {
    readonly requirePermissions?: readonly string[] | null;
    readonly hidden?: boolean | null;
  } | null;
  readonly input?: { readonly overrideSchema?: Record<string, unknown> | null } | null;
  readonly output?: { readonly overrideSchema?: Record<string, unknown> | null } | null;
  readonly annotations?: Record<string, unknown> | null;
}

export interface OverlayDocument {
  readonly version: number;
  readonly operations: Readonly<Record<string, OverlayOperationPatch>>;
  /** Where this overlay was loaded from, for provenance locations. */
  readonly location: string;
}

/** The only overlay format version this build understands. */
export const OVERLAY_VERSION = 1;

/**
 * A malformed overlay.
 *
 * `path` names the offending field so an adopter is pointed at a line rather
 * than told the file is bad.
 */
export class OverlayValidationError extends Error {
  readonly location: string;
  readonly path: string;

  constructor(location: string, path: string, message: string) {
    super(`${location}${path === '' ? '' : ` at ${path}`}: ${message}`);
    this.name = 'OverlayValidationError';
    this.location = location;
    this.path = path;
  }
}

/**
 * A field that two overlays both set.
 *
 * §55 asks for a deterministic winner AND a captured warning. The warning is
 * the half that is easy to drop, and the more important one: a silent
 * last-writer-wins is indistinguishable from an overlay that was never loaded,
 * which is exactly the confusion overlays plus provenance exist to remove.
 */
export interface OverlayConflict {
  readonly operationId: string;
  readonly field: string;
  readonly winner: string;
  readonly loser: string;
}
