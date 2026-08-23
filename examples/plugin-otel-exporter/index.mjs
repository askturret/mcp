// SPDX-License-Identifier: Apache-2.0
/**
 * Running the reference plugin (§53, #53).
 *
 * The plugin itself lives in `@askturret/mcp-observability` and is covered by
 * its tests. This file shows the part an ADOPTER writes: loading it, seeing
 * what it registered, and watching the capability gate refuse a plugin that
 * asks for more than it declared.
 *
 *   node examples/plugin-otel-exporter/index.mjs
 */

import { loadPlugins, PLUGIN_API_VERSION } from '@askturret/mcp-core';
import { otelExporterPlugin } from '@askturret/mcp-observability';

// A stand-in for a real OTel meter/tracer. In a deployment these come from the
// OpenTelemetry SDK; the plugin does not care which, which is the point of the
// exporter seam.
const spans = [];
const measurements = [];

const tracer = {
  startSpan(name) {
    spans.push(name);
    return {
      setAttribute() {},
      setStatus() {},
      recordException() {},
      end() {},
    };
  },
};

const meter = {
  createCounter: (name) => ({ add: (value) => measurements.push([name, value]) }),
  createHistogram: (name) => ({ record: (value) => measurements.push([name, value]) }),
  createUpDownCounter: (name) => ({ add: (value) => measurements.push([name, value]) }),
};

// ---------------------------------------------------------------------------
// 1. Load the plugin
// ---------------------------------------------------------------------------

const registrations = await loadPlugins([
  otelExporterPlugin({ id: 'demo-backend', tracer, meter }),
]);

console.log(`runtime plugin API: ${PLUGIN_API_VERSION}`);
console.log(
  'registered exporters:',
  registrations.observabilityExporters.map((e) => `${e.value.id} (from ${e.plugin})`),
);

// Nothing else was registered — the manifest declared one capability.
console.log('sources:', registrations.sources.length);
console.log('executors:', registrations.executors.length);
console.log('policies:', registrations.policies.length);
console.log('redaction rules:', registrations.redactionRules.length);

// ---------------------------------------------------------------------------
// 2. Use what it contributed
// ---------------------------------------------------------------------------

const [exporter] = registrations.observabilityExporters;
exporter.value.observability.tracer.startSpan('mcp.tool.call').end();

console.log('spans seen by the backend:', spans);

// ---------------------------------------------------------------------------
// 3. Watch the capability gate refuse an over-reaching plugin
// ---------------------------------------------------------------------------

const overreaching = {
  manifest: {
    name: 'overreaching-plugin',
    version: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    // Declares observability only…
    capabilities: ['observability'],
  },
  async setup(context) {
    // …then tries to register an executor. Refused, by name, at setup.
    context.registerExecutor('sneaky', { execute: async () => ({ ok: true, value: {} }) });
  },
};

try {
  await loadPlugins([overreaching]);
  console.error('UNEXPECTED: the over-reaching plugin was allowed');
  process.exitCode = 1;
} catch (error) {
  console.log('\nrefused, as intended:');
  console.log(`  ${error.message}`);
}
