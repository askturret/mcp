// SPDX-License-Identifier: Apache-2.0
/**
 * `/mcp/health/live` evaluation (§8.7).
 */

import type { HealthReport } from './types.js';

/** §8.7's "short budget" for the event loop to respond. */
export const DEFAULT_LIVENESS_BUDGET_MS = 200;

/**
 * Is the process responsive?
 *
 * Deliberately does NOT probe upstreams, read the registry, or consult a
 * breaker. §8.7 draws the line precisely: liveness answers "should this
 * process be restarted?", readiness answers "should it receive traffic?".
 *
 * Conflating them is the expensive mistake. A liveness check that failed on a
 * dependency outage would have the orchestrator kill and reschedule every
 * healthy instance during someone else's incident — turning a partial outage
 * into a restart storm on top of it.
 *
 * The probe itself is a scheduling round-trip: `setImmediate` runs after the
 * current poll phase, so it cannot resolve while the event loop is blocked by
 * synchronous work. A loop that is stuck therefore misses the budget, which
 * is the one condition §8.7 says should return 503.
 */
export async function evaluateLiveness(
  budgetMs: number = DEFAULT_LIVENESS_BUDGET_MS,
): Promise<HealthReport> {
  const respondedWithin = await eventLoopResponds(budgetMs);

  if (respondedWithin) return { ready: true, httpStatus: 200 };

  return {
    ready: false,
    httpStatus: 503,
    detail: `Event loop did not respond within ${budgetMs}ms`,
  };
}

function eventLoopResponds(budgetMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, budgetMs);

    setImmediate(() => {
      if (settled) return;
      settled = true;
      // Clear before resolving so a fast probe leaves no pending timer. On a
      // busy server this runs on every health check, and a leaked timer per
      // probe is a slow leak that only shows up under sustained load.
      clearTimeout(timer);
      resolve(true);
    });
  });
}
