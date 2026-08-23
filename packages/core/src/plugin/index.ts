// SPDX-License-Identifier: Apache-2.0
/**
 * The stable plugin API (§6, ADR-018, #53).
 *
 * ```ts
 * import { loadPlugins, PLUGIN_API_VERSION, type AskTurretPlugin } from '@askturret/mcp';
 *
 * const metricsPlugin: AskTurretPlugin<'observability'> = {
 *   manifest: {
 *     name: 'acme-otel',
 *     version: '1.0.0',
 *     apiVersion: PLUGIN_API_VERSION,
 *     capabilities: ['observability'],
 *   },
 *   async setup(context) {
 *     context.registerObservabilityExporter({ id: 'acme', observability });
 *   },
 * };
 *
 * const registrations = await loadPlugins([metricsPlugin]);
 * ```
 */

export {
  applyPluginRedactionRules,
  constrainPluginRedactionRule,
  createPluginContext,
  isPluginApiCompatible,
  loadPlugins,
  parseSemVer,
  PluginRefusedError,
  type LoadPluginsOptions,
} from './host.js';

export {
  PLUGIN_API_VERSION,
  PLUGIN_CAPABILITIES,
  type AskTurretPlugin,
  type CapabilityMethodMap,
  type ObservabilityExporter,
  type PluginCapability,
  type PluginContext,
  type PluginManifest,
  type PluginRegistration,
  type PluginRegistrations,
  type ScopedPluginContext,
  type UnionToIntersection,
} from './types.js';
