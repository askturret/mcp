// SPDX-License-Identifier: Apache-2.0
/**
 * Central redaction pipeline (§9.4, ADR-016).
 *
 * The single point of truth for what leaves the process.
 */

export {
  DEFAULT_MAX_DEPTH,
  TRUNCATED,
  createRedactionPipeline,
  noopRedactionPipeline,
  redactFor,
} from './pipeline.js';
export type { RedactionPipelineOptions } from './pipeline.js';

export {
  AUDIT_STRUCTURAL_FIELDS,
  BUILTIN_RULES,
  SENSITIVE_KEY_NAMES,
  // Exported so the truncation-length guard asserts against the PRODUCTION
  // regex rather than a copy (#383 item 4). A re-declared copy would be a
  // Transcribed Oracle: it would agree with itself after the real one drifted.
  SNAPSHOT_HASH,
  bearerRule,
  creditCardRule,
  highEntropyRule,
  jwtRule,
  keyNameRule,
  passesLuhn,
  pemRule,
} from './rules.js';

export {
  defaultRedactionPipeline,
  redactValue,
  resetDefaultRedactionPipeline,
  setDefaultRedactionPipeline,
} from './default.js';

export {
  redactAuditEvent,
  redactExplorerModel,
  redactLogFields,
  redactMetricLabels,
  redactSerializedError,
  redactSpanAttributes,
  redactingMetricRecorder,
} from './surfaces.js';

export { REDACTION_SURFACES } from './types.js';

export type {
  RedactionContext,
  RedactionPipeline,
  RedactionRule,
  RedactionSurface,
} from './types.js';
