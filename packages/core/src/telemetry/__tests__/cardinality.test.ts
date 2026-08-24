// SPDX-License-Identifier: Apache-2.0
/**
 * Cardinality rule tests (§9.2, §17 criterion 8).
 */

import { describe, it, expect } from '@jest/globals';
import {
  LABEL_DENYLIST,
  findCardinalityViolations,
  isDeniedLabel,
  normalizeLabel,
  assertLabelsAllowed,
} from '../cardinality.js';
import { METRIC_DEFINITIONS } from '../types.js';
import { createRecordingMetricRecorder } from '../metrics.js';

describe('label denylist', () => {
  it('denies every documented term', () => {
    for (const term of LABEL_DENYLIST) {
      expect(isDeniedLabel(term)).not.toBeNull();
    }
  });

  it('denies snake_case spellings of a camelCase denylist entry', () => {
    // The denylist says `requestId`, but every real metric label in §9.2 is
    // snake_case. A literal match would block the spelling nobody writes and
    // allow the one everybody does.
    expect(isDeniedLabel('request_id')).toBe('requestid');
    expect(isDeniedLabel('requestId')).toBe('requestid');
    expect(isDeniedLabel('REQUEST-ID')).toBe('requestid');
  });

  it('denies compound labels built from a denied term', () => {
    expect(isDeniedLabel('user_id')).toBe('user');
    expect(isDeniedLabel('tenantName')).toBe('tenant');
    expect(isDeniedLabel('principal_hash')).toBe('principal');
    expect(isDeniedLabel('input_value')).toBe('input');
  });

  it('allows every label the metric set actually declares', () => {
    // Previously titled as the substring-regression guard, and it was not one:
    // it justified itself with "`outcome` contains sub" — `outcome` does not
    // contain "sub" — and NONE of the labels below collides with the denylist
    // by substring either. Every assertion passed, for a reason that was not
    // true, guarding a regression it could not detect (#39 QA).
    //
    // What it does check is still worth checking: the declared label set is
    // accepted. The substring regression is covered by the test below.
    expect(isDeniedLabel('outcome')).toBeNull();
    expect(isDeniedLabel('tool')).toBeNull();
    expect(isDeniedLabel('method')).toBeNull();
    expect(isDeniedLabel('error_code')).toBeNull();
    expect(isDeniedLabel('executor_type')).toBeNull();
    expect(isDeniedLabel('bulkhead')).toBeNull();
    expect(isDeniedLabel('breaker')).toBeNull();
    // `registry_hash` was asserted here as an ALLOWED label until #136. It is
    // now denied, and the metric that declared it is unlabelled — see the
    // hash-label block at the bottom of this file for why truncating a hash
    // never bounded anything.
    expect(isDeniedLabel('phase')).toBeNull();
    expect(isDeniedLabel('decision')).toBeNull();
    expect(isDeniedLabel('error_class')).toBeNull();
  });

  it('does NOT deny a label that merely CONTAINS a denied term as a substring', () => {
    // These genuinely collide by substring and not by segment, which is what
    // makes them the real guard. Swap `isDeniedLabel` to `includes()` and every
    // one of them starts failing.
    expect('target'.includes('arg')).toBe(true);
    expect(isDeniedLabel('target')).toBeNull();

    expect('subject'.includes('sub')).toBe(true);
    expect(isDeniedLabel('subject')).toBeNull();
    expect(isDeniedLabel('subsystem')).toBeNull();

    // `arguments` is not `arg`: a count OF the arguments carries no argument
    // values, so the segment rule correctly lets it through.
    expect(isDeniedLabel('arguments_count')).toBeNull();
  });

  it('normalizes case and separators consistently', () => {
    expect(normalizeLabel('Request-ID')).toBe('requestid');
    expect(normalizeLabel('executor_type')).toBe('executortype');
  });
});

describe('declared metric set', () => {
  it('has zero cardinality violations', () => {
    expect(findCardinalityViolations()).toEqual([]);
  });

  it('declares all 20 required metrics', () => {
    // §9.2 lists thirteen. A missing one is a dashboard an operator cannot
    // build, so the count is asserted rather than left implicit.
    // 13 from §9.2, plus mcp_bulkhead_rejected_total (#43), plus
    // mcp_retry_attempts_total and mcp_retry_exhausted_total (#45), plus the
    // three audit series (#48), plus mcp_redaction_hits_total (#49).
    expect(METRIC_DEFINITIONS).toHaveLength(20);
  });

  it('gives every metric a kind, a well-formed label set, and a description', () => {
    // This required at least ONE label until #136, and that requirement was
    // quietly the wrong way round: an unlabelled metric is a single time series
    // and therefore the cheapest thing you can declare, while a rule demanding
    // a label nudges toward inventing one. `mcp_registry_operations` is now
    // deliberately unlabelled for exactly that reason.
    //
    // What is worth asserting is that the labels are WELL FORMED — no empty or
    // whitespace-only names, which would produce an unqueryable series.
    for (const definition of METRIC_DEFINITIONS) {
      expect(['counter', 'histogram', 'gauge']).toContain(definition.kind);
      expect(Array.isArray(definition.labels)).toBe(true);
      for (const label of definition.labels) expect(label.trim()).toBe(label);
      for (const label of definition.labels) expect(label.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it('FAILS when a metric is declared with a high-cardinality label', () => {
    // The issue's stated test: "introducing a metric with a user_id label
    // fails CI". Checked against the real detector, not a copy of it.
    const violations = findCardinalityViolations([
      {
        name: 'mcp_requests_total',
        kind: 'counter',
        labels: ['method', 'user_id'],
        description: 'deliberately bad',
      },
    ]);

    expect(violations).toEqual([
      { metric: 'mcp_requests_total', label: 'user_id', matched: 'user' },
    ]);
  });
});

describe('runtime label enforcement', () => {
  it('throws when a denied label is passed at emit time', () => {
    // The static check reads DECLARATIONS and cannot see a caller inventing an
    // undeclared label. This is the other half.
    expect(() => assertLabelsAllowed('mcp_requests_total', { user: 'alice' })).toThrow(
      /cardinality rule/,
    );
  });

  it('rejects a denied label through the recording recorder', () => {
    const recorder = createRecordingMetricRecorder();

    expect(() => recorder.add('mcp_requests_total', 1, { tenant: 'acme' })).toThrow(
      /cardinality rule/,
    );
    expect(recorder.samples()).toEqual([]);
  });

  it('allows the declared label sets through unchanged', () => {
    const recorder = createRecordingMetricRecorder();

    recorder.add('mcp_requests_total', 1, { method: 'tools/call', outcome: 'success' });
    recorder.record('mcp_tool_duration_seconds', 0.5, { tool: 'listPets', outcome: 'success' });
    recorder.set('mcp_tool_inflight', 2, { tool: 'listPets' });

    expect(recorder.samples()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Hash-valued labels (#136)
//
// `mcp_registry_operations` carried `registry_hash`, truncated to 12 characters
// by `shortHash`, and the surrounding comments called that the cardinality
// bound. It is not one. Truncation bounds a label's WIDTH; cardinality is the
// number of DISTINCT VALUES, and a truncated hash still differs on every
// registry change — one new permanent series per reload, and one new permanent
// entry in the OTel adapter's unevicted `gaugeLevels` map.
//
// These exist so the reasoning is ENFORCED rather than merely written down. A
// comment saying "hashes are unbounded" would not have stopped the next one;
// the one it replaced said the opposite and was believed for two issues.
// ---------------------------------------------------------------------------

describe('hash-valued labels are denied (#136)', () => {
  it('denies `registry_hash`, the label that prompted this', () => {
    expect(isDeniedLabel('registry_hash')).toBe('hash');
  });

  it('denies the whole family, however it is spelled', () => {
    // Compound labels are split on separators and camelCase boundaries, so a
    // future `inputHash` or `principal-hash` is caught before it is written.
    for (const label of ['hash', 'registryHash', 'input_hash', 'principal-hash', 'HASH']) {
      expect(isDeniedLabel(label)).not.toBeNull();
    }
  });

  it('does NOT deny a label that merely contains the letters', () => {
    // Matching is on whole segments. `hashtag` is one word, not a hash, and a
    // guard that cried wolf on it is one somebody eventually switches off.
    expect(isDeniedLabel('hashtag')).toBeNull();
  });

  it('leaves every currently declared metric legal', () => {
    // The other half of the change: adding a denied term is only safe if no
    // shipped metric still declares one. `mcp_registry_operations` dropped its
    // label in the same commit, and this is what proves the two agree.
    expect(findCardinalityViolations()).toEqual([]);
  });

  it('rejects a hash label at RUNTIME, not only in the declarations', () => {
    // The declaration check runs in CI; this one catches a caller passing a
    // label the metric never declared, which is the path a regression would
    // actually take.
    const recorder = createRecordingMetricRecorder();

    expect(() => recorder.set('mcp_registry_operations', 1, { registry_hash: 'abc123' })).toThrow(
      /cardinality rule/,
    );
    expect(recorder.samples()).toEqual([]);
  });
});
