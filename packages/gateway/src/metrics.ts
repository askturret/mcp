// SPDX-License-Identifier: Apache-2.0
/**
 * Prometheus scrape endpoint (#57, §9.2).
 *
 * ## Driven by the catalogue, not by a hand-written list
 *
 * `# HELP` and `# TYPE` lines come from `METRIC_DEFINITIONS` in core, which is
 * the same data the cardinality guard enumerates. A second list here would be a
 * second place to add a metric, and the failure mode is silent: the metric is
 * recorded, the exposition omits it, and nobody notices until a dashboard is
 * empty.
 *
 * ## Cardinality is enforced, not trusted
 *
 * Every label set is checked with core's `assertLabelsAllowed` before it can
 * create a series. An unbounded label — a request id, a user id, a raw URL — is
 * how a metrics endpoint turns into an outage, and the gateway is exactly where
 * that risk lands: it is a long-lived process scraped forever, so a bad series
 * never ages out.
 *
 * ## Histograms are summarised, not bucketed
 *
 * Each histogram exposes `_count` and `_sum` — real Prometheus series, and
 * enough for an average — but no `_bucket` series, so no quantiles. Buckets
 * need a per-metric boundary choice that §9.2 does not specify, and inventing
 * one here would bake a guess into an exposition format that is hard to change
 * later. Stated plainly rather than shipped as a silent approximation: if you
 * need quantiles, use the OTel path, which has a real histogram behind it.
 */

import { METRIC_DEFINITIONS, assertLabelsAllowed } from '@askturret/mcp-core';
import type {
  MetricDefinition,
  MetricLabels,
  MetricName,
  MetricRecorder,
} from '@askturret/mcp-core';

/** One label combination's accumulated value. */
interface Series {
  readonly labels: MetricLabels;
  /** Counter total, gauge current value, or histogram sum. */
  value: number;
  /** Observation count. Histograms only. */
  count: number;
}

export interface PrometheusRegistry extends MetricRecorder {
  /** Render the current state in Prometheus text exposition format 0.0.4. */
  render(): string;
  /** Number of distinct series held, across all metrics. For tests and guards. */
  seriesCount(): number;
}

const BY_NAME: ReadonlyMap<MetricName, MetricDefinition> = new Map(
  METRIC_DEFINITIONS.map((definition) => [definition.name, definition]),
);

/**
 * Stable key for one label combination.
 *
 * Sorted so `{a,b}` and `{b,a}` are the same series — an unsorted key would
 * create two series for one logical thing, which is a slow cardinality leak
 * rather than an obvious bug.
 */
function seriesKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key] ?? ''}`)
    .join(',');
}

/** Escape a label value per the exposition format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const rendered = keys.map((key) => `${key}="${escapeLabelValue(labels[key] ?? '')}"`).join(',');
  return `{${rendered}}`;
}

/**
 * Create a `MetricRecorder` that also renders Prometheus exposition.
 *
 * It is a full `MetricRecorder`, so it goes into `Observability` and reaches the
 * dispatcher through the transport exactly as an OTel recorder would. The
 * gateway does not intercept or re-derive anything the dispatcher records.
 */
export function createPrometheusRegistry(): PrometheusRegistry {
  const state = new Map<MetricName, Map<string, Series>>();

  function seriesFor(name: MetricName, labels: MetricLabels): Series | undefined {
    const definition = BY_NAME.get(name);
    // An unknown metric name is DROPPED rather than exposed. The recorder is a
    // trust boundary between the dispatcher and a scrape endpoint, and a name
    // that is not in the catalogue has no declared type or labels — guessing
    // `untyped` would put a series nobody declared in front of Prometheus.
    if (definition === undefined) return undefined;

    // Throws on a denied or undeclared label. Deliberately NOT caught: a
    // cardinality violation is a bug in the caller, and swallowing it here
    // would hide it until the scrape endpoint fell over.
    assertLabelsAllowed(name, labels);

    let byLabels = state.get(name);
    if (byLabels === undefined) {
      byLabels = new Map();
      state.set(name, byLabels);
    }

    const key = seriesKey(labels);
    let series = byLabels.get(key);
    if (series === undefined) {
      series = { labels: { ...labels }, value: 0, count: 0 };
      byLabels.set(key, series);
    }
    return series;
  }

  return {
    add(name, value, labels): void {
      const series = seriesFor(name, labels);
      if (series === undefined) return;
      series.value += value;
      series.count += 1;
    },

    record(name, value, labels): void {
      const series = seriesFor(name, labels);
      if (series === undefined) return;
      // Histogram: sum and count, which is what `_sum` / `_count` expose.
      series.value += value;
      series.count += 1;
    },

    set(name, value, labels): void {
      const series = seriesFor(name, labels);
      if (series === undefined) return;
      // Gauge: replaces rather than accumulates. Using `+=` here would turn
      // "12 in flight" into a number that only ever grows.
      series.value = value;
      series.count += 1;
    },

    seriesCount(): number {
      let total = 0;
      for (const byLabels of state.values()) total += byLabels.size;
      return total;
    },

    render(): string {
      const lines: string[] = [];

      // Iterate the CATALOGUE, not the recorded state, so the output order is
      // stable across scrapes and independent of which metric fired first.
      for (const definition of METRIC_DEFINITIONS) {
        const byLabels = state.get(definition.name);
        if (byLabels === undefined || byLabels.size === 0) continue;

        const type = definition.kind === 'histogram' ? 'summary' : definition.kind;
        lines.push(`# HELP ${definition.name} ${definition.description}`);
        lines.push(`# TYPE ${definition.name} ${type}`);

        for (const series of byLabels.values()) {
          const labels = renderLabels(series.labels);
          if (definition.kind === 'histogram') {
            lines.push(`${definition.name}_sum${labels} ${series.value}`);
            lines.push(`${definition.name}_count${labels} ${series.count}`);
          } else {
            lines.push(`${definition.name}${labels} ${series.value}`);
          }
        }
      }

      // Exposition format requires a trailing newline; a scrape of a body that
      // lacks one is a parse error in some clients rather than an empty result.
      return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
    },
  };
}

/** Content type Prometheus expects for text exposition. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
