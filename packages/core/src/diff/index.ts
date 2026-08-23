// SPDX-License-Identifier: Apache-2.0
/**
 * Registry snapshot diff (§13).
 */

export { diffSnapshots } from './diff.js';

export {
  compareInputSchemas,
  compareOutputSchemas,
  schemasStructurallyEqual,
  type InputSchemaDelta,
  type OutputSchemaDelta,
  type SchemaFieldChange,
} from './schema-compare.js';

export {
  DEFAULT_CONFIRM_FOR,
  type Change,
  type ChangeCode,
  type ChangeSeverity,
  type DiffOptions,
  type DiffReport,
  type DiffSummary,
  type SnapshotRef,
} from './types.js';
