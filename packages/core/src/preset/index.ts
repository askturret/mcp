// SPDX-License-Identifier: Apache-2.0
/**
 * Named preset configurations.
 *
 * ADR-007: a preset expands to ordinary configuration and can be inspected.
 * `describePreset` is what makes that claim checkable rather than asserted.
 */

export {
  describePreset,
  presetTransportBounds,
  productionPreset,
  PRODUCTION_BOUNDS,
  PRODUCTION_CONFIRM_FOR,
} from './production.js';

export type {
  OutputValidationMode,
  PendingControl,
  PresetAuditConfig,
  PresetAuthenticationConfig,
  PresetAuthorizationConfig,
  PresetAuthorizationSummary,
  PresetBounds,
  PresetConfiguration,
  PresetConfigurationSummary,
  PresetDescription,
  PresetDiscoveryConfig,
  PresetTransportConfig,
  ProductionPresetOptions,
  ReadDiscoveryMode,
  RedactionMode,
  ReloadMode,
  SessionMode,
  WriteDiscoveryMode,
} from './types.js';
