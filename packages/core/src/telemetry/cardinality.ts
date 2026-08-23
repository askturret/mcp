// SPDX-License-Identifier: Apache-2.0
/**
 * Cardinality rule (§9.2, enforced; §17 criterion 8).
 *
 * Tool names are bounded by the registry, so they are legitimate labels. User,
 * tenant, account, request ID and arbitrary input values are not — each
 * distinct value creates a new time series, and an unbounded label is how a
 * metrics backend falls over.
 */

import { METRIC_DEFINITIONS, type MetricDefinition } from './types.js';

/**
 * Label names that must never appear on a metric (§9.2).
 *
 * The issue names these eight. They are matched NORMALIZED rather than
 * literally — see `normalizeLabel`.
 */
export const LABEL_DENYLIST: readonly string[] = [
  'user',
  'tenant',
  'principal',
  'email',
  'sub',
  'requestId',
  'input',
  'arg',
];

/**
 * Normalize a label for comparison: lowercase, separators stripped.
 *
 * ## Why normalized matching, flagged for QA (#39)
 *
 * The denylist as written mixes conventions: `requestId` is camelCase while
 * every actual metric label in §9.2 is snake_case (`error_code`,
 * `executor_type`). A literal comparison would therefore let `request_id`
 * through — the exact spelling a real implementation would use — while
 * blocking a spelling nobody would write.
 *
 * Normalizing makes `requestId`, `request_id`, `request-id` and `RequestId`
 * all match. Read as the intent rather than the letter of the list; if the
 * literal reading was meant, this is a one-line change.
 */
export function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[_\-.\s]/g, '');
}

const NORMALIZED_DENYLIST = LABEL_DENYLIST.map(normalizeLabel);

/**
 * A label that violates the cardinality rule.
 */
export interface CardinalityViolation {
  readonly metric: string;
  readonly label: string;
  readonly matched: string;
}

/**
 * Is this label denied?
 *
 * Matches on WHOLE normalized segments, not substrings. A substring rule
 * would reject `outcome` (contains "sub") and `input_schema_id`, which is the
 * obvious way to make an enforced guard so annoying that someone disables it.
 */
export function isDeniedLabel(label: string): string | null {
  const normalized = normalizeLabel(label);

  for (const denied of NORMALIZED_DENYLIST) {
    if (normalized === denied) return denied;
  }

  // Also catch compound labels built from a denied term — `user_id`,
  // `tenantName`, `principal_hash` — by splitting on the original separators
  // and camelCase boundaries and testing each part.
  for (const part of splitLabelParts(label)) {
    const normalizedPart = normalizeLabel(part);
    for (const denied of NORMALIZED_DENYLIST) {
      if (normalizedPart === denied) return denied;
    }
  }

  return null;
}

function splitLabelParts(label: string): readonly string[] {
  return label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-.\s]+/)
    .filter((part) => part.length > 0);
}

/**
 * Check every declared metric's label set.
 *
 * Operates on the DECLARATIONS, so the guard can run without executing a
 * request — which is what makes it usable as a CI check rather than as an
 * assertion buried in an integration test.
 */
export function findCardinalityViolations(
  definitions: readonly MetricDefinition[] = METRIC_DEFINITIONS,
): readonly CardinalityViolation[] {
  const violations: CardinalityViolation[] = [];

  for (const definition of definitions) {
    for (const label of definition.labels) {
      const matched = isDeniedLabel(label);
      if (matched !== null) {
        violations.push({ metric: definition.name, label, matched });
      }
    }
  }

  return violations;
}

/**
 * Validate labels supplied at RUNTIME, not just the declared set.
 *
 * The declaration check catches a metric defined with a bad label. This
 * catches a caller passing one that was never declared at all, which the
 * static check cannot see.
 */
export function assertLabelsAllowed(metric: string, labels: Readonly<Record<string, string>>): void {
  for (const label of Object.keys(labels)) {
    const matched = isDeniedLabel(label);
    if (matched !== null) {
      throw new Error(
        `Metric '${metric}' was given label '${label}', which is denied by the §9.2 ` +
          `cardinality rule (matches '${matched}'). Unbounded labels create one time ` +
          `series per distinct value.`,
      );
    }
  }
}
