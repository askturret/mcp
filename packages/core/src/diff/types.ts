// SPDX-License-Identifier: Apache-2.0
/**
 * Snapshot diff vocabulary (§13).
 *
 * Diff turns "the MCP surface" into a governed contract: CI can refuse a
 * release whose tool surface broke without a major version bump. That only
 * works if the classification is data a machine can act on, so every change is
 * a `Change` with a stable `code`, not a formatted string.
 */

import type { EffectClassification } from '../types.js';

/**
 * How a change should be treated by a release gate.
 *
 * `double-check` is NOT a severity between breaking and non-breaking — it is
 * non-breaking, with a note. §13 asks for exactly one case of it (an effect
 * classification LOOSENED, e.g. `readOnly: false -> true`): agents can retry
 * safely so nothing breaks, but the operation's declared intent changed, and
 * silently accepting a tool that just claimed to become read-only is how a
 * mislabelled mutation ships. It does not affect the exit code.
 *
 * `ambiguous` means diff DECLINED to classify — see `operation-possibly-renamed`.
 */
export type ChangeSeverity = 'breaking' | 'non-breaking' | 'double-check' | 'ambiguous';

/**
 * Stable machine-readable change codes.
 *
 * A closed union rather than free strings: these are the vocabulary a CI gate
 * writes rules against, so a typo must be a compile error rather than a rule
 * that silently never matches.
 */
export type ChangeCode =
  // Operation-level
  | 'operation-removed'
  | 'operation-added'
  | 'operation-renamed'
  | 'operation-possibly-renamed'
  // Input schema
  | 'input-required-field-added'
  | 'input-field-removed'
  | 'input-optional-field-added'
  | 'input-type-narrowed'
  | 'input-enum-reduced'
  | 'input-constraint-tightened'
  | 'input-additional-properties-removed'
  // Output schema
  | 'output-field-removed'
  | 'output-type-widened'
  | 'output-field-added'
  // Effects
  | 'effects-tightened'
  | 'effects-loosened'
  | 'effects-classification-added'
  | 'effects-classification-removed'
  | 'confirmation-now-required'
  | 'confirmation-no-longer-required'
  // Cosmetic
  | 'description-changed'
  | 'name-changed'
  | 'annotations-changed';

export interface Change {
  readonly code: ChangeCode;
  readonly severity: ChangeSeverity;

  /**
   * The operation this change belongs to.
   *
   * For a rename this is the AFTER id, with the before id carried in `detail`,
   * because a consumer grouping by operation wants the identity that still
   * exists.
   */
  readonly operationId: string;

  /** Human-readable one-liner. Safe to print; never the machine contract. */
  readonly detail: string;

  /** Dotted path within the operation, when the change is field-scoped. */
  readonly path?: string;
}

export interface DiffSummary {
  readonly breaking: number;
  readonly nonBreaking: number;
  readonly doubleCheck: number;
  readonly ambiguous: number;
}

export interface SnapshotRef {
  readonly version: number;
  readonly hash: string;
}

export interface DiffReport {
  readonly before: SnapshotRef;
  readonly after: SnapshotRef;
  readonly changes: readonly Change[];
  readonly summary: DiffSummary;

  /**
   * True when at least one `breaking` change is present.
   *
   * Precomputed rather than left to each consumer to derive, because "does this
   * fail the build" must not be re-implemented (and mis-implemented) per call
   * site. `ambiguous` deliberately does NOT set this — see `diffSnapshots`.
   */
  readonly hasBreaking: boolean;
}

/**
 * Effect classifications that trigger a confirmation challenge.
 *
 * Mirrors `PRODUCTION_CONFIRM_FOR` in the production preset (§10.2). It is
 * duplicated as a default rather than imported so that `diff` does not silently
 * inherit a preset's policy decisions — see the note on `DiffOptions.confirmFor`.
 */
export const DEFAULT_CONFIRM_FOR: readonly EffectClassification[] = ['financial', 'destructive'];

export interface DiffOptions {
  /**
   * Known renames, `{ oldId: newId }` (§13 "hint file").
   *
   * Without a hint a rename is indistinguishable from a removal plus an
   * unrelated addition, because the id IS the identity.
   */
  readonly renames?: Readonly<Record<string, string>>;

  /**
   * Effect classifications that require confirmation under the policy the
   * server will actually run.
   *
   * ## Why this is a parameter and not a constant
   *
   * §13 lists "policy change requiring confirmation for a tool that previously
   * did not" as breaking. Whether a tool requires confirmation is
   * `classifications ∩ confirmFor` — and only the first half is in the
   * snapshot. `confirmFor` comes from `confirmationForEffects(...)` in the
   * server's policy configuration, which diff never sees.
   *
   * So diff computes this rule UNDER A STATED ASSUMPTION about the policy,
   * defaulting to the production preset's set. Pass the real set to get a real
   * answer. What diff must not do is pretend the rule is snapshot-derivable
   * and quietly report a confirmation change that the deployed policy would
   * never make.
   */
  readonly confirmFor?: readonly EffectClassification[];
}
