// SPDX-License-Identifier: Apache-2.0
/**
 * Atomic reload with in-flight snapshot retention (#37, §7.4, ADR-004).
 */

export {
  createReloadController,
  ReloadFailedError,
  shortHash,
} from './controller.js';

export { createReloadWatcher } from './watcher.js';

export {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RETAIN_COUNT,
  type ReadinessState,
  type ReloadController,
  type ReloadControllerOptions,
  type ReloadErrorClass,
  type ReloadMetrics,
  type ReloadOutcome,
  type ReloadRejected,
  type ReloadResult,
  type ReloadSuccess,
  type RollbackResult,
  type SnapshotValidator,
  type SnapshotViolation,
} from './types.js';

export type {
  ReloadWatcher,
  ReloadWatcherOptions,
  WatchFactory,
  WatchHandle,
} from './watcher.js';
