// SPDX-License-Identifier: Apache-2.0
/**
 * Retry rules with semantic idempotency (§8.4, §5.8, ADR-012).
 */

export {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_DELAY_MS,
  NEVER_RETRY_CODES,
  TRANSIENT_CODES,
  computeBackoffMs,
  decideRetry,
  isRetryEligible,
  resolveRetryConfig,
} from './policy.js';

export { defaultSleep } from './sleep.js';

export type {
  OperationRetryOverride,
  ResolvedRetryConfig,
  RetryConfig,
  RetryDecision,
  RetryReason,
} from './types.js';
