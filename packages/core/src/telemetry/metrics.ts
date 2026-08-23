// SPDX-License-Identifier: Apache-2.0
/**
 * Metric recorder implementations (§9.2).
 */

import { assertLabelsAllowed } from './cardinality.js';
import { redactMetricLabels } from '../redaction/surfaces.js';
import {
  METRIC,
  type MetricLabels,
  type MetricName,
  type MetricRecorder,
} from './types.js';

/**
 * The default recorder: discards everything.
 *
 * Telemetry is opt-in, so this is what a server without an exporter uses.
 */
export const noopMetricRecorder: MetricRecorder = {
  add: () => undefined,
  record: () => undefined,
  set: () => undefined,
};

export interface RecordedSample {
  readonly metric: MetricName;
  readonly kind: 'add' | 'record' | 'set';
  readonly value: number;
  readonly labels: MetricLabels;
}

export interface RecordingMetricRecorder extends MetricRecorder {
  samples(): readonly RecordedSample[];
  /** Samples for one metric, in emission order. */
  forMetric(name: MetricName): readonly RecordedSample[];
  reset(): void;
}

/**
 * A recorder that retains samples AND enforces the cardinality rule.
 *
 * Enforcement lives here rather than only in the CI guard because the static
 * guard reads DECLARATIONS — it cannot see a caller inventing an undeclared
 * label at runtime. The two checks cover different halves, and neither
 * subsumes the other.
 */
export function createRecordingMetricRecorder(): RecordingMetricRecorder {
  const samples: RecordedSample[] = [];

  const push = (kind: RecordedSample['kind']) =>
    (name: MetricName, value: number, labels: MetricLabels): void => {
      assertLabelsAllowed(name, labels);
      // Surface 3 of §9.4. A leaked metric label is worse than a leaked log
      // line: it becomes an indexed time series that outlives log rotation
      // and is far harder to delete.
      samples.push({ metric: name, kind, value, labels: redactMetricLabels(labels) });
    };

  return {
    add: push('add'),
    record: push('record'),
    set: push('set'),
    samples: () => [...samples],
    forMetric: (name) => samples.filter((s) => s.metric === name),
    reset: () => {
      samples.length = 0;
    },
  };
}

/**
 * Emit the v0.2 placeholder series (§9.2).
 *
 * `mcp_tool_queue_depth` and `mcp_circuit_breaker_state` have no behaviour
 * behind them until Epic #3, but the issue requires all thirteen metrics to
 * exist. Emitting them with a `default` label means an operator can build the
 * dashboard now and have it start showing real data when bulkheads and
 * breakers land, rather than having to rebuild it then.
 *
 * They are emitted as ZERO, not as a fabricated value: a placeholder that
 * invents plausible numbers is worse than one that is visibly empty.
 */
export function emitPlaceholderSeries(metrics: MetricRecorder): void {
  metrics.set(METRIC.toolQueueDepth, 0, { bulkhead: 'default' });
  metrics.set(METRIC.circuitBreakerState, 0, { breaker: 'default' });
}
