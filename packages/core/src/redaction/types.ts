// SPDX-License-Identifier: Apache-2.0
/**
 * Central redaction pipeline (§9.4, ADR-016).
 *
 * Centralized specifically so each adapter and exporter does not reimplement
 * it inconsistently. Every observable exit passes through this one pipeline
 * before data leaves the process — which means the interesting property is not
 * that redaction happens, but that there is exactly ONE place it happens.
 */

/**
 * The observable exits (§9.4).
 *
 * A closed union rather than a string, and that is load-bearing: adding a
 * seventh surface is a compile error everywhere the set is enumerated
 * exhaustively — including the snapshot test that proves each one strips a
 * known secret. §49 asks for exactly that ("adding a new surface without
 * wiring it into redaction fails the snapshot check"), and a free-form string
 * could not deliver it.
 */
export type RedactionSurface =
  | 'log'
  | 'span'
  | 'metric'
  | 'audit'
  | 'explorer'
  | 'error'
  | 'diagnostic-bundle';

/** Every surface, for exhaustive iteration. Kept in sync by the type below. */
export const REDACTION_SURFACES = [
  'log',
  'span',
  'metric',
  'audit',
  'explorer',
  'error',
  'diagnostic-bundle',
] as const satisfies readonly RedactionSurface[];

export interface RedactionContext {
  readonly surface: RedactionSurface;

  /** JSON path from the root of the value being redacted. */
  readonly path: readonly string[];

  readonly operationId?: string;
}

/**
 * One redaction decision.
 *
 * ## `matches` takes the VALUE as well as the context — a deliberate deviation
 *
 * §49 writes the signature as `matches(field: RedactionContext): boolean`,
 * which can only see the path. That is enough for key-name rules and useless
 * for everything else — and "everything else" is the entire finding #38
 * produced. #38's gap detector exists precisely because key-name matching
 * cannot see a JWT sitting under a key called `proxyAuth`, and it spent a
 * release collecting evidence of exactly that.
 *
 * Implementing the literal signature would therefore discard the signal this
 * issue was designed around. The value is passed as a SECOND argument, so a
 * rule that only cares about the path simply ignores it and the spec's shape
 * still type-checks. Flagged for QA; logged to #156.
 */
export interface RedactionRule {
  readonly id: string;

  matches(context: RedactionContext, value: unknown): boolean;

  /** Typically `'[REDACTED]'`, or a hash when the shape must be preserved. */
  transform(value: unknown): unknown;
}

export interface RedactionPipeline {
  redact(value: unknown, context: RedactionContext): unknown;

  /**
   * Append a rule.
   *
   * User rules land AFTER the built-ins (§49), so a built-in wins a tie on any
   * node a built-in ALSO matches. That is the whole of what ordering buys.
   *
   * It does NOT stop a user rule un-redacting what the defaults would have
   * caught. Ordering is a tie-break, not containment: `redact` tests every node
   * including containers, and a match returns without descending. A rule that
   * matches a plain object therefore claims it outright — no built-in matches a
   * container, so there is no tie to lose — and the leaves the built-ins would
   * have caught are never visited.
   *
   * For adopter rules this is deliberate, not an oversight: replacing a whole
   * subtree is a legitimate capability, and code calling `add` already runs
   * inside the adopter's own trust boundary. Plugin-supplied rules are
   * third-party, so they are wrapped by `constrainPluginRedactionRule` to
   * decline containers.
   *
   * Both halves are pinned by
   * `redaction/__tests__/ordering-is-not-containment.test.ts`.
   */
  add(rule: RedactionRule): void;

  /** Rules in evaluation order. Exposed for tests and diagnostics. */
  rules(): readonly RedactionRule[];
}
