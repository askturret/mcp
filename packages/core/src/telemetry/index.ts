// SPDX-License-Identifier: Apache-2.0
/**
 * Telemetry ports — span tree, stable attributes, low-cardinality metrics
 * (#39, §9.1 / §9.2, ADR-015).
 */

export {
  METRIC,
  METRIC_DEFINITIONS,
  SPAN_ATTR,
  type MetricDefinition,
  type MetricKind,
  type MetricLabels,
  type MetricName,
  type MetricRecorder,
  type Observability,
  type Span,
  type SpanAttributes,
  type SpanAttributeValue,
  type SpanName,
  type SpanOptions,
  type SpanOutcome,
  type Tracer,
} from './types.js';

export {
  DENIED_ATTRIBUTE_KEYS,
  REDACTED as REDACTED_ATTRIBUTE,
  isDeniedAttributeKey,
  maskUrl,
  sanitizeAttributes,
} from './attributes.js';

export {
  LABEL_DENYLIST,
  assertLabelsAllowed,
  findCardinalityViolations,
  isDeniedLabel,
  normalizeLabel,
  type CardinalityViolation,
} from './cardinality.js';

export {
  createRecordingTracer,
  noopTracer,
  type RecordedSpan,
  type RecordingTracer,
} from './tracer.js';

export {
  createRecordingMetricRecorder,
  emitPlaceholderSeries,
  noopMetricRecorder,
  type RecordedSample,
  type RecordingMetricRecorder,
} from './metrics.js';
