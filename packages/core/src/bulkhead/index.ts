// SPDX-License-Identifier: Apache-2.0
/**
 * Bulkheads with bounded queues (§8.2, ADR-013, #43).
 */

export { Bulkhead } from './semaphore.js';
export { assignBulkhead, createBulkheadRegistry, type BulkheadRegistryOptions } from './registry.js';
export {
  BulkheadRejection,
  DEFAULT_BULKHEADS,
  REPORT_CLASSIFICATIONS,
  type BulkheadConfig,
  type BulkheadPermit,
  type BulkheadRegistry,
  type BulkheadStats,
  type BulkheadsConfig,
} from './types.js';
