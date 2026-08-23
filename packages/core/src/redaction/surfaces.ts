// SPDX-License-Identifier: Apache-2.0
/**
 * Surface adapters — the six observable exits of §9.4.
 *
 * Each is a thin function so the WIRING is visible in one file. A reviewer
 * asking "does every exit redact?" reads this, not six call sites scattered
 * across three packages.
 */

import type { MetricLabels, MetricName, MetricRecorder } from '../telemetry/types.js';
import { redactValue } from './default.js';
import type { RedactionPipeline } from './types.js';

/** Surface 1 — log fields. */
export function redactLogFields<T>(fields: T, pipeline?: RedactionPipeline): T {
  return redactValue('log', fields, pipeline) as T;
}

/** Surface 2 — span attributes. */
export function redactSpanAttributes<T>(attributes: T, pipeline?: RedactionPipeline): T {
  return redactValue('span', attributes, pipeline) as T;
}

/**
 * Surface 3 — metric labels.
 *
 * §9.4 asks for a STRICTER treatment here, and the reason is worth stating:
 * a leaked log line is one record, whereas a leaked metric label is a time
 * series that persists in the metrics backend, is indexed, and is retained
 * long after the log has rotated away. It is also far harder to delete.
 *
 * So label values go through the same rules as everything else, and anything
 * that matches is stripped rather than merely flagged. There is no
 * surface-specific exemption list, unlike `audit`.
 */
export function redactMetricLabels(
  labels: MetricLabels,
  pipeline?: RedactionPipeline,
): MetricLabels {
  return redactValue('metric', labels, pipeline) as MetricLabels;
}

/**
 * Wrap a recorder so every label set is redacted before it reaches the sink.
 *
 * Offered as a WRAPPER rather than baked into one recorder because the real
 * exporter lives in `@askturret/mcp-observability`, which core cannot import.
 * An adapter composes this around its own recorder and gets the guarantee.
 */
export function redactingMetricRecorder(
  delegate: MetricRecorder,
  pipeline?: RedactionPipeline,
): MetricRecorder {
  const clean = (labels: MetricLabels): MetricLabels => redactMetricLabels(labels, pipeline);

  return {
    add: (name: MetricName, value: number, labels: MetricLabels) =>
      delegate.add(name, value, clean(labels)),
    record: (name: MetricName, value: number, labels: MetricLabels) =>
      delegate.record(name, value, clean(labels)),
    set: (name: MetricName, value: number, labels: MetricLabels) =>
      delegate.set(name, value, clean(labels)),
  };
}

/**
 * Surface 4 — the audit event, immediately before `sink.append`.
 *
 * Runs AFTER `inputDigest` has been computed, and that ordering is a
 * correctness requirement rather than a convenience. #48 guarantees the same
 * input digests identically across runs; if redaction ran before the digest,
 * the digest would depend on the rule set and would change the next time a
 * rule was added — silently breaking every historical correlation.
 *
 * Redacting the event afterwards is safe because the event carries no raw
 * input to begin with: the digest and the principal reference are what it
 * holds, and both are exempted so they survive (see AUDIT_STRUCTURAL_FIELDS).
 */
export function redactAuditEvent<T>(event: T, pipeline?: RedactionPipeline): T {
  return redactValue('audit', event, pipeline) as T;
}

/** Surface 5 — the Explorer view model, before serialization to the client. */
export function redactExplorerModel<T>(model: T, pipeline?: RedactionPipeline): T {
  return redactValue('explorer', model, pipeline) as T;
}

/** Surface 6 — the serialized error, on the way to the wire. */
export function redactSerializedError<T>(error: T, pipeline?: RedactionPipeline): T {
  return redactValue('error', error, pipeline) as T;
}
