/**
 * Stage 3 wiring — the policy engine inside the dispatch envelope.
 *
 * The engine's own behaviour is covered in policy/__tests__/authorization.
 * These tests are about the seam: that stage 3 actually consults the policy,
 * that a denial stops the pipeline before anything executes, that clientInfo
 * survives the trip, and that a hook cannot get in front of a policy denial.
 */

import { describe, it, expect } from '@jest/globals';
import { createDispatcher } from '../index.js';
import { AtomicRegistryReference } from '../../registry-reference.js';
import { createAuthorizationEngine } from '../../policy/authorization.js';
import { createConfirmationRegistry } from '../../policy/confirmation.js';
import { allOf } from '../../policy/combinators.js';
import { authenticated, confirmationForEffects } from '../../policy/builtins.js';
import type { DispatcherHooks } from '../types.js';
import type { Policy, PolicyContext } from '../../policy/types.js';
import type {
  EffectClassification,
  OperationDefinition,
  OperationResult,
  RegistrySnapshot,
} from '../../types.js';

function snapshot(classifications: readonly EffectClassification[] = []): RegistrySnapshot {
  const op: OperationDefinition = {
    id: 'transferFunds',
    name: 'transferFunds',
    description: 'Move money',
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: false,
      idempotent: false,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications,
    },
    executor: { type: 'stub' },
  };
  return { version: 1, hash: 'h1', createdAt: new Date(0), operations: new Map([[op.id, op]]) };
}

function executed() {
  const calls: unknown[] = [];
  return {
    calls,
    executors: new Map([
      [
        'stub',
        {
          execute: async (_op: OperationDefinition, input: unknown) => {
            calls.push(input);
            return { ok: true as const, value: { done: true } };
          },
        },
      ],
    ]),
  };
}

function command(overrides?: Record<string, unknown>) {
  return {
    requestId: 'r1',
    operationId: 'transferFunds',
    input: { amount: 10 },
    deadline: new Date(Date.now() + 30_000),
    signal: new AbortController().signal,
    registryHash: 'h1',
    ...overrides,
  };
}

const denyAll: Policy = {
  id: 'denyAll',
  evaluate: () =>
    Promise.resolve({ effect: 'deny', code: 'FORBIDDEN', safeReason: 'nope', evidence: [] }),
};

const allowAll: Policy = {
  id: 'allowAll',
  evaluate: () => Promise.resolve({ effect: 'allow', evidence: [] }),
};

describe('stage 3 policy authorization', () => {
  it('a denial returns FORBIDDEN and never reaches the executor', async () => {
    const { calls, executors } = executed();
    const dispatcher = createDispatcher(
      new AtomicRegistryReference(snapshot()),
      {},
      executors,
      { authorization: createAuthorizationEngine({ policy: denyAll }) },
    );

    const result = await dispatcher.dispatch(command());

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(result.error?.message).toBe('nope');
    // The point of a security boundary: nothing ran.
    expect(calls).toHaveLength(0);
  });

  it('an allow proceeds to execution', async () => {
    const { calls, executors } = executed();
    const dispatcher = createDispatcher(
      new AtomicRegistryReference(snapshot()),
      {},
      executors,
      { authorization: createAuthorizationEngine({ policy: allowAll }) },
    );

    const result = await dispatcher.dispatch(command());

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('without an authorization engine the dispatcher behaves as before', async () => {
    const { calls, executors } = executed();
    const dispatcher = createDispatcher(new AtomicRegistryReference(snapshot()), {}, executors);

    const result = await dispatcher.dispatch(command());

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('a permissive hook cannot get in front of a policy denial', async () => {
    // If it could, configuring a hook would silently disable the security
    // boundary — the one thing a hook must never be able to do.
    const { calls, executors } = executed();
    const hooks: DispatcherHooks = { authorize: async () => ({ continue: true }) };

    const dispatcher = createDispatcher(
      new AtomicRegistryReference(snapshot()),
      hooks,
      executors,
      { authorization: createAuthorizationEngine({ policy: denyAll }) },
    );

    const result = await dispatcher.dispatch(command());

    expect(result.error?.code).toBe('FORBIDDEN');
    expect(calls).toHaveLength(0);
  });

  it('carries clientInfo from the command through to the policy', async () => {
    // Previously dropped between OperationCommand and DispatchContext.
    const seen: PolicyContext[] = [];
    const recorder: Policy = {
      id: 'recorder',
      evaluate: (ctx) => {
        seen.push(ctx);
        return Promise.resolve({ effect: 'allow', evidence: [] });
      },
    };

    const { executors } = executed();
    const dispatcher = createDispatcher(
      new AtomicRegistryReference(snapshot()),
      {},
      executors,
      { authorization: createAuthorizationEngine({ policy: recorder }) },
    );

    await dispatcher.dispatch(command({ clientInfo: { name: 'claude', version: '1.2.3' } }));

    expect(seen[0]?.clientInfo).toEqual({ name: 'claude', version: '1.2.3' });
  });

  it('authorizes with the actual input, before stage 4 validation', async () => {
    const seen: PolicyContext[] = [];
    const recorder: Policy = {
      id: 'recorder',
      evaluate: (ctx) => {
        seen.push(ctx);
        return Promise.resolve({ effect: 'allow', evidence: [] });
      },
    };

    const { executors } = executed();
    const dispatcher = createDispatcher(
      new AtomicRegistryReference(snapshot()),
      {},
      executors,
      { authorization: createAuthorizationEngine({ policy: recorder }) },
    );

    await dispatcher.dispatch(command({ input: { amount: 4242 } }));

    expect(seen[0]?.input).toEqual({ amount: 4242 });
    expect(seen[0]?.phase).toBe('invocation');
  });

  it('a policy denial is audited', async () => {
    // Stage 11 only ever ran on the success path, so a refusal left no trace —
    // the one event an audit log most needs to contain.
    const audited: OperationResult[] = [];
    const hooks: DispatcherHooks = {
      audit: async (_ctx, result) => {
        audited.push(result);
      },
    };

    const { executors } = executed();
    const dispatcher = createDispatcher(
      new AtomicRegistryReference(snapshot()),
      hooks,
      executors,
      { authorization: createAuthorizationEngine({ policy: denyAll }) },
    );

    await dispatcher.dispatch(command());

    expect(audited).toHaveLength(1);
    expect(audited[0]?.ok).toBe(false);
  });

  it('runs the confirmation round trip end to end through dispatch', async () => {
    const confirmations = createConfirmationRegistry({ nonce: () => 'fixed-nonce' });
    const policy = allOf([authenticated(), confirmationForEffects(['financial'])]);
    const { calls, executors } = executed();

    const dispatcher = createDispatcher(
      new AtomicRegistryReference(snapshot(['financial'] as readonly EffectClassification[])),
      { authenticate: async () => ({ id: 'u1', type: 'user' }) },
      executors,
      { authorization: createAuthorizationEngine({ policy, confirmations }) },
    );

    const first = await dispatcher.dispatch(command());
    expect(first.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(calls).toHaveLength(0);

    const second = await dispatcher.dispatch(
      command({
        confirmation: { challengeId: 'fixed-nonce', response: 'yes', confirmedAt: new Date(0) },
      }),
    );
    expect(second.isError).toBe(false);
    expect(calls).toHaveLength(1);

    // ...and the same proof a second time is refused.
    const replay = await dispatcher.dispatch(
      command({
        confirmation: { challengeId: 'fixed-nonce', response: 'yes', confirmedAt: new Date(0) },
      }),
    );
    expect(replay.error?.code).toBe('FORBIDDEN');
    expect(calls).toHaveLength(1);
  });
});
