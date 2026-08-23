// SPDX-License-Identifier: Apache-2.0
/**
 * Breaker assignment (§8.5) — which group an operation lands in.
 *
 * Separated from the state machine because assignment is where a breaker
 * silently becomes useless: an operation routed to `default` instead of its
 * own group still gets *a* breaker, so nothing fails — the isolation just
 * quietly is not there.
 */

import { describe, it, expect } from '@jest/globals';

import { assignBreaker } from '../registry.js';
import type { BreakersConfig } from '../types.js';
import type { OperationDefinition } from '../../types.js';

const CONFIG: BreakersConfig = {
  default: { failureThreshold: 5, failureWindowMs: 1000, cooldownMs: 100, halfOpenProbes: 1 },
  ordersApi: {
    failureThreshold: 5,
    failureWindowMs: 1000,
    cooldownMs: 100,
    halfOpenProbes: 1,
    baseUrl: 'https://api.example.com',
  },
  ordersV2: {
    failureThreshold: 5,
    failureWindowMs: 1000,
    cooldownMs: 100,
    halfOpenProbes: 1,
    baseUrl: 'https://api.example.com/v2',
  },
  test: { failureThreshold: 5, failureWindowMs: 1000, cooldownMs: 100, halfOpenProbes: 1 },
};

function operation(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return {
    id: 'op',
    name: 'op',
    description: 'op',
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'http' },
    ...overrides,
  };
}

describe('assignment order (§8.5)', () => {
  it('prefers an explicit annotation over everything else', () => {
    const op = operation({
      annotations: { breakerGroup: 'ordersApi' },
      executor: { type: 'test', config: { baseUrl: 'https://api.example.com/v2' } },
    });

    expect(assignBreaker(op, CONFIG)).toBe('ordersApi');
  });

  it('falls back to default when the annotation names an unconfigured group', () => {
    // A typo'd group name is not worth failing a request over — but it must
    // not silently resolve to some other group either.
    const op = operation({ annotations: { breakerGroup: 'nonesuch' } });

    expect(assignBreaker(op, CONFIG)).toBe('default');
  });

  it('matches by baseUrl when there is no annotation', () => {
    const op = operation({ executor: { type: 'x', config: { baseUrl: 'https://api.example.com/orders' } } });

    expect(assignBreaker(op, CONFIG)).toBe('ordersApi');
  });

  it('prefers the LONGEST matching baseUrl, not whichever key comes first', () => {
    // Both `ordersApi` (https://api.example.com) and `ordersV2`
    // (https://api.example.com/v2) prefix this URL. Depending on object key
    // order here would make assignment change when the config is reformatted.
    const op = operation({ executor: { type: 'x', config: { baseUrl: 'https://api.example.com/v2/orders' } } });

    expect(assignBreaker(op, CONFIG)).toBe('ordersV2');
  });

  it('falls back to a breaker named after the executor type', () => {
    const op = operation({ executor: { type: 'test' } });

    expect(assignBreaker(op, CONFIG)).toBe('test');
  });

  it('falls back to default when nothing matches', () => {
    const op = operation({ executor: { type: 'unregistered' } });

    expect(assignBreaker(op, CONFIG)).toBe('default');
  });
});

describe('assignment never throws (#43 precedent)', () => {
  // RegistrySnapshot has no runtime validation, so a hand-built snapshot can
  // omit fields the types declare as required. #43 shipped an assign() that
  // threw on exactly that shape, which surfaced as every call returning
  // INTERNAL_ERROR — a routing decision taking down the request it was
  // routing. These drive the malformed shapes directly.
  const malformed: readonly [string, unknown][] = [
    ['no executor', { id: 'op' }],
    ['executor with no type', { id: 'op', executor: {} }],
    ['null executor config', { id: 'op', executor: { type: 'x', config: null } }],
    ['non-string baseUrl', { id: 'op', executor: { type: 'x', config: { baseUrl: 42 } } }],
    ['non-string annotation', { id: 'op', annotations: { breakerGroup: 7 } }],
    ['empty object', {}],
  ];

  it.each(malformed)('routes %s to default without throwing', (_label, shape) => {
    expect(assignBreaker(shape as OperationDefinition, CONFIG)).toBe('default');
  });
});
