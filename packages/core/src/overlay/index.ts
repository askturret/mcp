// SPDX-License-Identifier: Apache-2.0
/**
 * MCP overlays and provenance (§5.3, ADR-019, #55).
 */

export {
  OVERLAY_VERSION,
  OverlayValidationError,
  PROVENANCE_PRECEDENCE,
  outranks,
  provenanceRank,
  type OverlayConflict,
  type OverlayDocument,
  type OverlayOperationPatch,
  type ProvenanceKind,
  type ProvenanceMap,
  type ProvenanceSource,
  type ProvenancedOperation,
  type SourcedValue,
} from './types.js';

export {
  loadOverlay,
  parseOverlay,
  validateOverlayDocument,
  type LoadOverlayResult,
  type OverlayMode,
} from './load.js';

export {
  applyOverlaysToOperation,
  jsonMergePatch,
  resolveField,
  unmatchedOverlayIds,
  type ApplyOverlaysResult,
  type FieldState,
  type OverlayTarget,
  type ResolveOptions,
} from './merge.js';

export { parseYamlSubset, YamlParseError } from './yaml.js';
