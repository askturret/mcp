// SPDX-License-Identifier: Apache-2.0
/**
 * Migration types (#62, §16).
 *
 * A migration is DATA — a version pair plus a list of rules — so the engine
 * that applies it has no per-version branches. Adding a migration is adding an
 * entry to a registry, and that is what keeps this from turning into the
 * general-purpose codemod framework §62 lists as a non-goal.
 */

/** The four things §62 asks a migration to cover. */
export type RuleKind =
  /** A key renamed, moved, or removed in a config file. */
  | 'config'
  /** A field whose meaning changed in an overlay document. */
  | 'overlay'
  /** A renamed or removed export, at its call sites. */
  | 'source'
  /** A shape change in machine-readable output that a consumer parses. */
  | 'output';

/**
 * Whether a migration describes a release that happened.
 *
 * ## Why this field exists rather than a comment
 *
 * A migration is most cheaply and accurately written **at the same time as the
 * breaking change**, by the person making it — not reconstructed months later
 * by someone reading a diff. But a migration for an unreleased change must not
 * be applied to an adopter's project, because the version they would be
 * migrating to does not exist yet.
 *
 * `prospective` lets both be true. The engine skips these unless explicitly
 * asked, `--check` reports them in their own section, and the guide marks them.
 * Encoding it as a field rather than prose means the engine can act on it, and
 * that nobody has to notice a comment.
 */
export type MigrationStatus = 'published' | 'prospective';

/** Rewrite a config-file key, or report one that cannot be rewritten. */
export interface ConfigRule {
  readonly kind: 'config';
  readonly id: string;
  /** Dotted path in the config document, e.g. `audit.sink.durable`. */
  readonly from: string;
  /**
   * Dotted path it becomes. Omitted means the key was REMOVED — the engine
   * reports it and does not delete anything, because deleting a setting an
   * adopter wrote is a decision only they can make.
   */
  readonly to?: string;
  /** Rewrite the value too, when the shape changed rather than the name. */
  readonly value?: (previous: unknown) => unknown;
  readonly reason: string;
}

/** Rewrite an overlay field whose semantics changed. */
export interface OverlayRule {
  readonly kind: 'overlay';
  readonly id: string;
  /** Path within an operation patch, e.g. `effects.classifications`. */
  readonly from: string;
  readonly to?: string;
  readonly value?: (previous: unknown) => unknown;
  readonly reason: string;
}

/** Rewrite a renamed export at its call sites. */
export interface SourceRule {
  readonly kind: 'source';
  readonly id: string;
  /** The exported identifier as it was. */
  readonly from: string;
  /** What it is called now. Omitted means removed — reported, never rewritten. */
  readonly to?: string;
  /** Package the identifier is imported from, so unrelated same-named symbols are left alone. */
  readonly module: string;
  readonly reason: string;
}

/** Warn a consumer of machine-readable output that its shape moved. */
export interface OutputRule {
  readonly kind: 'output';
  readonly id: string;
  /** Which output, e.g. `doctor --json`. */
  readonly surface: string;
  /** Dotted path within that output. */
  readonly from: string;
  readonly to?: string;
  readonly reason: string;
}

export type MigrationRule = ConfigRule | OverlayRule | SourceRule | OutputRule;

export interface Migration {
  /** Version this migrates FROM, e.g. `0.1`. */
  readonly from: string;
  /** Version this migrates TO, e.g. `0.2`. */
  readonly to: string;
  readonly status: MigrationStatus;
  /** One line, used as the guide snippet's heading. */
  readonly summary: string;
  /** Issue or PR this came from, so a reader can find the reasoning. */
  readonly reference: string;
  readonly rules: readonly MigrationRule[];
}

/** One thing the engine found, whether or not it changed anything. */
export interface Finding {
  readonly ruleId: string;
  readonly kind: RuleKind;
  /** File it was found in, repo-relative. */
  readonly file: string;
  /** What the engine did, or would do. */
  readonly action: 'rewrite' | 'manual';
  readonly detail: string;
}

export interface MigrationResult {
  readonly migrations: readonly Migration[];
  readonly findings: readonly Finding[];
  /** Files whose contents the engine changed (empty in `--check`). */
  readonly changed: readonly string[];
  /**
   * True when applying would change something.
   *
   * Drives `--check`'s exit code, and is deliberately NOT `findings.length > 0`:
   * a `manual` finding needs a human but is not something `migrate` would have
   * written, so reporting it must not make an already-migrated project fail CI
   * forever.
   */
  readonly changesNeeded: boolean;
}
