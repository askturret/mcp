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

import { assignBreaker, createBreakerRegistry, unmatchedBreakerGroup } from '../registry.js';
import type { BreakersConfig } from '../types.js';
import type { StructuredLogger } from '../../logging/types.js';
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

describe('an annotated group that is not configured is not silent (QA case C)', () => {
  // The routing answer is correct and deliberate: fall back to `default`
  // rather than throw. What was wrong is that it happened with NO signal at
  // all. An operator who writes `breakerGroup: 'ordersApi'` has explicitly
  // asked for isolation; a typo or an un-wired config entry hands them shared
  // fate with every other operation instead, and nothing anywhere says so.

  function recordingLogger(): {
    warns: { message: string; fields?: unknown }[];
    logger: StructuredLogger;
  } {
    const warns: { message: string; fields?: unknown }[] = [];
    const logger = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (message: string, fields?: unknown) => {
        warns.push({ message, fields });
      },
      error: () => {},
      child: () => logger,
    } as unknown as StructuredLogger;
    return { warns, logger };
  }

  it('warns, naming the group, the operation and what IS configured', () => {
    const { warns, logger } = recordingLogger();
    const registry = createBreakerRegistry({ config: CONFIG, logger });

    const assigned = registry.assign(
      operation({ id: 'listOrders', annotations: { breakerGroup: 'ordresApi' } }),
    );

    // Routing is unchanged — this is a warning, not a behaviour change.
    expect(assigned).toBe('default');

    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toMatch(/not configured/i);
    expect(warns[0]?.fields).toMatchObject({
      breakerGroup: 'ordresApi',
      operation: 'listOrders',
    });
    // Naming the configured groups is what turns "wrong" into "wrong, and
    // here is the list you meant to pick from".
    expect((warns[0]?.fields as { configured: string[] }).configured).toEqual(
      expect.arrayContaining(['ordersApi', 'default']),
    );
  });

  it('warns ONCE per group however many calls are assigned', () => {
    const { warns, logger } = recordingLogger();
    const registry = createBreakerRegistry({ config: CONFIG, logger });
    const op = operation({ annotations: { breakerGroup: 'nope' } });

    for (let i = 0; i < 50; i += 1) registry.assign(op);

    // Assignment runs on every dispatch. Warning per call would put a line in
    // the log for every request to a mis-annotated operation, which is how a
    // logger gets turned down and takes the real signal with it.
    expect(warns).toHaveLength(1);
  });

  it('warns separately for each distinct unconfigured group', () => {
    const { warns, logger } = recordingLogger();
    const registry = createBreakerRegistry({ config: CONFIG, logger });

    registry.assign(operation({ annotations: { breakerGroup: 'missingA' } }));
    registry.assign(operation({ annotations: { breakerGroup: 'missingB' } }));
    registry.assign(operation({ annotations: { breakerGroup: 'missingA' } }));

    expect(warns).toHaveLength(2);
    expect(warns.map((w) => (w.fields as { breakerGroup: string }).breakerGroup)).toEqual([
      'missingA',
      'missingB',
    ]);
  });

  it('stays quiet when the annotated group IS configured', () => {
    const { warns, logger } = recordingLogger();
    const registry = createBreakerRegistry({ config: CONFIG, logger });

    expect(registry.assign(operation({ annotations: { breakerGroup: 'ordersApi' } }))).toBe(
      'ordersApi',
    );
    expect(warns).toHaveLength(0);
  });

  it('stays quiet for operations that never asked for a group', () => {
    const { warns, logger } = recordingLogger();
    const registry = createBreakerRegistry({ config: CONFIG, logger });

    // Falls back to `default` for a reason that is NOT a mis-annotation, so
    // there is nothing to warn about — this is the ordinary unannotated path.
    expect(registry.assign(operation({ executor: { type: 'unregistered' } }))).toBe('default');
    expect(warns).toHaveLength(0);
  });

  it('does not throw when there is no logger at all', () => {
    const registry = createBreakerRegistry({ config: CONFIG });

    expect(() =>
      registry.assign(operation({ annotations: { breakerGroup: 'nope' } })),
    ).not.toThrow();
  });

  it('detects the mismatch directly, independently of the registry', () => {
    expect(
      unmatchedBreakerGroup(operation({ annotations: { breakerGroup: 'nope' } }), CONFIG),
    ).toBe('nope');
    expect(
      unmatchedBreakerGroup(operation({ annotations: { breakerGroup: 'ordersApi' } }), CONFIG),
    ).toBeUndefined();
    expect(unmatchedBreakerGroup(operation(), CONFIG)).toBeUndefined();
    // Malformed shapes must stay silent rather than warn about a non-group.
    expect(
      unmatchedBreakerGroup(
        { id: 'op', annotations: { breakerGroup: 7 } } as unknown as OperationDefinition,
        CONFIG,
      ),
    ).toBeUndefined();
  });
});
