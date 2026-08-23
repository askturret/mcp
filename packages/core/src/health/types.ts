// SPDX-License-Identifier: Apache-2.0
/**
 * Health semantics (§8.7).
 *
 * These endpoints are the load balancer's contract. Getting the live/ready
 * distinction wrong routes traffic to a broken instance — or, just as badly,
 * restarts a healthy one because a dependency blipped.
 */

import type { BreakerStats } from '../breaker/types.js';
import type { ReadinessState } from '../reload/types.js';

/**
 * Why the instance is not ready.
 *
 * A closed set, and deliberately low-cardinality: §8.7 says the health
 * endpoints emit their own metrics, and a free-text reason would put one time
 * series per distinct message on a dashboard.
 */
export type NotReadyReason =
  | 'shutting-down'
  | 'no-registry-snapshot'
  | 'reload-degraded'
  | 'audit-sink-unreachable'
  | 'all-breakers-open';

export interface HealthReport {
  readonly ready: boolean;
  readonly httpStatus: 200 | 503;
  /** Absent when ready. */
  readonly reason?: NotReadyReason;
  /** Human-readable elaboration; never a stack or a credential. */
  readonly detail?: string;
}

/**
 * Everything readiness is allowed to look at.
 *
 * ALL of it is CACHED state, held by the caller. §8.7 is explicit that
 * readiness "must not synchronously fan out to every dependency; that would
 * amplify outages" — a readiness probe that pinged each upstream would turn a
 * load balancer's health check into a load generator aimed at a service that
 * is already struggling.
 *
 * Making the inputs a plain data structure is what enforces that: there is no
 * client, no socket and no await reachable from here, so a future edit cannot
 * quietly introduce a fan-out without changing this signature first.
 */
export interface ReadinessInputs {
  /** True from the instant shutdown begins (§8.6 phase 1). */
  readonly shuttingDown: boolean;

  /** Whether a valid registry snapshot is published and serving. */
  readonly hasRegistrySnapshot: boolean;

  /** Last known reload readiness, if a reload controller is wired. */
  readonly reload?: ReadinessState;

  /**
   * Cached breaker state (#46). Empty when breakers are disabled.
   */
  readonly breakers?: readonly BreakerStats[];

  /**
   * Result of the audit sink's LAST reachability check — never a fresh probe.
   */
  readonly auditSinkReachable?: boolean;

  /**
   * Whether dependency conditions are enforced (§8.7 "production preset").
   *
   * Off by default. Outside the production preset an unreachable audit sink
   * or a fully-open breaker set is a degraded instance, not one that should
   * be pulled from rotation — and pulling every instance for a shared
   * dependency blip takes the whole service down instead of the dependency.
   */
  readonly enforceDependencies?: boolean;
}
