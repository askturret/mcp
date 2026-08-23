// SPDX-License-Identifier: Apache-2.0
/**
 * Graceful shutdown (§8.6).
 */

export {
  DEFAULT_DRAIN_MS,
  DEFAULT_TELEMETRY_FLUSH_MS,
  createShutdownCoordinator,
} from './shutdown.js';

export { DEFAULT_ESCALATE_WINDOW_MS, installSignalHandlers } from './signals.js';
export type { SignalHandlerOptions } from './signals.js';

export { SHUTDOWN_SEQUENCE } from './types.js';

export type {
  ShutdownHooks,
  ShutdownOptions,
  ShutdownPhase,
  ShutdownPhaseError,
  ShutdownResult,
} from './types.js';
