// SPDX-License-Identifier: Apache-2.0
/**
 * `/mcp/health/ready` evaluation (§8.7).
 */

import type { BreakerStats } from '../breaker/types.js';
import type { HealthReport, NotReadyReason, ReadinessInputs } from './types.js';

const READY: HealthReport = { ready: true, httpStatus: 200 };

function notReady(reason: NotReadyReason, detail: string): HealthReport {
  return { ready: false, httpStatus: 503, reason, detail };
}

/**
 * Decide readiness from cached state alone.
 *
 * Pure and synchronous, which is the §8.7 requirement expressed as a type: no
 * dependency can be probed from here because nothing awaitable is in scope.
 *
 * Order matters. Shutdown is checked FIRST so that a draining instance
 * reports `shutting-down` rather than whichever dependency happens to look
 * unhealthy while it drains — an operator reading "audit-sink-unreachable" on
 * an instance that is simply being replaced would go and investigate the
 * wrong thing.
 */
export function evaluateReadiness(inputs: ReadinessInputs): HealthReport {
  if (inputs.shuttingDown) {
    return notReady('shutting-down', 'Instance is draining and no longer accepts new calls');
  }

  if (!inputs.hasRegistrySnapshot) {
    return notReady('no-registry-snapshot', 'No valid registry snapshot is published');
  }

  // A degraded reload means the snapshot serving traffic is not the one
  // configuration asks for. The instance can still answer calls, which is
  // exactly why §8.7 wants it OUT of rotation rather than restarted: liveness
  // stays 200 so the orchestrator does not kill it, and readiness goes 503 so
  // it stops receiving traffic until it recovers or is rolled back.
  if (inputs.reload !== undefined && !inputs.reload.ready) {
    return notReady(
      'reload-degraded',
      inputs.reload.detail ?? `Registry reload is degraded (${inputs.reload.errorClass ?? 'unknown'})`,
    );
  }

  // §11.2's last-line safety net. Checked BEFORE the dependency block because
  // it is not a dependency condition: divergence means this instance's tool
  // surface disagrees with its peers', which is a correctness problem rather
  // than a degraded upstream, and it is true whether or not
  // `enforceDependencies` is set — an operator who wired Option B has already
  // opted in by wiring it.
  //
  // `unknown` is NOT treated as diverged. A peer store outage would otherwise
  // pull every instance from rotation because the MONITOR's dependency failed,
  // which is precisely the outage-amplification §8.7 forbids.
  if (inputs.divergence?.status === 'diverged') {
    return notReady(
      'registry-divergence',
      inputs.divergence.detail ??
        'This instance is serving a different registry hash from its peers',
    );
  }

  if (inputs.enforceDependencies === true) {
    if (inputs.auditSinkReachable === false) {
      return notReady(
        'audit-sink-unreachable',
        'Audit sink was unreachable at its last check',
      );
    }

    if (allBreakersOpen(inputs.breakers)) {
      return notReady(
        'all-breakers-open',
        'Every configured circuit breaker is open; no upstream is reachable',
      );
    }
  }

  return READY;
}

/**
 * Are ALL configured breakers open?
 *
 * ## The empty case is `false`, and that is not a detail
 *
 * `[].every(...)` is `true` in JavaScript, so the obvious one-liner reports
 * "all breakers are open" for an instance with NO breakers configured — which
 * since #46 is the DEFAULT, breakers being opt-in. Under the production
 * preset that would take every such instance out of rotation permanently, on
 * the strength of a vacuous truth.
 *
 * "No breakers" means nothing is known to be unreachable. That is ready.
 */
function allBreakersOpen(breakers: readonly BreakerStats[] | undefined): boolean {
  if (breakers === undefined || breakers.length === 0) return false;
  return breakers.every((breaker) => breaker.state === 'open');
}
