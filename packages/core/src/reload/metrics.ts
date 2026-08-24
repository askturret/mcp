// SPDX-License-Identifier: Apache-2.0
/**
 * Bridge from the reload subsystem's `ReloadMetrics` port onto the §9.2
 * `MetricRecorder` (#39).
 *
 * ## Why this file exists
 *
 * `mcp_registry_reload_total` and `mcp_registry_operations` are two of the
 * thirteen metrics §9.2 requires. Both were DECLARED in `METRIC_DEFINITIONS`
 * — so `otelMetrics()` dutifully created an instrument for each — but nothing
 * ever emitted a sample to them, because the reload controller reports through
 * its own `ReloadMetrics` port (an adopter-wired interface with a no-op
 * default, predating #39) and nothing connected that port to the recorder.
 *
 * The result was two instruments that existed and never moved: eleven of the
 * thirteen metrics actually emitted. The declaration-count test could not see
 * it, because counting declarations is not counting emissions.
 *
 * This is deliberately a translation layer and nothing more. The controller
 * keeps reporting to a port it owns, core keeps one metric contract, and the
 * two are joined here rather than by giving the controller a second metrics
 * dependency.
 */

import { METRIC, type MetricRecorder } from '../telemetry/types.js';
import type { ReloadErrorClass, ReloadMetrics, ReloadOutcome } from './types.js';

/**
 * `error_class` value used when a reload succeeded and there is no error.
 *
 * The label is emitted ALWAYS rather than only on failure, so the series
 * carries a stable label set. A label that appears on some samples of a metric
 * and not others is a well-known way to make a query silently miss rows: in
 * Prometheus, `mcp_registry_reload_total{error_class="none"}` and a bare
 * `mcp_registry_reload_total` select different things, and which one an
 * operator reaches for first is a coin flip.
 *
 * `none` rather than an empty string because an empty label value is treated
 * as absent by some backends, which reintroduces exactly the problem.
 */
export const NO_ERROR_CLASS = 'none';

/**
 * Hex digits of the registry hash carried in `mcp_registry_hash_id`.
 *
 * 13, because 13 hex digits are 52 bits and float64 represents every integer
 * below 2^53 exactly. 14 would be 56 bits, where two distinct hashes can round
 * to the same double — diverging instances would then silently agree, which is
 * the one failure mode this metric must not have.
 *
 * The snapshot hash is itself a 16-hex-digit prefix of a SHA-256, so this is a
 * prefix of a prefix. It discriminates slightly BETTER than the 12-character
 * `registry_hash` label it replaces, not worse.
 */
export const REGISTRY_HASH_ID_HEX_DIGITS = 13;

/**
 * The registry hash as a number, for `mcp_registry_hash_id`.
 *
 * ## Why identity travels in the VALUE
 *
 * Divergence detection compares which registry each instance is serving, so
 * the identity has to reach Prometheus somehow. It cannot be a LABEL: every
 * reload mints a new value, so a hash label adds a permanent series per reload
 * — the #136 leak this PR exists to fix.
 *
 * Eviction does not rescue the label either. The OTel adapter models gauges as
 * UpDownCounters, and a series that has been zeroed still EXISTS and is still
 * counted by `count by (...)`. There is no way to make a stale hash stop
 * voting.
 *
 * A value has neither problem: one series per instance, whose value changes on
 * reload, and `count_values` reconstructs the grouping at query time — where
 * the cardinality is bounded by the hashes actually live rather than by every
 * hash ever served.
 *
 * Returns `undefined` when the hash has no usable hex prefix, so the caller
 * skips the sample rather than emitting 0 — which would read as a genuine
 * registry identity, shared by every instance that failed to parse, and
 * therefore as agreement.
 */
export function registryHashId(registryHash: string): number | undefined {
  const hex = /^[0-9a-fA-F]+/.exec(registryHash.replace(/^sha256:/i, ''))?.[0];
  if (hex === undefined) return undefined;

  return Number.parseInt(hex.slice(0, REGISTRY_HASH_ID_HEX_DIGITS), 16);
}

/**
 * Adapt a `MetricRecorder` into the `ReloadMetrics` port.
 *
 * Pass the result as `metrics` to `createReloadController`, or supply the
 * recorder as `metricRecorder` and let the controller do this itself.
 */
export function reloadMetricsFromRecorder(recorder: MetricRecorder): ReloadMetrics {
  return {
    recordReload: (outcome: ReloadOutcome, errorClass?: ReloadErrorClass): void => {
      recorder.add(METRIC.registryReloadTotal, 1, {
        outcome,
        error_class: errorClass ?? NO_ERROR_CLASS,
      });
    },

    // An absolute level, so `set` — the recorder is responsible for turning
    // that into whatever its backend needs (the OTel adapter converts it to a
    // delta against the last value for this series).
    //
    // Two unlabelled samples, and the split is the point.
    //
    // #136 removed the `registry_hash` label from the operation count: it was
    // truncated, which bounds a label's WIDTH and not the number of values it
    // can take, so every reload left a permanent new series behind.
    //
    // Removing it also broke `McpRegistryHashDivergence`, because the alert's
    // recording rule counted DISTINCT values of exactly that label — with the
    // label gone it counted one group forever and could never fire again
    // (#136 QA). The identity is therefore re-emitted here, as a VALUE on its
    // own series rather than as a label on this one.
    //
    // Both metrics stay at one series per instance. The counts move, the label
    // set never does.
    recordActiveRegistry: (registryHash: string, operationCount: number): void => {
      recorder.set(METRIC.registryOperations, operationCount, {});

      // Skipped rather than zeroed when unparseable: 0 is a legal identity, so
      // emitting it would make every instance that failed to parse look like
      // it agreed with every other one — divergence reported as consensus.
      const hashId = registryHashId(registryHash);
      if (hashId !== undefined) {
        recorder.set(METRIC.registryHashId, hashId, {});
      }
    },
  };
}
