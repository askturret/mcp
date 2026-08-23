// SPDX-License-Identifier: Apache-2.0
/**
 * Telemetry ports (§9.1 spans, §9.2 metrics, ADR-015).
 *
 * These are PORTS, not an OpenTelemetry integration. Core defines the shape
 * the dispatcher emits against; `@askturret/mcp-observability` adapts it onto
 * a real OTel SDK. Same split as the logging module: core owns the contract,
 * the adapter owns the dependency.
 *
 * The split is not stylistic. The dispatcher lives in core and must emit
 * spans; if the span type came from the observability package, core would
 * depend on its own adapter.
 */

/**
 * Attribute values permitted on a span.
 *
 * Deliberately narrow. Objects and arrays are excluded because the one thing
 * §9.1 forbids outright is dumping request/response bodies onto spans, and an
 * attribute type that accepted arbitrary objects would make that the path of
 * least resistance.
 */
export type SpanAttributeValue = string | number | boolean;

export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

/**
 * The canonical span tree (§9.1).
 *
 * A closed union rather than free-form strings: the tree IS the contract, and
 * a typo'd span name produces a silently missing branch in every trace rather
 * than a compile error.
 */
export type SpanName =
  | 'mcp.request'
  | 'mcp.tool.call'
  | 'policy.evaluate'
  | 'schema.validate.input'
  | 'bulkhead.wait'
  | 'executor.invoke'
  | 'http.client'
  | 'schema.validate.output'
  | 'audit.append';

/**
 * Stable span attribute names (§9.1).
 *
 * Named constants rather than inline strings so a rename is one edit and a
 * mistyped key cannot silently create a parallel attribute nobody queries.
 */
export const SPAN_ATTR = {
  method: 'mcp.method',
  toolName: 'mcp.tool.name',
  protocolVersion: 'mcp.protocol.version',
  registryHash: 'mcp.registry.hash',
  clientName: 'mcp.client.name',
  outcome: 'mcp.outcome',
  errorCode: 'mcp.error.code',
  policyDecision: 'mcp.policy.decision',
  executorType: 'mcp.executor.type',
} as const;

/**
 * Span outcome.
 *
 * ## Spec ambiguity, flagged for QA (#39)
 *
 * §9.1 writes this attribute as `mcp.outcome (success | error_code)`, which
 * reads as "the literal error code on failure". But `mcp.error.code` is a
 * SEPARATE listed attribute, and `outcome` is also a METRIC label on
 * `mcp_requests_total` and `mcp_tool_calls_total`.
 *
 * Implemented as coarse `success | error`, with the code carried in
 * `mcp.error.code`, because:
 *
 * - it keeps the `outcome` metric label at cardinality 2, which is the point
 *   of §9.2's cardinality rule;
 * - `mcp_tool_errors_total{tool, error_code}` already exists to break errors
 *   down by code, so putting codes in `outcome` duplicates it;
 * - otherwise `mcp.outcome` and `mcp.error.code` carry the same value on
 *   every failed span, and a reader cannot tell which is authoritative.
 *
 * If the literal reading was intended, this is a one-line change.
 */
export type SpanOutcome = 'success' | 'error';

export interface SpanOptions {
  readonly attributes?: SpanAttributes;
}

/**
 * An in-flight span.
 *
 * `end()` is idempotent: double-ending is a bookkeeping bug, not a reason to
 * throw inside a request path.
 */
export interface Span {
  readonly name: SpanName;

  setAttribute(key: string, value: SpanAttributeValue): void;
  setAttributes(attributes: SpanAttributes): void;

  /** Record the outcome, and the error code when there is one. */
  setOutcome(outcome: SpanOutcome, errorCode?: string): void;

  /** Start a child span. The tree in §9.1 is built through this. */
  startChild(name: SpanName, options?: SpanOptions): Span;

  end(): void;
}

export interface Tracer {
  startSpan(name: SpanName, options?: SpanOptions): Span;
}

// ============================================================================
// Metrics (§9.2)
// ============================================================================

/**
 * The complete required metric set (§9.2).
 *
 * All thirteen are emitted in v0.2; several are structurally present with
 * placeholder values because the behaviour behind them ships in Epic #3. That
 * is deliberate — an operator building a dashboard now should not have to
 * rebuild it when bulkheads land.
 */
export const METRIC = {
  requestsTotal: 'mcp_requests_total',
  requestDurationSeconds: 'mcp_request_duration_seconds',
  toolCallsTotal: 'mcp_tool_calls_total',
  toolDurationSeconds: 'mcp_tool_duration_seconds',
  toolErrorsTotal: 'mcp_tool_errors_total',
  toolInflight: 'mcp_tool_inflight',
  toolQueueDepth: 'mcp_tool_queue_depth',
  policyDecisionsTotal: 'mcp_policy_decisions_total',
  upstreamDurationSeconds: 'mcp_upstream_duration_seconds',
  circuitBreakerState: 'mcp_circuit_breaker_state',
  outputBytes: 'mcp_output_bytes',
  registryReloadTotal: 'mcp_registry_reload_total',
  registryOperations: 'mcp_registry_operations',
} as const;

export type MetricName = (typeof METRIC)[keyof typeof METRIC];

export type MetricKind = 'counter' | 'histogram' | 'gauge';

export type MetricLabels = Readonly<Record<string, string>>;

/**
 * Declared shape of every metric: its kind and its permitted label keys.
 *
 * Having this as DATA rather than as scattered call sites is what lets the
 * cardinality guard enumerate label sets without executing a request.
 */
export interface MetricDefinition {
  readonly name: MetricName;
  readonly kind: MetricKind;
  readonly labels: readonly string[];
  readonly description: string;
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    name: METRIC.requestsTotal,
    kind: 'counter',
    labels: ['method', 'outcome'],
    description: 'MCP requests by method and outcome.',
  },
  {
    name: METRIC.requestDurationSeconds,
    kind: 'histogram',
    labels: ['method', 'outcome'],
    description: 'End-to-end MCP request duration.',
  },
  {
    name: METRIC.toolCallsTotal,
    kind: 'counter',
    labels: ['tool', 'outcome'],
    description: 'Tool invocations by tool and outcome.',
  },
  {
    name: METRIC.toolDurationSeconds,
    kind: 'histogram',
    labels: ['tool', 'outcome'],
    description: 'Tool invocation duration.',
  },
  {
    name: METRIC.toolErrorsTotal,
    kind: 'counter',
    labels: ['tool', 'error_code'],
    description: 'Tool errors broken down by error code.',
  },
  {
    name: METRIC.toolInflight,
    kind: 'gauge',
    labels: ['tool'],
    description: 'Tool invocations currently in flight.',
  },
  {
    name: METRIC.toolQueueDepth,
    kind: 'gauge',
    labels: ['bulkhead'],
    description:
      'Queue depth per bulkhead. v0.2 emits a single "default" bulkhead; Epic #3 populates real ones.',
  },
  {
    name: METRIC.policyDecisionsTotal,
    kind: 'counter',
    labels: ['phase', 'decision'],
    description: 'Policy decisions by phase and decision.',
  },
  {
    name: METRIC.upstreamDurationSeconds,
    kind: 'histogram',
    labels: ['executor_type', 'outcome'],
    description: 'Upstream call duration by executor type.',
  },
  {
    name: METRIC.circuitBreakerState,
    kind: 'gauge',
    labels: ['breaker'],
    description:
      'Circuit breaker state. v0.2 emits a placeholder "default" breaker; Epic #3 populates real ones.',
  },
  {
    name: METRIC.outputBytes,
    kind: 'histogram',
    labels: ['tool'],
    description: 'Serialized output size per tool.',
  },
  {
    name: METRIC.registryReloadTotal,
    kind: 'counter',
    labels: ['outcome', 'error_class'],
    description:
      'Registry reloads by outcome. `error_class` splits a benign superseded reload from a real failure (#37 QA note).',
  },
  {
    name: METRIC.registryOperations,
    kind: 'gauge',
    labels: ['registry_hash'],
    description: 'Operation count in the live registry, labelled by short registry hash.',
  },
];

/**
 * Where metric samples go. Injectable, with a no-op default.
 */
export interface MetricRecorder {
  add(name: MetricName, value: number, labels: MetricLabels): void;
  record(name: MetricName, value: number, labels: MetricLabels): void;
  set(name: MetricName, value: number, labels: MetricLabels): void;
}

/**
 * The observability surface an adopter supplies.
 */
export interface Observability {
  readonly tracer: Tracer;
  readonly metrics: MetricRecorder;
}
