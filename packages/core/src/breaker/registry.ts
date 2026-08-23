// SPDX-License-Identifier: Apache-2.0
/**
 * Breaker registry — assignment, metrics, and transition logs (§8.5).
 */

import { METRIC, type MetricRecorder } from '../telemetry/types.js';
import type { StructuredLogger } from '../logging/types.js';
import type { OperationDefinition, OperationErrorCode } from '../types.js';
import { Breaker, type BreakerTransition } from './breaker.js';
import {
  BREAKER_FAILURE_CODES,
  BREAKER_STATE_VALUE,
  DEFAULT_BREAKERS,
  type BreakerAdmission,
  type BreakerRegistry,
  type BreakerStats,
  type BreakersConfig,
} from './types.js';

/**
 * Which breaker an operation belongs to (§8.5 assignment rules, in order).
 *
 * 1. An explicit `annotations.breakerGroup`.
 * 2. Otherwise a configured breaker whose `baseUrl` prefixes the operation's
 *    effective base URL.
 * 3. Otherwise a configured breaker named after the executor type.
 * 4. Otherwise `default`.
 *
 * §8.5 writes rule 1 as `operation.breakerGroup`. No such field exists on
 * `OperationDefinition`, so this reads `annotations.breakerGroup` — following
 * the precedent #43 set with `annotations.bulkhead` rather than inventing a
 * second convention for the same kind of routing hint. Logged to #156.
 *
 * ## This function must never throw
 *
 * Same hazard #43 hit: `RegistrySnapshot` has no runtime validation, so a
 * hand-built snapshot can omit fields the types declare as required. An
 * assignment that threw would fall through to the dispatcher's internal-error
 * catch and turn every call into `INTERNAL_ERROR` — a routing decision taking
 * down the request it was routing. Every read below is defensive, and anything
 * unrecognised routes to `default`.
 */
export function assignBreaker(
  operation: OperationDefinition,
  config: BreakersConfig,
): string {
  const annotated = operation.annotations?.['breakerGroup'];
  if (typeof annotated === 'string' && annotated.length > 0) {
    return annotated in config ? annotated : 'default';
  }

  const baseUrl = effectiveBaseUrl(operation);
  if (baseUrl !== undefined) {
    // Longest configured prefix wins, so a breaker for
    // `https://api.example.com/orders` beats a broader one for
    // `https://api.example.com` instead of depending on object key order.
    let best: { name: string; length: number } | undefined;
    for (const [name, cfg] of Object.entries(config)) {
      const prefix = cfg.baseUrl;
      if (typeof prefix === 'string' && prefix.length > 0 && baseUrl.startsWith(prefix)) {
        if (best === undefined || prefix.length > best.length) {
          best = { name, length: prefix.length };
        }
      }
    }
    if (best !== undefined) return best.name;
  }

  const executorType = operation.executor?.type;
  if (typeof executorType === 'string' && executorType in config) return executorType;

  return 'default';
}

/**
 * The breaker group an operation explicitly asked for and did NOT get.
 *
 * `assignBreaker` treats an annotation naming a group that is absent from the
 * config exactly like no annotation at all: it returns `default`. That is the
 * right *routing* answer — see the never-throw note above — but it is a poor
 * silence. The operator wrote `breakerGroup: 'ordersApi'`, which is an explicit
 * request for isolation, and a typo or an un-wired config entry gives them
 * shared fate with every other operation instead, with nothing to notice.
 *
 * This is deliberately separate from assignment so the routing decision stays
 * total and side-effect-free; the registry uses it to warn once per group.
 */
export function unmatchedBreakerGroup(
  operation: OperationDefinition,
  config: BreakersConfig,
): string | undefined {
  const annotated = operation.annotations?.['breakerGroup'];
  if (typeof annotated === 'string' && annotated.length > 0 && !(annotated in config)) {
    return annotated;
  }
  return undefined;
}

function effectiveBaseUrl(operation: OperationDefinition): string | undefined {
  const config = operation.executor?.config;
  if (config === undefined || config === null) return undefined;
  const candidate = (config as Record<string, unknown>)['baseUrl'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

export interface BreakerRegistryOptions {
  readonly config?: BreakersConfig;

  /** Where breaker state goes. Absent means silent — telemetry is opt-in. */
  readonly metrics?: MetricRecorder;

  /** Where transitions are logged (§8.5 "log state transitions"). */
  readonly logger?: StructuredLogger;

  /** Injected clock, for deterministic tests. */
  readonly now?: () => number;
}

export function createBreakerRegistry(
  options: BreakerRegistryOptions = {},
): BreakerRegistry {
  const config = options.config ?? DEFAULT_BREAKERS;
  const metrics = options.metrics;
  const logger = options.logger;
  const now = options.now ?? Date.now;

  const publish = (name: string, state: keyof typeof BREAKER_STATE_VALUE): void => {
    metrics?.set(METRIC.circuitBreakerState, BREAKER_STATE_VALUE[state], { breaker: name });
  };

  const onTransition = (transition: BreakerTransition): void => {
    publish(transition.breaker, transition.to);

    // §8.5 asks for old state, new state, and the failure count that triggered
    // it. At WARN rather than INFO: a breaker changing state is an operational
    // event an on-call engineer wants to see without turning up log levels,
    // and unlike per-stage logs it happens once per outage, not once per call.
    logger?.warn('circuit breaker state change', {
      breaker: transition.breaker,
      from: transition.from,
      to: transition.to,
      failures: transition.failures,
    });
  };

  const breakers = new Map<string, Breaker>();
  for (const [name, cfg] of Object.entries(config)) {
    breakers.set(name, new Breaker(name, cfg, now, onTransition));
  }

  // Publish every configured breaker as closed immediately, for the same
  // reason #43 publishes queue depth at zero: #39 shipped
  // `mcp_circuit_breaker_state` as a placeholder emitting a single `default`
  // series, and a breaker that has simply never been exercised must still
  // appear on the dashboard. A blank panel reads as broken; a flat zero reads
  // as healthy, which is what it is.
  for (const name of breakers.keys()) publish(name, 'closed');

  const resolve = (name: string): Breaker =>
    // `default` is required by the type, so this is total.
    breakers.get(name) ?? (breakers.get('default') as Breaker);

  // Warn ONCE per distinct unconfigured group, not once per call. Assignment
  // runs on every dispatch, so warning unconditionally would put a line in the
  // log for every request to a mis-annotated operation — the kind of volume
  // that gets a logger turned down and takes the real signal with it. Same
  // reasoning as the transition log above: once per fault, not once per call.
  const warnedGroups = new Set<string>();

  return {
    assign: (operation) => {
      const unmatched = unmatchedBreakerGroup(operation, config);
      if (unmatched !== undefined && !warnedGroups.has(unmatched)) {
        warnedGroups.add(unmatched);
        logger?.warn('breaker group is not configured; falling back to the shared default breaker', {
          breakerGroup: unmatched,
          operation: operation.id,
          configured: Object.keys(config),
        });
      }
      return assignBreaker(operation, config);
    },

    tryAcquire: (name): BreakerAdmission => resolve(name).tryAcquire(),

    record: (name, errorCode): void => {
      const breaker = resolve(name);

      if (errorCode === undefined) {
        breaker.recordSuccess();
        return;
      }

      // A non-transient error is NOT evidence about the dependency's health.
      // §8.5 is explicit: 100 FORBIDDEN in a row must not open the breaker,
      // because opening it would neither fix the authorization problem nor
      // let anything through while it was open.
      if (BREAKER_FAILURE_CODES.includes(errorCode)) {
        breaker.recordFailure();
      }
    },

    stats: (): readonly BreakerStats[] => [...breakers.values()].map((b) => b.stats()),
  };
}

/** Does this error code count as upstream unhealth? Exported for testing. */
export function isBreakerFailure(code: OperationErrorCode): boolean {
  return BREAKER_FAILURE_CODES.includes(code);
}
