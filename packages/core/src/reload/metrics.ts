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
    // Unlabelled since #136. This used to pass a shortened `registry_hash`, on
    // the belief that shortening bounded the cardinality. Shortening bounded
    // the label's WIDTH; the value set stayed unbounded, producing one new
    // permanent series per reload. With no label there is exactly one series,
    // which is what a gauge of the LIVE registry wanted in the first place.
    recordActiveRegistry: (operationCount: number): void => {
      recorder.set(METRIC.registryOperations, operationCount, {});
    },
  };
}
