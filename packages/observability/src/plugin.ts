// SPDX-License-Identifier: Apache-2.0
/**
 * The reference plugin — a custom OpenTelemetry exporter (§53 acceptance).
 *
 * §53 asks for "a reference example plugin (a simple custom OpenTelemetry
 * exporter) [that] demonstrates the full lifecycle". This is it, and it lives
 * in a real package rather than in `examples/` on purpose: an example that
 * nothing builds or tests is an example that stops compiling three refactors
 * later, and a *reference* implementation which has rotted is worse than none —
 * a plugin author copies it and inherits the rot.
 *
 * `examples/plugin-otel-exporter/` demonstrates RUNNING it. This file is the
 * plugin, and its tests are what keep it true.
 *
 * ## What it demonstrates, end to end
 *
 * 1. A manifest declaring `apiVersion` — OUR API version, from
 *    `PLUGIN_API_VERSION`, not the plugin's own `version`. Getting these two
 *    confused is the mistake this whole reference exists to pre-empt.
 * 2. Exactly ONE capability. The plugin exports telemetry, so it declares
 *    `'observability'` and nothing else. A reviewer reading the manifest knows
 *    at a glance it cannot touch policy, executors or redaction.
 * 3. `setup` using only the method that capability authorises. Calling any
 *    other would be refused at setup, and the narrowed context makes it a
 *    compile error first.
 */

import {
  PLUGIN_API_VERSION,
  type AskTurretPlugin,
  type ObservabilityExporter,
} from '@askturret/mcp-core';

import { openTelemetry, type OpenTelemetryConfig } from './otel.js';

export interface OtelExporterPluginOptions extends OpenTelemetryConfig {
  /**
   * Exporter id, surfaced in diagnostics.
   *
   * Defaults to the plugin name. Overridable because a deployment may load two
   * exporters — one per backend — and two anonymous ones are indistinguishable
   * when one starts dropping spans.
   */
  readonly id?: string;
  /** Plugin name, for manifests and attribution. */
  readonly name?: string;
}

/** The plugin's own version — deliberately NOT the API version. */
export const OTEL_EXPORTER_PLUGIN_VERSION = '1.0.0';

/**
 * Build a plugin that contributes an OpenTelemetry exporter.
 *
 * Called with no tracer or meter it contributes an INERT observability, exactly
 * as `openTelemetry()` does — § Delivery makes no-exporter the default, and a
 * reference plugin that threw when unconfigured would teach the wrong shape.
 */
export function otelExporterPlugin(
  options: OtelExporterPluginOptions = {},
): AskTurretPlugin<'observability'> {
  const name = options.name ?? 'askturret-otel-exporter';
  const id = options.id ?? name;

  return {
    manifest: {
      name,
      // The PLUGIN's version — what the author releases.
      version: OTEL_EXPORTER_PLUGIN_VERSION,
      // The API version it was built against — what the runtime gates on.
      // Sourced from the constant rather than hardcoded, so this reference
      // cannot drift out of range from the runtime it ships beside.
      apiVersion: PLUGIN_API_VERSION,
      // One capability. Everything else stays refused.
      capabilities: ['observability'],
    },

    async setup(context) {
      const exporter: ObservabilityExporter = {
        id,
        observability: openTelemetry(options),
      };

      context.registerObservabilityExporter(exporter);
    },
  };
}
