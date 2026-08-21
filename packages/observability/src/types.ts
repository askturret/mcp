/**
 * Observability type definitions
 */

/**
 * OpenTelemetry configuration options
 */
export interface OpenTelemetryOptions {
  /**
   * Service name for telemetry
   */
  serviceName?: string;

  /**
   * Enable tracing
   */
  enableTracing?: boolean;

  /**
   * Enable metrics
   */
  enableMetrics?: boolean;
}
