// SPDX-License-Identifier: Apache-2.0
/**
 * `ReloadMetrics` -> `MetricRecorder` bridge (#39 QA).
 *
 * `mcp_registry_reload_total` and `mcp_registry_operations` were DECLARED in
 * `METRIC_DEFINITIONS` — so the OTel adapter created an instrument for each —
 * but no code path ever emitted a sample to either. The reload controller
 * reports through its own `ReloadMetrics` port, and nothing joined that port
 * to the recorder, so eleven of the required thirteen metrics were actually
 * emitted.
 *
 * Every assertion here is about EMISSION. `cardinality.test.ts` already pins
 * the DECLARED set, and a declaration count is exactly what cannot see this
 * class of gap.
 */

import { describe, it, expect } from '@jest/globals';

import { AtomicRegistryReference } from '../../registry-reference.js';
import { createRecordingMetricRecorder } from '../../telemetry/metrics.js';
import { METRIC } from '../../telemetry/types.js';
import { createReloadController, shortHash } from '../controller.js';
import { NO_ERROR_CLASS, reloadMetricsFromRecorder } from '../metrics.js';
import type { ReloadMetrics } from '../types.js';
import { snapshot } from './fixtures.js';

describe('reloadMetricsFromRecorder', () => {
  it('emits mcp_registry_reload_total with a stable label set on success', () => {
    const recorder = createRecordingMetricRecorder();

    reloadMetricsFromRecorder(recorder).recordReload('success');

    expect(recorder.forMetric(METRIC.registryReloadTotal)).toEqual([
      {
        metric: METRIC.registryReloadTotal,
        kind: 'add',
        value: 1,
        labels: { outcome: 'success', error_class: NO_ERROR_CLASS },
      },
    ]);
  });

  it('carries errorClass through as the error_class label', () => {
    // This is the half of #37's QA note that was unqueryable: the controller
    // has always passed `superseded` correctly, but the metric it labels never
    // reached a backend, so nobody could split a benign rollback race from a
    // real compile failure.
    const recorder = createRecordingMetricRecorder();

    reloadMetricsFromRecorder(recorder).recordReload('error', 'superseded');

    expect(recorder.forMetric(METRIC.registryReloadTotal)[0]?.labels).toEqual({
      outcome: 'error',
      error_class: 'superseded',
    });
  });

  it('emits mcp_registry_operations as an absolute level, not an increment', () => {
    const recorder = createRecordingMetricRecorder();

    reloadMetricsFromRecorder(recorder).recordActiveRegistry('abc123def456', 7);

    expect(recorder.forMetric(METRIC.registryOperations)).toEqual([
      {
        metric: METRIC.registryOperations,
        kind: 'set',
        value: 7,
        labels: { registry_hash: 'abc123def456' },
      },
    ]);
  });

  it('does not re-shorten the hash it is given', () => {
    // The controller shortens before calling. Shortening again here would be a
    // second opinion on cardinality in a second place, and the two would drift.
    const recorder = createRecordingMetricRecorder();

    reloadMetricsFromRecorder(recorder).recordActiveRegistry('short', 1);

    expect(recorder.forMetric(METRIC.registryOperations)[0]?.labels).toEqual({
      registry_hash: 'short',
    });
  });
});

describe('createReloadController metric wiring', () => {
  it('emits both registry metrics through a supplied metricRecorder', async () => {
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const recorder = createRecordingMetricRecorder();

    const controller = createReloadController({
      reference: new AtomicRegistryReference(v1),
      compile: async () => v2,
      metricRecorder: recorder,
    });

    await controller.reload();

    // Construction records the initial registry; the successful reload records
    // the new one. Asserting the LAST sample rather than a count, because the
    // number of gauge writes is not the contract — the final level is.
    const gauges = recorder.forMetric(METRIC.registryOperations);
    expect(gauges[0]?.labels).toEqual({ registry_hash: shortHash(v1.hash) });
    expect(gauges[gauges.length - 1]).toMatchObject({
      value: v2.operations.size,
      labels: { registry_hash: shortHash(v2.hash) },
    });

    expect(recorder.forMetric(METRIC.registryReloadTotal)).toEqual([
      {
        metric: METRIC.registryReloadTotal,
        kind: 'add',
        value: 1,
        labels: { outcome: 'success', error_class: NO_ERROR_CLASS },
      },
    ]);
  });

  it('emits nothing to the registry metrics when no recorder is supplied', async () => {
    // The no-op default is load-bearing: telemetry is opt-in, and a controller
    // built without observability must not start emitting.
    const recorder = createRecordingMetricRecorder();
    const v1 = snapshot(1, ['a']);

    const controller = createReloadController({
      reference: new AtomicRegistryReference(v1),
      compile: async () => snapshot(2, ['a', 'b']),
    });

    await controller.reload();

    expect(recorder.samples()).toEqual([]);
  });

  it('lets an explicit metrics sink win over metricRecorder', async () => {
    // `metrics` stays the escape hatch for an adopter with their own sink;
    // adding `metricRecorder` must not silently hijack it.
    const seen: string[] = [];
    const explicit: ReloadMetrics = {
      recordReload: (outcome) => {
        seen.push(`reload:${outcome}`);
      },
      recordActiveRegistry: () => {
        seen.push('registry');
      },
    };
    const recorder = createRecordingMetricRecorder();

    const controller = createReloadController({
      reference: new AtomicRegistryReference(snapshot(1, ['a'])),
      compile: async () => snapshot(2, ['a', 'b']),
      metrics: explicit,
      metricRecorder: recorder,
    });

    await controller.reload();

    expect(seen).toContain('reload:success');
    expect(recorder.samples()).toEqual([]);
  });
});
