// SPDX-License-Identifier: Apache-2.0
/**
 * OpenTelemetry adapter (#39, § Delivery).
 *
 * ## Why there is no `@opentelemetry/api` dependency
 *
 * The adapter targets STRUCTURAL types describing the OTel API surface it
 * uses, rather than importing the SDK. Same reasoning as the pino adapter in
 * #38: core and this package gain no runtime dependency and no version pin,
 * while an adopter who has the SDK passes their tracer and meter straight in
 * and it type-checks.
 *
 * It also keeps the honest claim honest — telemetry is opt-in by default, and
 * a package that hard-depends on an SDK is not really opt-in.
 */

import {
  METRIC_DEFINITIONS,
  assertLabelsAllowed,
  sanitizeAttributes,
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
} from '@askturret/mcp-core';

/** The subset of an OTel span this adapter uses. */
export interface OtelSpanLike {
  setAttribute(key: string, value: SpanAttributeValue): unknown;
  end(): void;
}

/** The subset of an OTel tracer this adapter uses. */
export interface OtelTracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, SpanAttributeValue> }): OtelSpanLike;
}

/** The subset of an OTel counter/histogram/gauge this adapter uses. */
export interface OtelInstrumentLike {
  add?(value: number, attributes?: Record<string, string>): void;
  record?(value: number, attributes?: Record<string, string>): void;
}

/** The subset of an OTel meter this adapter uses. */
export interface OtelMeterLike {
  createCounter(name: string, options?: { description?: string }): OtelInstrumentLike;
  createHistogram(name: string, options?: { description?: string }): OtelInstrumentLike;
  createUpDownCounter(name: string, options?: { description?: string }): OtelInstrumentLike;
}

export interface OpenTelemetryConfig {
  readonly tracer?: OtelTracerLike;
  readonly meter?: OtelMeterLike;
}

/**
 * Build an `Observability` from an OTel tracer and/or meter.
 *
 * Either may be omitted; the missing half degrades to a no-op rather than
 * throwing, because "traces but no metrics" is a legitimate deployment and
 * failing it would be gratuitous.
 *
 * Attributes are sanitised in core BEFORE reaching the SDK. This adapter must
 * never become a second place where redaction is decided — one enforcement
 * point, at the port, is the whole reason the port exists.
 */
export function openTelemetry(config?: OpenTelemetryConfig): Observability {
  return {
    tracer: config?.tracer ? otelTracer(config.tracer) : inertTracer,
    metrics: config?.meter ? otelMetrics(config.meter) : inertMetrics,
  };
}

const inertTracer: Tracer = {
  startSpan: (name) => inertSpan(name),
};

function inertSpan(name: SpanName): Span {
  return {
    name,
    setAttribute: () => undefined,
    setAttributes: () => undefined,
    setOutcome: () => undefined,
    startChild: (child) => inertSpan(child),
    end: () => undefined,
  };
}

const inertMetrics: MetricRecorder = {
  add: () => undefined,
  record: () => undefined,
  set: () => undefined,
};

function otelTracer(tracer: OtelTracerLike): Tracer {
  const build = (name: SpanName, options?: SpanOptions): Span => {
    const attributes = options?.attributes ? sanitizeAttributes(options.attributes) : undefined;
    const underlying = tracer.startSpan(name, attributes ? { attributes: { ...attributes } } : {});

    const span: Span = {
      name,
      setAttribute(key, value) {
        for (const [k, v] of Object.entries(sanitizeAttributes({ [key]: value }))) {
          underlying.setAttribute(k, v);
        }
      },
      setAttributes(attrs: SpanAttributes) {
        for (const [k, v] of Object.entries(sanitizeAttributes(attrs))) {
          underlying.setAttribute(k, v);
        }
      },
      setOutcome(outcome: SpanOutcome, errorCode?: string) {
        underlying.setAttribute('mcp.outcome', outcome);
        if (errorCode !== undefined) {
          underlying.setAttribute('mcp.error.code', errorCode);
        }
      },
      // Parent/child linkage is the SDK's job via its active-context
      // mechanism; this adapter does not try to reimplement context
      // propagation, which is the part of OTel most easily got wrong.
      startChild: (childName, childOptions) => build(childName, childOptions),
      end: () => underlying.end(),
    };

    return span;
  };

  return { startSpan: (name, options) => build(name, options) };
}

function otelMetrics(meter: OtelMeterLike): MetricRecorder {
  const instruments = new Map<MetricName, OtelInstrumentLike>();

  for (const definition of METRIC_DEFINITIONS) {
    const options = { description: definition.description };
    const instrument =
      definition.kind === 'counter'
        ? meter.createCounter(definition.name, options)
        : definition.kind === 'histogram'
          ? meter.createHistogram(definition.name, options)
          : meter.createUpDownCounter(definition.name, options);

    instruments.set(definition.name, instrument);
  }

  const emit = (
    method: 'add' | 'record',
    name: MetricName,
    value: number,
    labels: MetricLabels,
  ): void => {
    // Enforced here as well as in core, because an adopter can construct this
    // recorder directly and bypass core's own recorder entirely.
    assertLabelsAllowed(name, labels);

    const instrument = instruments.get(name);
    const fn = instrument?.[method];
    if (instrument && typeof fn === 'function') {
      fn.call(instrument, value, { ...labels });
    }
  };

  return {
    add: (name, value, labels) => emit('add', name, value, labels),
    record: (name, value, labels) => emit('record', name, value, labels),
    // Gauges are modelled as UpDownCounters, which expose `add`. A true
    // observable gauge needs a callback the SDK polls, which does not fit a
    // push-shaped port; `set` therefore records an absolute sample via `add`
    // and is documented as such rather than silently approximating.
    set: (name, value, labels) => emit('add', name, value, labels),
  };
}
