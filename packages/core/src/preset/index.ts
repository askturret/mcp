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

export {
  regulatedPending,
  regulatedPreset,
  RegulatedPresetRefusal,
  REGULATED_BOUNDS,
  REGULATED_EVIDENCE_KIND,
} from './regulated.js';

export type {
  AuditDurability,
  AuditSinkDurabilityClaim,
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
  PresetRedactionConfig,
  PresetTransportConfig,
  ProductionPresetOptions,
  ReadDiscoveryMode,
  RedactionMode,
  RegulatedAuditSinkDescriptor,
  RegulatedPresetOptions,
  ReloadMode,
  SessionMode,
  WriteDiscoveryMode,
} from './types.js';
