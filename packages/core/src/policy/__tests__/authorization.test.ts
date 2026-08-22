/**
 * Call-time authorization tests.
 *
 * This is the security boundary, so the cases that matter most are the ones
 * where something must NOT happen: a stale allow must not survive, a spent
 * confirmation must not work twice, and a proof must not be portable between
 * callers, operations or inputs.
 */

import { describe, it, expect } from '@jest/globals';
import { createAuthorizationEngine, inputHash } from '../authorization.js';
import { createConfirmationRegistry } from '../confirmation.js';
import { createVisibilityEngine } from '../visibility.js';
import { allOf } from '../combinators.js';
import { authenticated, confirmationForEffects } from '../builtins.js';
import type { Policy, PolicyContext, PolicyDecision } from '../types.js';
import type {
  ConfirmationProof,
  EffectClassification,
  OperationDefinition,
  Principal,
  RegistrySnapshot,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function operation(
  id = 'transferFunds',
  classifications: readonly EffectClassification[] = [],
): OperationDefinition {
  return {
    id,
    name: id,
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
    executor: { type: 'test' },
  };
}

function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** Deterministic nonces, so a test can name the challenge it expects. */
function seqNonce() {
  let n = 0;
  return () => `nonce-${++n}`;
}

const principal: Principal = { id: 'u1', type: 'user', permissions: ['payments:write'] };

const allowAll: Policy = {
  id: 'allowAll',
  evaluate: () => Promise.resolve({ effect: 'allow', evidence: [] }),
};

const denyAll: Policy = {
  id: 'denyAll',
  evaluate: () =>
    Promise.resolve({
      effect: 'deny',
      code: 'FORBIDDEN',
      safeReason: 'not permitted here',
      evidence: [],
    }),
};

function request(overrides?: Record<string, unknown>) {
  return {
    operation: operation(),
    registryHash: 'h1',
    input: { amount: 10 },
    principal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Decision handling
// ---------------------------------------------------------------------------

describe('decision handling', () => {
  it('allow proceeds', async () => {
    const engine = createAuthorizationEngine({ policy: allowAll });
    expect(await engine.authorize(request())).toEqual({ kind: 'allow' });
  });

  it('deny returns FORBIDDEN carrying the policy safeReason', async () => {
    const engine = createAuthorizationEngine({ policy: denyAll });
    const outcome = await engine.authorize(request());

    expect(outcome.kind).toBe('deny');
    expect(outcome.kind === 'deny' && outcome.error.code).toBe('FORBIDDEN');
    expect(outcome.kind === 'deny' && outcome.error.message).toBe('not permitted here');
  });

  it('deny does NOT leak the evidence list to the caller', async () => {
    // Evidence is for the audit trail and Explorer. safeReason is the field
    // its author marked as fit to cross a trust boundary; the rest is not.
    const chatty: Policy = {
      id: 'chatty',
      evaluate: () =>
        Promise.resolve({
          effect: 'deny',
          code: 'FORBIDDEN',
          safeReason: 'nope',
          evidence: [{ policyId: 'chatty', claim: 'INTERNAL-DETAIL-do-not-ship' }],
        }),
    };

    const outcome = await createAuthorizationEngine({ policy: chatty }).authorize(request());
    expect(JSON.stringify(outcome)).not.toContain('INTERNAL-DETAIL');
  });

  it('evaluates at phase "invocation" WITH the actual input', async () => {
    const seen: PolicyContext[] = [];
    const recorder: Policy = {
      id: 'recorder',
      evaluate: (ctx) => {
        seen.push(ctx);
        return Promise.resolve({ effect: 'allow', evidence: [] });
      },
    };

    await createAuthorizationEngine({ policy: recorder }).authorize(
      request({ input: { amount: 4242 } }),
    );

    expect(seen[0]?.phase).toBe('invocation');
    expect(seen[0]?.input).toEqual({ amount: 4242 });
  });

  it('input-dependent denial works on the real input', async () => {
    const limit: Policy = {
      id: 'limit',
      evaluate: (ctx): Promise<PolicyDecision> => {
        const amount = (ctx.input as { amount?: number } | undefined)?.amount ?? 0;
        return Promise.resolve(
          amount > 1000
            ? { effect: 'deny', code: 'FORBIDDEN', safeReason: 'over limit', evidence: [] }
            : { effect: 'allow', evidence: [] },
        );
      },
    };

    const engine = createAuthorizationEngine({ policy: limit });

    expect((await engine.authorize(request({ input: { amount: 999 } }))).kind).toBe('allow');
    expect((await engine.authorize(request({ input: { amount: 1001 } }))).kind).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Failing closed
// ---------------------------------------------------------------------------

describe('failing closed', () => {
  it('a policy that throws denies', async () => {
    const thrower: Policy = { id: 't', evaluate: () => Promise.reject(new Error('boom')) };
    const outcome = await createAuthorizationEngine({ policy: thrower }).authorize(request());

    expect(outcome.kind).toBe('deny');
    expect(outcome.kind === 'deny' && outcome.error.code).toBe('FORBIDDEN');
  });

  it('a policy returning an unrecognised shape denies', async () => {
    const nonsense = {
      id: 'n',
      evaluate: () => Promise.resolve({ effect: 'probably' }),
    } as unknown as Policy;

    expect((await createAuthorizationEngine({ policy: nonsense }).authorize(request())).kind).toBe(
      'deny',
    );
  });

  it('a thrown error message never reaches the caller', async () => {
    const leaky: Policy = {
      id: 'leaky',
      evaluate: () => {
        throw new Error('failed processing PAYLOAD-SENTINEL-9z8y');
      },
    };

    const outcome = await createAuthorizationEngine({ policy: leaky }).authorize(request());
    expect(JSON.stringify(outcome)).not.toContain('PAYLOAD-SENTINEL');
  });
});

// ---------------------------------------------------------------------------
// Time of check / time of use
// ---------------------------------------------------------------------------

describe('time-of-check / time-of-use', () => {
  it('an operation visible at discovery is still denied at call time when the policy flips', async () => {
    // The whole reason call-time authorization exists. Discovery said yes;
    // between then and the call the answer changed, and the call must lose.
    let allow = true;
    const flipping: Policy = {
      id: 'flipping',
      evaluate: () =>
        Promise.resolve(
          allow
            ? { effect: 'allow', evidence: [] }
            : { effect: 'deny', code: 'FORBIDDEN', safeReason: 'revoked', evidence: [] },
        ),
    };

    const op = operation();
    const snapshot: RegistrySnapshot = {
      version: 1,
      hash: 'h1',
      createdAt: new Date(0),
      operations: new Map([[op.id, op]]),
    };

    const visibility = createVisibilityEngine({ policy: flipping });
    const visible = await visibility.visibleOperations({ snapshot, principal });
    expect(visible).toHaveLength(1);

    allow = false;

    const outcome = await createAuthorizationEngine({ policy: flipping }).authorize(request());
    expect(outcome.kind).toBe('deny');
  });

  it('call-time authorization never serves a cached decision', async () => {
    // A cache here would be a promise that a past answer is still good, which
    // is the exact claim this stage exists to refuse.
    let calls = 0;
    const counting: Policy = {
      id: 'counting',
      evaluate: () => {
        calls++;
        return Promise.resolve({ effect: 'allow', evidence: [] });
      },
    };

    const engine = createAuthorizationEngine({ policy: counting });
    await engine.authorize(request());
    await engine.authorize(request());
    await engine.authorize(request());

    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

describe('confirmation', () => {
  const financial = operation('transferFunds', ['financial'] as readonly EffectClassification[]);
  const policy = allOf([authenticated(), confirmationForEffects(['financial'])]);

  function engineWith(clock = fakeClock(), nonce = seqNonce()) {
    const confirmations = createConfirmationRegistry({ now: clock.now, nonce });
    return { clock, engine: createAuthorizationEngine({ policy, confirmations }), confirmations };
  }

  const proofFor = (challengeId: string): ConfirmationProof => ({
    challengeId,
    response: 'yes',
    confirmedAt: new Date(0),
  });

  it('first call returns CONFIRMATION_REQUIRED with a challenge', async () => {
    const { engine } = engineWith();
    const outcome = await engine.authorize(request({ operation: financial }));

    expect(outcome.kind).toBe('confirmation_required');
    expect(outcome.kind === 'confirmation_required' && outcome.error.code).toBe(
      'CONFIRMATION_REQUIRED',
    );
    expect(outcome.kind === 'confirmation_required' && outcome.challenge.id).toBe('nonce-1');
  });

  it('the challenge id is the nonce, not the policy-derived id', async () => {
    // confirmationForEffects derives `confirm:<op>:<classifications>`, which any
    // caller can compute. A challenge you can guess is not a challenge.
    const { engine } = engineWith();
    const outcome = await engine.authorize(request({ operation: financial }));

    expect(outcome.kind === 'confirmation_required' && outcome.challenge.id).not.toContain(
      'confirm:transferFunds',
    );
  });

  it('second call with a valid proof succeeds', async () => {
    const { engine } = engineWith();
    const first = await engine.authorize(request({ operation: financial }));
    const id = first.kind === 'confirmation_required' ? first.challenge.id : '';

    const second = await engine.authorize(
      request({ operation: financial, confirmation: proofFor(id) }),
    );
    expect(second.kind).toBe('allow');
  });

  it('REPLAY: reusing a spent confirmation is denied', async () => {
    const { engine } = engineWith();
    const first = await engine.authorize(request({ operation: financial }));
    const id = first.kind === 'confirmation_required' ? first.challenge.id : '';

    expect((await engine.authorize(request({ operation: financial, confirmation: proofFor(id) }))).kind).toBe('allow');

    const replayed = await engine.authorize(
      request({ operation: financial, confirmation: proofFor(id) }),
    );
    expect(replayed.kind).toBe('deny');
    expect(replayed.kind === 'deny' && replayed.error.message).toContain('unknown');
  });

  it('a forged challenge id is denied', async () => {
    const { engine } = engineWith();
    const outcome = await engine.authorize(
      request({ operation: financial, confirmation: proofFor('made-up') }),
    );
    expect(outcome.kind).toBe('deny');
  });

  it('an expired confirmation is denied', async () => {
    const { engine, clock } = engineWith();
    const first = await engine.authorize(request({ operation: financial }));
    const id = first.kind === 'confirmation_required' ? first.challenge.id : '';

    clock.advance(5 * 60_000);

    const outcome = await engine.authorize(
      request({ operation: financial, confirmation: proofFor(id) }),
    );
    expect(outcome.kind).toBe('deny');
    expect(outcome.kind === 'deny' && outcome.error.message).toContain('expired');
  });

  it('a proof issued to one caller does not work for another', async () => {
    const { engine } = engineWith();
    const first = await engine.authorize(request({ operation: financial }));
    const id = first.kind === 'confirmation_required' ? first.challenge.id : '';

    const outcome = await engine.authorize(
      request({
        operation: financial,
        confirmation: proofFor(id),
        principal: { id: 'someone-else', type: 'user', permissions: ['payments:write'] },
      }),
    );

    expect(outcome.kind).toBe('deny');
    expect(outcome.kind === 'deny' && outcome.error.message).toContain('wrong_caller');
  });

  it('a proof for one INPUT does not authorise a different one', async () => {
    // Confirm a £10 transfer, then try to spend the proof on £10,000.
    const { engine } = engineWith();
    const first = await engine.authorize(request({ operation: financial, input: { amount: 10 } }));
    const id = first.kind === 'confirmation_required' ? first.challenge.id : '';

    const outcome = await engine.authorize(
      request({ operation: financial, input: { amount: 10_000 }, confirmation: proofFor(id) }),
    );

    expect(outcome.kind).toBe('deny');
    expect(outcome.kind === 'deny' && outcome.error.message).toContain('wrong_input');
  });

  it('a proof for one OPERATION does not authorise another', async () => {
    const { engine } = engineWith();
    const first = await engine.authorize(request({ operation: financial }));
    const id = first.kind === 'confirmation_required' ? first.challenge.id : '';

    const other = operation('deleteAccount', ['financial'] as readonly EffectClassification[]);
    const outcome = await engine.authorize(
      request({ operation: other, confirmation: proofFor(id) }),
    );

    expect(outcome.kind).toBe('deny');
    expect(outcome.kind === 'deny' && outcome.error.message).toContain('wrong_operation');
  });

  it('a rejected proof does not consume the outstanding challenge', async () => {
    // Otherwise anyone could burn another caller's challenge by presenting it
    // against the wrong binding.
    const { engine, confirmations } = engineWith();
    const first = await engine.authorize(request({ operation: financial }));
    const id = first.kind === 'confirmation_required' ? first.challenge.id : '';

    await engine.authorize(
      request({
        operation: financial,
        confirmation: proofFor(id),
        principal: { id: 'attacker', type: 'user' },
      }),
    );

    // The legitimate caller can still redeem it.
    const legit = await engine.authorize(
      request({ operation: financial, confirmation: proofFor(id) }),
    );
    expect(legit.kind).toBe('allow');
    expect(confirmations.outstanding).toBe(0);
  });

  it('key order in the input does not change the binding', async () => {
    // Two spellings of the same request must confirm identically, or a client
    // that reorders keys breaks confirmation for no reason.
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
    expect(inputHash({ a: 1 })).not.toBe(inputHash({ a: 2 }));
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('metrics', () => {
  it('records phase invocation and the decision, with a duration', async () => {
    const decisions: Array<[string, string]> = [];
    const durations: Array<[string, number]> = [];

    const clock = fakeClock();
    const engine = createAuthorizationEngine({
      policy: denyAll,
      metrics: { recordDecision: (p, e) => decisions.push([p, e]) },
      timings: { recordDuration: (e, s) => durations.push([e, s]) },
      now: clock.now,
    });

    await engine.authorize(request());

    expect(decisions).toEqual([['invocation', 'deny']]);
    expect(durations).toHaveLength(1);
    expect(durations[0]?.[0]).toBe('deny');
  });

  it('carries no principal identifier into the metric sink', async () => {
    const seen: Array<[string, string]> = [];
    await createAuthorizationEngine({
      policy: allowAll,
      metrics: { recordDecision: (p, e) => seen.push([p, e]) },
    }).authorize(request({ principal: { id: 'SENSITIVE-ID-do-not-leak', type: 'user' } }));

    expect(JSON.stringify(seen)).not.toContain('SENSITIVE-ID');
  });
});
