// SPDX-License-Identifier: Apache-2.0
/**
 * Golden dashboards (§51 test infrastructure).
 *
 * GENERATED from `METRIC_DEFINITIONS` rather than hand-written JSON.
 *
 * §51 wants an operator to "import them and see the same shape our tests
 * see". A checked-in JSON blob cannot promise that: it drifts the first time
 * a metric is added and nothing notices, which is how a dashboard ends up
 * showing five panels for a nineteen-metric runtime. Deriving it from the
 * same constant the runtime emits against makes the two the same statement,
 * and the test below asserts the panel set equals the declared metric set.
 */

import { METRIC_DEFINITIONS, type MetricDefinition } from '@askturret/mcp-core';

export interface GrafanaPanel {
  readonly title: string;
  readonly type: string;
  readonly description: string;
  readonly targets: readonly { readonly expr: string; readonly legendFormat: string }[];
  readonly gridPos: { h: number; w: number; x: number; y: number };
  readonly id: number;
}

export interface GrafanaDashboard {
  readonly title: string;
  readonly uid: string;
  readonly schemaVersion: number;
  readonly panels: readonly GrafanaPanel[];
  readonly tags: readonly string[];
  readonly time: { readonly from: string; readonly to: string };
}

/**
 * A PromQL expression appropriate to the metric's kind.
 *
 * A counter graphed raw is a monotonically rising line that tells an operator
 * nothing; it needs a rate. A gauge needs the opposite — rate() over a gauge
 * is meaningless. Getting this wrong is the commonest way a technically
 * complete dashboard is useless in an incident.
 */
function expressionFor(definition: MetricDefinition): string {
  const labels = definition.labels.join(', ');

  // An UNLABELLED metric has one series, so there is nothing to group by.
  // `sum by () (…)` is legal PromQL and renders as a degenerate panel with an
  // empty legend, which is how #136 first surfaced here: dropping a metric's
  // only label produced `max by () (mcp_registry_operations)`. Aggregating
  // without a grouping clause is the correct form, and it is what an operator
  // would have written by hand.
  if (definition.labels.length === 0) {
    switch (definition.kind) {
      case 'counter':
        return `sum(rate(${definition.name}[5m]))`;
      case 'histogram':
        return `histogram_quantile(0.99, sum by (le) (rate(${definition.name}_bucket[5m])))`;
      case 'gauge':
        return `max(${definition.name})`;
    }
  }

  switch (definition.kind) {
    case 'counter':
      return `sum by (${labels}) (rate(${definition.name}[5m]))`;
    case 'histogram':
      return `histogram_quantile(0.99, sum by (le, ${labels}) (rate(${definition.name}_bucket[5m])))`;
    case 'gauge':
      return `max by (${labels}) (${definition.name})`;
  }
}

function panelTypeFor(definition: MetricDefinition): string {
  return definition.kind === 'gauge' ? 'stat' : 'timeseries';
}

export function buildGoldenDashboard(
  definitions: readonly MetricDefinition[] = METRIC_DEFINITIONS,
): GrafanaDashboard {
  const panels = definitions.map((definition, index) => ({
    title: definition.name,
    type: panelTypeFor(definition),
    description: definition.description,
    targets: [
      {
        expr: expressionFor(definition),
        // An unlabelled metric has nothing to interpolate, so the metric name
        // is the legend. An empty string here renders as a blank series label
        // in Grafana, which reads as a rendering fault rather than as a single
        // unlabelled series (#136).
        legendFormat:
          definition.labels.length === 0
            ? definition.name
            : definition.labels.map((label) => `{{${label}}}`).join(' / '),
      },
    ],
    // Two panels per row, in declaration order — deterministic, so a
    // regenerated dashboard diffs cleanly against the committed one.
    gridPos: { h: 8, w: 12, x: (index % 2) * 12, y: Math.floor(index / 2) * 8 },
    id: index + 1,
  }));

  return {
    title: 'AskTurret MCP — reliability',
    uid: 'askturret-mcp-reliability',
    schemaVersion: 39,
    panels,
    tags: ['askturret', 'mcp', 'generated'],
    time: { from: 'now-6h', to: 'now' },
  };
}

/** Stable JSON, so a regenerated dashboard produces a clean diff. */
export function renderGoldenDashboard(
  definitions: readonly MetricDefinition[] = METRIC_DEFINITIONS,
): string {
  return `${JSON.stringify(buildGoldenDashboard(definitions), null, 2)}\n`;
}
