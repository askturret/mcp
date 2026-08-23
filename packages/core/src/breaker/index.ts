// SPDX-License-Identifier: Apache-2.0
/**
 * Circuit breakers scoped per upstream/executor group (§8.5).
 */

export { Breaker, type BreakerTransition } from './breaker.js';
export { assignBreaker, createBreakerRegistry, isBreakerFailure } from './registry.js';
export type { BreakerRegistryOptions } from './registry.js';

export {
  BREAKER_FAILURE_CODES,
  BREAKER_STATE_VALUE,
  DEFAULT_BREAKERS,
} from './types.js';

export type {
  BreakerAdmission,
  BreakerConfig,
  BreakerRegistry,
  BreakerState,
  BreakerStats,
  BreakersConfig,
} from './types.js';
