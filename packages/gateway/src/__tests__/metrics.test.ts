// SPDX-License-Identifier: Apache-2.0
/**
 * Prometheus exposition tests (#57, §9.2).
 *
 * The recorder is a `MetricRecorder`, so what the dispatcher records is what
 * gets exposed. These tests drive it through that interface rather than through
 * a private one — a test that reached inside would pass on a recorder the
 * dispatcher could not actually use.
 */

import { describe, it, expect } from '@jest/globals';
import { METRIC, METRIC_DEFINITIONS } from '@askturret/mcp-core';

import { createPrometheusRegistry } from '../metrics.js';

describe('Prometheus registry', () => {
  it('renders nothing at all before any metric is recorded', () => {
    // Not "renders zeros". A series that has never been observed does not
    // exist, and inventing one would report traffic that never happened.
    expect(createPrometheusRegistry().render()).toBe('');
  });

  it('accumulates a counter across observations', () => {
    const registry = createPrometheusRegistry();

    registry.add(METRIC.requestsTotal, 1, { method: 'tools/call', outcome: 'success' });
    registry.add(METRIC.requestsTotal, 2, { method: 'tools/call', outcome: 'success' });

    const text = registry.render();
    expect(text).toContain('# TYPE mcp_requests_total counter');
    expect(text).toContain('mcp_requests_total{method="tools/call",outcome="success"} 3');
  });

  it('keeps distinct label sets as distinct series', () => {
    const registry = createPrometheusRegistry();

    registry.add(METRIC.requestsTotal, 1, { method: 'tools/call', outcome: 'success' });
    registry.add(METRIC.requestsTotal, 1, { method: 'tools/call', outcome: 'error' });

    expect(registry.seriesCount()).toBe(2);
  });

  it('treats the same labels in a different order as ONE series', () => {
    // An unsorted key would create two series for one logical thing — a slow
    // cardinality leak rather than an obvious bug.
    const registry = createPrometheusRegistry();

    registry.add(METRIC.requestsTotal, 1, { method: 'tools/call', outcome: 'success' });
    registry.add(METRIC.requestsTotal, 1, { outcome: 'success', method: 'tools/call' });

    expect(registry.seriesCount()).toBe(1);
    expect(registry.render()).toContain('} 2');
  });

  it('REPLACES a gauge rather than accumulating it', () => {
    // `+=` here would turn "12 in flight" into a number that only ever grows.
    const registry = createPrometheusRegistry();

    registry.set(METRIC.toolInflight, 5, { tool: 'listPets' });
    registry.set(METRIC.toolInflight, 2, { tool: 'listPets' });

    expect(registry.render()).toContain('mcp_tool_inflight{tool="listPets"} 2');
  });

  it('exposes a histogram as _sum and _count, and says so in the TYPE line', () => {
    const registry = createPrometheusRegistry();

    registry.record(METRIC.requestDurationSeconds, 0.5, { method: 'tools/call', outcome: 'success' });
    registry.record(METRIC.requestDurationSeconds, 1.5, { method: 'tools/call', outcome: 'success' });

    const text = registry.render();
    expect(text).toContain('mcp_request_duration_seconds_sum{method="tools/call",outcome="success"} 2');
    expect(text).toContain('mcp_request_duration_seconds_count{method="tools/call",outcome="success"} 2');
    // Declared `summary`, not `histogram`: there are no `_bucket` series, and a
    // TYPE line promising buckets that are absent misleads a scraper.
    expect(text).toContain('# TYPE mcp_request_duration_seconds summary');
    expect(text).not.toContain('_bucket');
  });

  it('throws on a label the metric does not declare', () => {
    // Cardinality is ENFORCED, not trusted. An unbounded label is how a metrics
    // endpoint becomes an outage, and a long-lived gateway never ages the
    // series out.
    const registry = createPrometheusRegistry();

    expect(() =>
      registry.add(METRIC.requestsTotal, 1, { method: 'tools/call', request_id: 'abc-123' }),
    ).toThrow();
  });

  it('drops a metric name that is not in the catalogue', () => {
    // No declared type and no declared labels — guessing `untyped` would put a
    // series nobody declared in front of Prometheus.
    const registry = createPrometheusRegistry();

    registry.add('mcp_invented_total' as never, 1, {});

    expect(registry.render()).toBe('');
    expect(registry.seriesCount()).toBe(0);
  });

  it('takes its HELP text from the catalogue, not from a second list here', () => {
    // The failure a hand-written list produces is silent: the metric records,
    // the exposition omits it, and a dashboard is empty for a week.
    const registry = createPrometheusRegistry();
    const definition = METRIC_DEFINITIONS.find((d) => d.name === METRIC.toolCallsTotal);

    registry.add(METRIC.toolCallsTotal, 1, { tool: 'listPets', outcome: 'success' });

    expect(registry.render()).toContain(`# HELP mcp_tool_calls_total ${definition?.description}`);
  });

  it('escapes a label value that would otherwise break the format', () => {
    const registry = createPrometheusRegistry();

    registry.add(METRIC.toolCallsTotal, 1, { tool: 'we"ird', outcome: 'success' });

    expect(registry.render()).toContain('tool="we\\"ird"');
  });

  it('ends with a newline, which the exposition format requires', () => {
    const registry = createPrometheusRegistry();
    registry.add(METRIC.requestsTotal, 1, { method: 'tools/list', outcome: 'success' });

    expect(registry.render().endsWith('\n')).toBe(true);
  });

  it('orders output by the catalogue, so scrapes are stable', () => {
    // Recording order must not change the output, or every scrape diffs.
    const a = createPrometheusRegistry();
    a.add(METRIC.toolCallsTotal, 1, { tool: 't', outcome: 'success' });
    a.add(METRIC.requestsTotal, 1, { method: 'm', outcome: 'success' });

    const b = createPrometheusRegistry();
    b.add(METRIC.requestsTotal, 1, { method: 'm', outcome: 'success' });
    b.add(METRIC.toolCallsTotal, 1, { tool: 't', outcome: 'success' });

    expect(a.render()).toBe(b.render());
  });
});
