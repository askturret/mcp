// SPDX-License-Identifier: Apache-2.0
/**
 * AskTurret MCP - Observability Adapters
 *
 * OpenTelemetry integration for the span tree and metric set defined by
 * `@askturret/mcp-core`'s telemetry ports (#39, §9.1 / §9.2).
 *
 * The v0.1 `openTelemetry()` stub threw "Not yet implemented"; it now returns
 * a real `Observability`. Called with no config it returns an INERT one
 * rather than throwing, because § Delivery makes no-exporter the default and
 * a default that throws is not a default.
 */

export {
  openTelemetry,
  type OpenTelemetryConfig,
  type OtelInstrumentLike,
  type OtelMeterLike,
  type OtelSpanLike,
  type OtelTracerLike,
} from './otel.js';

export * from './types.js';
