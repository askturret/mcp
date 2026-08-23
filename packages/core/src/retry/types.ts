// SPDX-License-Identifier: Apache-2.0
/**
 * Retry configuration types (§8.4, ADR-012).
 */

/**
 * Per-operation overrides for the retry budget.
 *
 * §45 says max attempts is "configurable per operation or per policy". There is
 * no retry field on `OperationDefinition`, and the registry snapshot is frozen
 * and hashed — adding one would change every adopter's registry hash for a
 * knob that is deployment-shaped rather than contract-shaped. So per-operation
 * configuration is keyed by operation id HERE, in the policy, which gets the
 * same effect without touching the compiled contract. Flagged for QA.
 */
export interface OperationRetryOverride {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

/**
 * Retry policy (§8.4).
 *
 * Absent from `DispatcherOptions` means retries are DISABLED, not
 * "enabled with defaults". Auto-retry replays a call against someone's
 * upstream; turning that on is an explicit act, and every dispatcher built
 * before this existed must keep behaving exactly as it did.
 */
export interface RetryConfig {
  /**
   * Total attempts including the first (§8.4 "Max attempts default: 3").
   *
   * 3 attempts = 1 initial + 2 retries. A value of 1 disables retrying while
   * leaving the policy attached, which is the honest way to express
   * "configured, but off for now".
   */
  readonly maxAttempts?: number;

  /** First backoff step in ms; doubles per attempt. */
  readonly baseDelayMs?: number;

  /** Ceiling for a single backoff step, before jitter. */
  readonly maxDelayMs?: number;

  /** Per-operation overrides, keyed by operation id. */
  readonly perOperation?: Readonly<Record<string, OperationRetryOverride>>;

  /**
   * Jitter source, injected for deterministic tests. Defaults to `Math.random`.
   *
   * Returns a value in [0, 1).
   */
  readonly random?: () => number;

  /**
   * Sleep function, injected for deterministic tests. Defaults to `setTimeout`.
   *
   * Receives the already-computed delay so a test can assert on the exact
   * backoff the policy chose rather than measuring wall-clock time.
   */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** A retry policy with every default filled in. */
export interface ResolvedRetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * Why the runtime did or did not retry.
 *
 * A closed set rather than free text: these are the strings that end up in
 * debug logs explaining a retry decision, and one spelled two ways in two
 * branches is how a log-based investigation stalls.
 */
export type RetryReason =
  | 'eligible'
  | 'outcome-unknown'
  | 'not-transient'
  | 'effects-forbid-retry'
  | 'attempts-exhausted';

export interface RetryDecision {
  readonly retry: boolean;
  readonly reason: RetryReason;
}
