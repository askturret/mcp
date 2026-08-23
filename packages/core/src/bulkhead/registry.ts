// SPDX-License-Identifier: Apache-2.0
/**
 * Bulkhead registry — assignment, permits, and metrics (§8.2, §43).
 */

import { METRIC, type MetricRecorder } from '../telemetry/types.js';
import type { OperationDefinition } from '../types.js';
import { Bulkhead } from './semaphore.js';
import {
  BulkheadRejection,
  DEFAULT_BULKHEADS,
  REPORT_CLASSIFICATIONS,
  type BulkheadPermit,
  type BulkheadRegistry,
  type BulkheadStats,
  type BulkheadsConfig,
} from './types.js';

/**
 * Which bulkhead an operation belongs to (§43 assignment rules, in order).
 *
 * 1. An explicit `annotations.bulkhead`.
 * 2. Otherwise by effects: report-ish reads -> `reports`, other reads ->
 *    `reads`, mutations -> `writes`.
 * 3. Otherwise `default`.
 *
 * A name that is not configured falls back to `default` rather than throwing.
 * An operation is not worth failing over a typo'd group name — but it is worth
 * saying so, which is why `assign` is separated from acquisition and is
 * directly testable.
 */
export function assignBulkhead(
  operation: OperationDefinition,
  config: BulkheadsConfig,
): string {
  const annotated = operation.annotations?.['bulkhead'];
  if (typeof annotated === 'string' && annotated.length > 0) {
    return annotated in config ? annotated : 'default';
  }

  // Defensive reads, deliberately.
  //
  // `EffectMetadata.classifications` is typed as required, but `RegistrySnapshot`
  // is a plain interface with no runtime validation — a hand-built snapshot can
  // and does omit it. An earlier version destructured it and called `.some()`,
  // which threw for such an operation, fell through to the dispatcher's
  // internal-error catch, and turned every call into INTERNAL_ERROR. It was
  // caught by the transport's own fixtures, which build exactly that shape.
  //
  // Assignment must NEVER throw. Which queue an operation waits in is a
  // routing decision; failing a request over an absent optional field would be
  // wildly out of proportion, and it fails in a way that points at the wrong
  // layer. Anything unrecognised routes to `default`.
  const effects = operation.effects as Partial<OperationDefinition['effects']> | undefined;

  if (effects?.readOnly === true) {
    const classifications = Array.isArray(effects.classifications) ? effects.classifications : [];
    const isReport = classifications.some((c) => REPORT_CLASSIFICATIONS.includes(c));
    const candidate = isReport ? 'reports' : 'reads';
    return candidate in config ? candidate : 'default';
  }

  // Not known to be read-only — including the case where `effects` is missing
  // entirely. Routed to `writes`, the more conservative group: over-restricting
  // a read costs throughput, while under-restricting a mutation is what §8.2
  // exists to prevent.
  return 'writes' in config ? 'writes' : 'default';
}

export interface BulkheadRegistryOptions {
  readonly config?: BulkheadsConfig;

  /**
   * Where queue depth and rejection counts go.
   *
   * Optional, and absent means silent: core never emits telemetry an adopter
   * did not ask for.
   */
  readonly metrics?: MetricRecorder;
}

export function createBulkheadRegistry(
  options: BulkheadRegistryOptions = {},
): BulkheadRegistry {
  const config = options.config ?? DEFAULT_BULKHEADS;
  const metrics = options.metrics;

  const onDepthChange = (name: string, queued: number): void => {
    metrics?.set(METRIC.toolQueueDepth, queued, { bulkhead: name });
  };

  const bulkheads = new Map<string, Bulkhead>();
  for (const [name, cfg] of Object.entries(config)) {
    bulkheads.set(name, new Bulkhead(name, cfg, onDepthChange));
  }

  // Publish every configured bulkhead at zero immediately. #39 emits
  // `mcp_tool_queue_depth` as a placeholder so a dashboard can be built before
  // bulkheads exist; now that they do, a group that has simply not been hit
  // yet must still appear — otherwise its panel is blank rather than idle, and
  // blank reads as broken.
  for (const name of bulkheads.keys()) onDepthChange(name, 0);

  const resolve = (name: string): Bulkhead => {
    const bulkhead = bulkheads.get(name);
    if (bulkhead) return bulkhead;
    // `default` is required by the type, so this is total.
    return bulkheads.get('default') as Bulkhead;
  };

  return {
    assign: (operation) => assignBulkhead(operation, config),

    acquire: async (name, signal): Promise<BulkheadPermit> => {
      const bulkhead = resolve(name);
      try {
        return await bulkhead.acquire(signal);
      } catch (error) {
        if (error instanceof BulkheadRejection && error.code === 'QUEUE_FULL') {
          // Counted only for genuine overflow. A cancelled caller is not a
          // rejection by the bulkhead — folding the two together would make
          // the metric say "we are shedding load" during a burst of client
          // disconnects, which is the opposite diagnosis.
          metrics?.add(METRIC.bulkheadRejectedTotal, 1, { bulkhead: bulkhead.name });
        }
        throw error;
      }
    },

    stats: (): readonly BulkheadStats[] =>
      [...bulkheads.entries()].map(([name, bulkhead]) => ({
        name,
        inFlight: bulkhead.running,
        queued: bulkhead.queued,
        concurrency: config[name]?.concurrency ?? 0,
        queueSize: config[name]?.queueSize ?? 0,
      })),
  };
}
