// SPDX-License-Identifier: Apache-2.0
/**
 * Registry-hash divergence detection (#64, §11.2).
 */

export {
  createDivergenceMonitor,
  type DivergenceMonitor,
  type DivergenceMonitorOptions,
} from './monitor.js';
export { createMemoryPeerStore } from './memory-store.js';
export type {
  DivergenceState,
  DivergenceStatus,
  PeerEntry,
  RegistryPeerStore,
} from './types.js';
