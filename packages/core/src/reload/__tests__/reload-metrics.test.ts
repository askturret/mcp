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
import { createReloadController } from '../controller.js';
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

    reloadMetricsFromRecorder(recorder).recordActiveRegistry('a1b2c3d4e5f67890', 7);

    expect(recorder.forMetric(METRIC.registryOperations)).toEqual([
      {
        metric: METRIC.registryOperations,
        kind: 'set',
        value: 7,
        labels: {},
      },
    ]);
  });

  it('emits NO labels, so reloading cannot grow the series count (#136)', () => {
    // This asserted `{ registry_hash: 'short' }` until #136, under the heading
    // "does not re-shorten the hash it is given" — a test about the label's
    // WIDTH, written on the assumption that width was the cardinality bound.
    // It was not: a truncated hash still differs on every registry change, so
    // each reload added a permanent series, and in the OTel adapter a permanent
    // entry in a map nothing evicts from.
    //
    // Asserted as an exact empty object rather than "no registry_hash key",
    // because ANY label here reintroduces the same growth. The claim is that
    // this gauge has one series — not that it lost one particular label.
    const recorder = createRecordingMetricRecorder();
    const metrics = reloadMetricsFromRecorder(recorder);

    metrics.recordActiveRegistry('a1b2c3d4e5f67890', 1);
    metrics.recordActiveRegistry('ffffffffffffffff', 2);

    const emitted = recorder.forMetric(METRIC.registryOperations);
    expect(emitted).toHaveLength(2);
    for (const record of emitted) expect(record.labels).toEqual({});
  });

  // #136 QA — the regression the label removal caused, and the fix for it.
  //
  // Removing `registry_hash` fixed the leak and silently disabled
  // `McpRegistryHashDivergence`: its recording rule counts DISTINCT values of
  // that label, and a missing label collapses to `""` on every series, so the
  // count became a permanent 1. Identity had to come back — as a VALUE, which
  // is the only form that does not grow the series count.
  it('re-emits registry identity as a VALUE, so divergence stays detectable (#136 QA)', () => {
    const recorder = createRecordingMetricRecorder();
    const metrics = reloadMetricsFromRecorder(recorder);

    metrics.recordActiveRegistry('a1b2c3d4e5f67890', 1);
    metrics.recordActiveRegistry('ffffffffffffffff', 1);

    const emitted = recorder.forMetric(METRIC.registryHashId);

    // Two DIFFERENT values — the thing `count_values` counts. Were these equal,
    // two diverging instances would report agreement.
    expect(emitted.map((r) => r.value)).toEqual([0xa1b2c3d4e5f67, 0xfffffffffffff]);

    // ...carried on ONE series. This is the half that keeps #136 fixed: the
    // identity varies, the label set does not.
    for (const record of emitted) expect(record.labels).toEqual({});
  });

  it('keeps every hash id exactly representable as a float64', () => {
    // The whole reason the prefix is 13 hex digits (52 bits) and not 16 (64).
    // Above 2^53 distinct hashes round to the SAME double, and two diverging
    // instances would then compare equal — divergence reported as consensus,
    // which is the one failure this metric may not have.
    const recorder = createRecordingMetricRecorder();
    const metrics = reloadMetricsFromRecorder(recorder);

    metrics.recordActiveRegistry('ffffffffffffffff', 1);

    const value = recorder.forMetric(METRIC.registryHashId)[0]?.value ?? 0;
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBe(2 ** 52 - 1);
  });

  it('skips the sample rather than emitting 0 for an unparseable hash', () => {
    // 0 is a legal identity. Emitting it on a parse failure would make every
    // instance that failed to parse look like it agreed with every other one,
    // turning a detector into a source of false silence.
    const recorder = createRecordingMetricRecorder();

    reloadMetricsFromRecorder(recorder).recordActiveRegistry('not-a-hash', 4);

    expect(recorder.forMetric(METRIC.registryHashId)).toEqual([]);
    // The operation count still lands — it does not depend on the hash.
    expect(recorder.forMetric(METRIC.registryOperations)).toHaveLength(1);
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
    //
    // Both samples used to assert `{ registry_hash: shortHash(...) }`, which is
    // what made the unbounded label look verified: two reloads, two different
    // hashes, two series, and a green test. Since #136 the gauge is unlabelled,
    // so what the two samples share is the label set, and what differs is only
    // the level.
    const gauges = recorder.forMetric(METRIC.registryOperations);
    expect(gauges[0]?.labels).toEqual({});
    expect(gauges[gauges.length - 1]).toMatchObject({
      value: v2.operations.size,
      labels: {},
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
