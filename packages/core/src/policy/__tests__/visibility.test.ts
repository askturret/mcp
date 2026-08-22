/**
 * Discovery-time visibility tests.
 *
 * The cache tests use an injected clock rather than real timers. A test that
 * sleeps to prove a TTL is slow and flaky; one that advances a controlled
 * clock is neither, and it can assert the exact boundary rather than "some
 * time later".
 */

import { describe, it, expect } from '@jest/globals';
import { createVisibilityEngine, type PolicyMetrics } from '../visibility.js';
import { allOf, not } from '../combinators.js';
import { authenticated, readOnly } from '../builtins.js';
import type { Policy, PolicyContext, PolicyDecision, PolicyPhase } from '../types.js';
import type { OperationDefinition, Principal, RegistrySnapshot } from '../../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function operation(id: string, readOnlyFlag = true): OperationDefinition {
  return {
    id,
    name: id,
    description: `operation ${id}`,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: readOnlyFlag,
      idempotent: readOnlyFlag,
      retryable: readOnlyFlag,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'test' },
  };
}

/** A snapshot of `count` operations; even-numbered ones are read-only. */
function snapshot(count: number, hash: string, version = 1): RegistrySnapshot {
  const operations = new Map<string, OperationDefinition>();
  for (let i = 0; i < count; i++) {
    operations.set(`op${i}`, operation(`op${i}`, i % 2 === 0));
  }
  return { version, hash, createdAt: new Date(0), operations };
}

/** A clock the test drives. */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function countingMetrics(): PolicyMetrics & { readonly seen: Array<[PolicyPhase, string]> } {
  const seen: Array<[PolicyPhase, string]> = [];
  return {
    seen,
    recordDecision(phase, effect) {
      seen.push([phase, effect]);
    },
  };
}

const allowAll: Policy = { id: 'allowAll', evaluate: () => Promise.resolve({ effect: 'allow', evidence: [] }) };

/** Denies operations whose id ends in an odd digit. */
const denyOdd: Policy = {
  id: 'denyOdd',
  evaluate: (ctx: PolicyContext): Promise<PolicyDecision> => {
    const last = Number(ctx.operation.id.slice(-1));
    return Promise.resolve(
      last % 2 === 1
        ? { effect: 'deny', code: 'FORBIDDEN', safeReason: 'odd', evidence: [] }
        : { effect: 'allow', evidence: [] },
    );
  },
};

const alwaysConfirm: Policy = {
  id: 'alwaysConfirm',
  evaluate: () =>
    Promise.resolve({
      effect: 'confirmation_required',
      challenge: { id: 'c', kind: 'acknowledge', prompt: 'confirm?' },
      evidence: [],
    }),
};

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('filtering', () => {
  it('a policy denying half of ten tools leaves five visible', async () => {
    const engine = createVisibilityEngine({ policy: denyOdd });
    const visible = await engine.visibleOperations({ snapshot: snapshot(10, 'h1') });

    expect(visible).toHaveLength(5);
    expect(visible.map((o) => o.id)).toEqual(['op0', 'op2', 'op4', 'op6', 'op8']);
  });

  it('confirmation_required operations REMAIN visible', async () => {
    // Hiding them would make a confirmable operation indistinguishable from a
    // forbidden one. The confirmation happens at call time.
    const engine = createVisibilityEngine({ policy: alwaysConfirm });
    const visible = await engine.visibleOperations({ snapshot: snapshot(4, 'h1') });

    expect(visible).toHaveLength(4);
  });

  it('returns operations in snapshot order regardless of resolution order', async () => {
    // Evaluation is concurrent; order must come from the snapshot, not from
    // whichever promise settled first.
    const jittered: Policy = {
      id: 'jittered',
      evaluate: (ctx) =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ effect: 'allow', evidence: [] }),
            ctx.operation.id === 'op0' ? 5 : 0,
          ),
        ),
    };

    const engine = createVisibilityEngine({ policy: jittered });
    const visible = await engine.visibleOperations({ snapshot: snapshot(3, 'h1') });

    expect(visible.map((o) => o.id)).toEqual(['op0', 'op1', 'op2']);
  });

  it('evaluates with phase "discovery" and no input', async () => {
    const seen: PolicyContext[] = [];
    const recorder: Policy = {
      id: 'recorder',
      evaluate: (ctx) => {
        seen.push(ctx);
        return Promise.resolve({ effect: 'allow', evidence: [] });
      },
    };

    await createVisibilityEngine({ policy: recorder }).visibleOperations({
      snapshot: snapshot(1, 'h1'),
    });

    expect(seen[0]?.phase).toBe('discovery');
    // There is no call yet, so there are no arguments to reason about.
    expect(seen[0]?.input).toBeUndefined();
    expect(seen[0]?.registryHash).toBe('h1');
  });

  it('composes with the built-in policies', async () => {
    const engine = createVisibilityEngine({ policy: allOf([authenticated(), readOnly()]) });
    const principal: Principal = { id: 'u1', type: 'user' };

    const anonymous = await engine.visibleOperations({ snapshot: snapshot(4, 'h1') });
    const identified = await engine.visibleOperations({ snapshot: snapshot(4, 'h1'), principal });

    expect(anonymous).toHaveLength(0); // authenticated() denies every operation
    expect(identified.map((o) => o.id)).toEqual(['op0', 'op2']); // only read-only ones
  });
});

// ---------------------------------------------------------------------------
// Failing closed
// ---------------------------------------------------------------------------

describe('failing closed', () => {
  it('hides an operation when the policy throws', async () => {
    const thrower: Policy = {
      id: 'thrower',
      evaluate: () => {
        throw new Error('boom');
      },
    };

    const visible = await createVisibilityEngine({ policy: thrower }).visibleOperations({
      snapshot: snapshot(3, 'h1'),
    });

    expect(visible).toHaveLength(0);
  });

  it('hides an operation when the policy returns an unrecognised shape', async () => {
    const nonsense = {
      id: 'nonsense',
      evaluate: () => Promise.resolve({ effect: 'maybe' }),
    } as unknown as Policy;

    const visible = await createVisibilityEngine({ policy: nonsense }).visibleOperations({
      snapshot: snapshot(3, 'h1'),
    });

    expect(visible).toHaveLength(0);
  });

  it('a BARE throwing policy fails closed without a combinator above it', async () => {
    // The combinators fail closed internally, but a bare policy handed
    // straight to this engine has no combinator above it — the same one-layer
    // gap #33's QA found at the root of a combinator tree.
    const thrower: Policy = { id: 't', evaluate: () => Promise.reject(new Error('boom')) };
    await expect(
      createVisibilityEngine({ policy: thrower }).visibleOperations({ snapshot: snapshot(2, 'h1') }),
    ).resolves.toHaveLength(0);
  });

  it('a failing policy inside not() still hides, rather than inverting into visible', async () => {
    const thrower: Policy = { id: 't', evaluate: () => Promise.reject(new Error('boom')) };
    const visible = await createVisibilityEngine({ policy: not(thrower) }).visibleOperations({
      snapshot: snapshot(2, 'h1'),
    });
    expect(visible).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe('caching', () => {
  const principal: Principal = { id: 'u1', type: 'user', permissions: ['read'] };

  it('an identical principal + snapshot + policy version evaluates only once', async () => {
    const clock = fakeClock();
    const engine = createVisibilityEngine({ policy: allowAll, now: clock.now });
    const snap = snapshot(10, 'h1');

    const first = await engine.visibleOperations({ snapshot: snap, principal });
    expect(engine.evaluationCount).toBe(10);

    const second = await engine.visibleOperations({ snapshot: snap, principal });
    // Counted evaluations must not move — that is what "cache hit" means here.
    expect(engine.evaluationCount).toBe(10);
    expect(second.map((o) => o.id)).toEqual(first.map((o) => o.id));
  });

  it('swapping the snapshot re-evaluates', async () => {
    const clock = fakeClock();
    const engine = createVisibilityEngine({ policy: allowAll, now: clock.now });

    await engine.visibleOperations({ snapshot: snapshot(10, 'h1'), principal });
    expect(engine.evaluationCount).toBe(10);

    await engine.visibleOperations({ snapshot: snapshot(10, 'h2'), principal });
    expect(engine.evaluationCount).toBe(20);
  });

  it('a different principal re-evaluates', async () => {
    const clock = fakeClock();
    const engine = createVisibilityEngine({ policy: allowAll, now: clock.now });

    await engine.visibleOperations({ snapshot: snapshot(5, 'h1'), principal });
    await engine.visibleOperations({
      snapshot: snapshot(5, 'h1'),
      principal: { id: 'u2', type: 'user' },
    });

    expect(engine.evaluationCount).toBe(10);
  });

  it('the SAME id with DIFFERENT permissions re-evaluates', async () => {
    // Not required by the issue's three-part key, and the reason it is here:
    // without permissions in the hash, revoking one leaves the old visibility
    // cached until the TTL expires, because the identity did not change.
    const clock = fakeClock();
    const engine = createVisibilityEngine({ policy: allowAll, now: clock.now });
    const snap = snapshot(5, 'h1');

    await engine.visibleOperations({ snapshot: snap, principal: { id: 'u1', type: 'user', permissions: ['a', 'b'] } });
    await engine.visibleOperations({ snapshot: snap, principal: { id: 'u1', type: 'user', permissions: ['a'] } });

    expect(engine.evaluationCount).toBe(10);
  });

  it('a user and a service sharing an id do not share a cache entry', async () => {
    const clock = fakeClock();
    const engine = createVisibilityEngine({ policy: allowAll, now: clock.now });
    const snap = snapshot(5, 'h1');

    await engine.visibleOperations({ snapshot: snap, principal: { id: 'x', type: 'user' } });
    await engine.visibleOperations({ snapshot: snap, principal: { id: 'x', type: 'service' } });

    expect(engine.evaluationCount).toBe(10);
  });

  it('a changed policy version re-evaluates', async () => {
    const snap = snapshot(5, 'h1');
    const a = createVisibilityEngine({ policy: allowAll, policyVersion: 'v1' });
    const b = createVisibilityEngine({ policy: allowAll, policyVersion: 'v2' });

    await a.visibleOperations({ snapshot: snap, principal });
    await b.visibleOperations({ snapshot: snap, principal });

    // Separate engines, but the point is the key component: a version bump
    // must not reuse decisions made under the previous configuration.
    expect(a.evaluationCount).toBe(5);
    expect(b.evaluationCount).toBe(5);
  });

  it('expires exactly at the TTL boundary, not before', async () => {
    const clock = fakeClock();
    const engine = createVisibilityEngine({ policy: allowAll, ttlMs: 30_000, now: clock.now });
    const snap = snapshot(4, 'h1');

    await engine.visibleOperations({ snapshot: snap, principal });
    expect(engine.evaluationCount).toBe(4);

    clock.advance(29_999);
    await engine.visibleOperations({ snapshot: snap, principal });
    expect(engine.evaluationCount).toBe(4); // still inside the window

    clock.advance(1);
    await engine.visibleOperations({ snapshot: snap, principal });
    expect(engine.evaluationCount).toBe(8); // boundary reached
  });

  it('ttlMs of 0 disables caching', async () => {
    const engine = createVisibilityEngine({ policy: allowAll, ttlMs: 0 });
    const snap = snapshot(3, 'h1');

    await engine.visibleOperations({ snapshot: snap, principal });
    await engine.visibleOperations({ snapshot: snap, principal });

    expect(engine.evaluationCount).toBe(6);
  });

  it('caches anonymous callers under a single key', async () => {
    const engine = createVisibilityEngine({ policy: allowAll });
    const snap = snapshot(3, 'h1');

    await engine.visibleOperations({ snapshot: snap });
    await engine.visibleOperations({ snapshot: snap });

    expect(engine.evaluationCount).toBe(3);
  });

  it('bounds cache size so many identities cannot grow it without limit', async () => {
    const engine = createVisibilityEngine({ policy: allowAll, maxEntries: 3 });
    const snap = snapshot(1, 'h1');

    for (let i = 0; i < 10; i++) {
      await engine.visibleOperations({ snapshot: snap, principal: { id: `u${i}`, type: 'user' } });
    }
    expect(engine.evaluationCount).toBe(10);

    // The earliest identities were evicted, so they re-evaluate...
    await engine.visibleOperations({ snapshot: snap, principal: { id: 'u0', type: 'user' } });
    expect(engine.evaluationCount).toBe(11);

    // ...while the most recent is still cached.
    await engine.visibleOperations({ snapshot: snap, principal: { id: 'u9', type: 'user' } });
    expect(engine.evaluationCount).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('metrics', () => {
  const principal: Principal = { id: 'SENSITIVE-USER-ID-do-not-leak', type: 'user' };

  it('records one decision per evaluated operation, labelled by phase and effect', async () => {
    const metrics = countingMetrics();
    await createVisibilityEngine({ policy: denyOdd, metrics }).visibleOperations({
      snapshot: snapshot(4, 'h1'),
    });

    expect(metrics.seen).toHaveLength(4);
    expect(metrics.seen.every(([phase]) => phase === 'discovery')).toBe(true);
    expect(metrics.seen.filter(([, effect]) => effect === 'allow')).toHaveLength(2);
    expect(metrics.seen.filter(([, effect]) => effect === 'deny')).toHaveLength(2);
  });

  it('records deny when a policy throws', async () => {
    const metrics = countingMetrics();
    const thrower: Policy = { id: 't', evaluate: () => Promise.reject(new Error('boom')) };

    await createVisibilityEngine({ policy: thrower, metrics }).visibleOperations({
      snapshot: snapshot(2, 'h1'),
    });

    expect(metrics.seen).toEqual([
      ['discovery', 'deny'],
      ['discovery', 'deny'],
    ]);
  });

  it('emits nothing on a cache hit — a cached decision was not made again', async () => {
    const metrics = countingMetrics();
    const engine = createVisibilityEngine({ policy: allowAll, metrics });
    const snap = snapshot(5, 'h1');

    await engine.visibleOperations({ snapshot: snap, principal });
    await engine.visibleOperations({ snapshot: snap, principal });

    // Counting a cache hit would inflate the metric with decisions that never
    // happened, and make the counter useless for measuring policy cost.
    expect(metrics.seen).toHaveLength(5);
  });

  it('no principal identifier can reach the metric sink', async () => {
    const metrics = countingMetrics();
    await createVisibilityEngine({ policy: allowAll, metrics }).visibleOperations({
      snapshot: snapshot(3, 'h1'),
      principal,
    });

    // §9.2 forbids principal-identifying labels. The interface has nowhere to
    // put one, and this asserts that stays true.
    expect(JSON.stringify(metrics.seen)).not.toContain('SENSITIVE-USER-ID');
  });
});
