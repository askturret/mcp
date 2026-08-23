// SPDX-License-Identifier: Apache-2.0
/**
 * The reference OTel exporter plugin (§53 acceptance).
 *
 * §53 asks the reference plugin to demonstrate "the full lifecycle". These
 * tests ARE that demonstration, driven rather than described: manifest → load →
 * capability check → setup → registration → an exporter that actually records.
 *
 * Kept in a real package with real tests for a specific reason. A reference
 * implementation that has silently stopped compiling is worse than none at
 * all — a plugin author copies it and inherits the rot, then debugs our
 * example instead of their plugin.
 */

import { describe, it, expect } from '@jest/globals';
import { loadPlugins, PLUGIN_API_VERSION, PluginRefusedError } from '@askturret/mcp-core';

import { otelExporterPlugin, OTEL_EXPORTER_PLUGIN_VERSION } from '../plugin.js';

describe('the reference OTel exporter plugin', () => {
  it('declares the API version it was built against, not its own version', () => {
    const { manifest } = otelExporterPlugin();

    // The mistake this reference exists to pre-empt. These are two different
    // numbers answering two different questions, and a plugin that put its own
    // version in `apiVersion` would be gated on the wrong one.
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(manifest.version).toBe(OTEL_EXPORTER_PLUGIN_VERSION);
  });

  it('declares exactly one capability, so its blast radius reads at a glance', () => {
    expect(otelExporterPlugin().manifest.capabilities).toEqual(['observability']);
  });

  it('loads and registers its exporter — the full lifecycle', async () => {
    const registrations = await loadPlugins([otelExporterPlugin()]);

    expect(registrations.observabilityExporters).toHaveLength(1);
    const registered = registrations.observabilityExporters[0];
    expect(registered?.plugin).toBe('askturret-otel-exporter');
    expect(registered?.value.id).toBe('askturret-otel-exporter');

    // It registered ONLY an exporter. A reference plugin that quietly
    // contributed something else would teach exactly the wrong habit.
    expect(registrations.sources).toHaveLength(0);
    expect(registrations.executors).toHaveLength(0);
    expect(registrations.policies).toHaveLength(0);
    expect(registrations.compilerPasses).toHaveLength(0);
    expect(registrations.redactionRules).toHaveLength(0);
  });

  it('contributes a usable Observability, not merely a well-formed object', async () => {
    const recorded: { name: string; value: number }[] = [];
    const spans: string[] = [];

    const registrations = await loadPlugins([
      otelExporterPlugin({
        id: 'acme-backend',
        tracer: {
          startSpan: (name: string) => {
            spans.push(name);
            return {
              setAttribute: () => {},
              setStatus: () => {},
              recordException: () => {},
              end: () => {},
            };
          },
        } as never,
        meter: {
          createCounter: (name: string) => ({
            add: (value: number) => recorded.push({ name, value }),
          }),
          createHistogram: (name: string) => ({
            record: (value: number) => recorded.push({ name, value }),
          }),
          createUpDownCounter: (name: string) => ({
            add: (value: number) => recorded.push({ name, value }),
          }),
        } as never,
      }),
    ]);

    const exporter = registrations.observabilityExporters[0]?.value;
    expect(exporter?.id).toBe('acme-backend');

    // Drive it. Asserting the object came back would prove the plugin returned
    // something; this proves what it returned reaches the backend.
    exporter?.observability.tracer.startSpan('mcp.tool.call' as never);
    expect(spans).toContain('mcp.tool.call');
  });

  it('is inert when unconfigured rather than throwing', async () => {
    // § Delivery makes no-exporter the default, so a reference plugin that
    // threw when unconfigured would teach the wrong shape to every author who
    // copied it.
    const registrations = await loadPlugins([otelExporterPlugin()]);
    const exporter = registrations.observabilityExporters[0]?.value;

    expect(() => exporter?.observability.tracer.startSpan('mcp.tool.call' as never)).not.toThrow();
    expect(() =>
      exporter?.observability.metrics.add('mcp_tool_calls_total' as never, 1, {}),
    ).not.toThrow();
  });

  it('is refused by a runtime that speaks an older plugin API', async () => {
    // Demonstrates the gate from the plugin's side: the reference is built
    // against the current API, so a 0.x runtime must refuse it rather than run
    // it half-way.
    await expect(
      loadPlugins([otelExporterPlugin()], { runtimeApiVersion: '0.9.0' }),
    ).rejects.toThrow(PluginRefusedError);
  });

  it('names two exporters distinctly when a deployment loads both', async () => {
    const registrations = await loadPlugins([
      otelExporterPlugin({ name: 'otel-primary', id: 'primary' }),
      otelExporterPlugin({ name: 'otel-secondary', id: 'secondary' }),
    ]);

    // Two backends is an ordinary deployment. Anonymous exporters would be
    // indistinguishable the moment one started dropping spans.
    expect(registrations.observabilityExporters.map((e) => e.value.id)).toEqual([
      'primary',
      'secondary',
    ]);
    expect(registrations.observabilityExporters.map((e) => e.plugin)).toEqual([
      'otel-primary',
      'otel-secondary',
    ]);
  });
});
