// SPDX-License-Identifier: Apache-2.0
/**
 * Observability stub contract tests (#79).
 *
 * `openTelemetry()` is a deliberate v0.1 stub: it returns an adapter whose
 * methods throw "Not yet implemented". These tests pin that contract rather
 * than pretending the feature works.
 *
 * That is the point — the package previously had `"test": "exit 0"` and no jest
 * config at all, so CI's `test-observability` job reported success while
 * executing nothing. Pinning the stub means the job is honest today, and goes
 * red the moment someone implements the real adapter without replacing these
 * tests, which is exactly when real coverage needs to be written.
 */

import { describe, it, expect } from '@jest/globals';

import { openTelemetry } from '../index.js';

describe('openTelemetry (v0.1 stub)', () => {
  it('returns an adapter object', () => {
    const adapter = openTelemetry() as Record<string, unknown>;

    expect(adapter).toBeDefined();
    expect(typeof adapter).toBe('object');
  });

  it('exposes trace and metrics as callables', () => {
    const adapter = openTelemetry() as { trace: unknown; metrics: unknown };

    expect(typeof adapter.trace).toBe('function');
    expect(typeof adapter.metrics).toBe('function');
  });

  it('throws "Not yet implemented" from trace rather than silently no-oping', () => {
    const adapter = openTelemetry() as { trace: () => unknown };

    // A silent no-op would be worse than throwing: an adopter would believe
    // telemetry was being recorded.
    expect(() => adapter.trace()).toThrow('Not yet implemented');
  });

  it('throws "Not yet implemented" from metrics rather than silently no-oping', () => {
    const adapter = openTelemetry() as { metrics: () => unknown };

    expect(() => adapter.metrics()).toThrow('Not yet implemented');
  });

  it('accepts options without throwing at construction time', () => {
    // Construction must stay side-effect free; only use throws.
    expect(() =>
      openTelemetry({ serviceName: 'test', enableTracing: true, enableMetrics: true }),
    ).not.toThrow();
  });

  it('returns a fresh adapter per call', () => {
    expect(openTelemetry()).not.toBe(openTelemetry());
  });
});
