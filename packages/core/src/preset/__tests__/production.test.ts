/**
 * Production preset tests.
 *
 * Two halves, and the second is the one that matters. The first asserts the
 * expansion matches §10.2 — that is a table, and a table test can only ever
 * confirm someone typed it twice. The second boots a real dispatcher with the
 * preset and checks that the controls it declares actually refuse things.
 *
 * A preset that describes itself correctly and enforces nothing would pass
 * every test in the first half.
 */

import { describe, it, expect } from '@jest/globals';
import {
  describePreset,
  presetTransportBounds,
  productionPreset,
  PRODUCTION_BOUNDS,
} from '../production.js';
import { createDispatcher } from '../../dispatcher/index.js';
import { AtomicRegistryReference } from '../../registry-reference.js';
import { createAuthorizationEngine } from '../../policy/authorization.js';
import { createConfirmationRegistry } from '../../policy/confirmation.js';
import type {
  EffectClassification,
  OperationDefinition,
  Principal,
  RegistrySnapshot,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function operation(
  id: string,
  classifications: readonly EffectClassification[] = [],
): OperationDefinition {
  return {
    id,
    name: id,
    description: `operation ${id}`,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: classifications.length === 0,
      idempotent: false,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications,
    },
    executor: { type: 'stub' },
  };
}

function snapshot(...ops: OperationDefinition[]): RegistrySnapshot {
  return {
    version: 1,
    hash: 'h1',
    createdAt: new Date(0),
    operations: new Map(ops.map((o) => [o.id, o])),
  };
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

function command(operationId: string, overrides?: Record<string, unknown>) {
  return {
    requestId: 'r1',
    operationId,
    input: { amount: 10 },
    deadline: new Date(Date.now() + 30_000),
    signal: new AbortController().signal,
    registryHash: 'h1',
    ...overrides,
  };
}

/**
 * Boot a dispatcher wired from the preset, exactly as an adopter would.
 *
 * Nothing here special-cases "production" — the dispatcher is handed the
 * preset's composed policy like any other. That is ADR-007's no-divergent-code-
 * paths requirement demonstrated rather than asserted.
 */
function bootWithPreset(
  snap: RegistrySnapshot,
  opts?: { permissions?: Record<string, readonly string[]>; principal?: Principal },
) {
  const configuration = productionPreset(
    opts?.permissions === undefined ? {} : { permissions: opts.permissions },
  );
  const { calls, executors } = executed();

  const dispatcher = createDispatcher(
    new AtomicRegistryReference(snap),
    opts?.principal === undefined
      ? {}
      : { authenticate: async () => opts.principal as Principal },
    executors,
    {
      authorization: createAuthorizationEngine({
        policy: configuration.authorization.policy,
        confirmations: createConfirmationRegistry({ nonce: () => 'fixed-nonce' }),
      }),
    },
  );

  return { dispatcher, calls, configuration };
}

// ---------------------------------------------------------------------------
// The §10.2 expansion
// ---------------------------------------------------------------------------

describe('the §10.2 expansion', () => {
  it('matches the Production column exactly', () => {
    const { configuration } = describePreset('production');

    expect(configuration).toEqual({
      discovery: { readInclude: 'tagged-only', writeInclude: 'explicit-only' },
      authentication: { required: true },
      authorization: {
        callTime: true,
        policy:
          'allOf(authenticated, permissionPolicy, confirmationForEffects(financial, destructive))',
      },
      // `durability` and the redaction object arrived with the Regulated
      // preset (#52). Production's meaning is unchanged — audit enabled with no
      // durability requirement, redaction required — but all three presets must
      // produce ONE shape, or ADR-007's "no divergent code paths" would hold
      // only for the presets that happened to be scalars.
      audit: { enabled: true, sink: null, durability: 'optional' },
      outputValidation: 'strict',
      redaction: { mode: 'required', customReviewAcknowledged: false },
      reloadMode: 'degraded',
      transport: { session: 'stateless' },
      bounds: { requestMaxBytes: 1048576, responseMaxBytes: 4194304, deadlineMs: 30000 },
    });
  });

  it('is JSON-safe and deterministic', () => {
    // Doctor stringifies its whole result and pins determinism across runs, so
    // a description containing a closure or a timestamp would break it.
    const a = JSON.stringify(describePreset('production'));
    const b = JSON.stringify(describePreset('production'));

    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual(describePreset('production'));
  });

  it('names the composed policy tree rather than emitting an empty object', () => {
    // JSON.stringify of a Policy silently drops `evaluate` and yields {"id":…}.
    // The describe path carries the structural id instead.
    const described = describePreset('production').configuration.authorization.policy;
    expect(described).toContain('authenticated');
    expect(described).toContain('permissionPolicy');
    expect(described).toContain('confirmationForEffects');
  });

  it('declares every control that is not yet enforced', () => {
    const { pending } = describePreset('production');
    const controls = pending.map((p) => p.control);

    expect(controls).toContain('audit.sink');
    expect(controls).toContain('redaction');
    expect(controls).toContain('outputValidation');
    expect(controls).toContain('reloadMode');
    expect(pending.every((p) => typeof p.trackedBy === 'number' && p.detail.length > 0)).toBe(true);
  });

  it('maps bounds onto the names the transport actually uses', () => {
    // §10.2 says requestMaxBytes; HttpTransportOptions says maxRequestBodySize.
    // An unmapped field would be accepted and silently ignored, leaving the
    // default in place while the operator believed otherwise.
    expect(presetTransportBounds(productionPreset())).toEqual({
      maxRequestBodySize: PRODUCTION_BOUNDS.requestMaxBytes,
      maxResponseSize: PRODUCTION_BOUNDS.responseMaxBytes,
      deadlineMs: PRODUCTION_BOUNDS.deadlineMs,
    });
  });

  it('raises only the response cap, leaving the attacker-controlled one alone', () => {
    // The transport defaults are 1 MiB / 1 MiB / 30s.
    expect(PRODUCTION_BOUNDS.requestMaxBytes).toBe(1048576);
    expect(PRODUCTION_BOUNDS.responseMaxBytes).toBe(4194304);
    expect(PRODUCTION_BOUNDS.deadlineMs).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// What the preset actually enforces
// ---------------------------------------------------------------------------

describe('authentication required', () => {
  it('refuses a call with no principal', async () => {
    const { dispatcher, calls } = bootWithPreset(snapshot(operation('listPets')));

    const result = await dispatcher.dispatch(command('listPets'));

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);

    // NOTE: the code is FORBIDDEN, not UNAUTHENTICATED, even though
    // `authenticated()` produces the latter. #35 specified that every policy
    // denial maps to FORBIDDEN, so the authorization engine collapses the
    // policy's own code.
    //
    // Pinned as-is rather than "fixed" here: changing it means changing merged,
    // QA'd behaviour from another issue. But it is worth surfacing, because the
    // two codes call for different client behaviour — retry with credentials
    // versus do not retry — and only the message currently distinguishes them.
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(result.error?.message).toContain('authenticated caller');
  });

  it('still refuses when a principal exists but holds no grant', async () => {
    // permissionPolicy denies unlisted operations, so authentication alone is
    // not enough — which is the point of composing the two.
    const { dispatcher, calls } = bootWithPreset(snapshot(operation('listPets')), {
      principal: { id: 'u1', type: 'user' },
    });

    const result = await dispatcher.dispatch(command('listPets'));

    expect(result.error?.code).toBe('FORBIDDEN');
    expect(calls).toHaveLength(0);
  });

  it('with no permissions configured, the preset authorises NOTHING', async () => {
    // Stated as a test because it is a deliberate posture, not an oversight: a
    // security preset should make you declare what is allowed rather than ship
    // open and rely on you remembering to close it.
    const { dispatcher, calls } = bootWithPreset(
      snapshot(operation('a'), operation('b'), operation('c')),
      { principal: { id: 'u1', type: 'user', permissions: ['anything'] } },
    );

    for (const id of ['a', 'b', 'c']) {
      expect((await dispatcher.dispatch(command(id))).error?.code).toBe('FORBIDDEN');
    }
    expect(calls).toHaveLength(0);
  });

  it('permits a granted operation for a granted principal', async () => {
    const { dispatcher, calls } = bootWithPreset(snapshot(operation('listPets')), {
      permissions: { listPets: ['pets:read'] },
      principal: { id: 'u1', type: 'user', permissions: ['pets:read'] },
    });

    const result = await dispatcher.dispatch(command('listPets'));

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('confirmation for risky effects', () => {
  const financial = operation('transferFunds', ['financial'] as readonly EffectClassification[]);

  function bootFinancial() {
    return bootWithPreset(snapshot(financial), {
      permissions: { transferFunds: ['payments:write'] },
      principal: { id: 'u1', type: 'user', permissions: ['payments:write'] },
    });
  }

  it('returns CONFIRMATION_REQUIRED on the first attempt', async () => {
    const { dispatcher, calls } = bootFinancial();

    const result = await dispatcher.dispatch(command('transferFunds'));

    expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('proceeds once the confirmation is presented', async () => {
    const { dispatcher, calls } = bootFinancial();

    await dispatcher.dispatch(command('transferFunds'));
    const second = await dispatcher.dispatch(
      command('transferFunds', {
        confirmation: { challengeId: 'fixed-nonce', response: 'yes', confirmedAt: new Date(0) },
      }),
    );

    expect(second.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('does NOT require confirmation for an unclassified operation', async () => {
    // Otherwise the preset would be indistinguishable from "confirm everything",
    // and the classification list would not be doing any work.
    const { dispatcher } = bootWithPreset(snapshot(operation('listPets')), {
      permissions: { listPets: ['pets:read'] },
      principal: { id: 'u1', type: 'user', permissions: ['pets:read'] },
    });

    expect((await dispatcher.dispatch(command('listPets'))).isError).toBe(false);
  });

  it('confirms a destructive operation too, not just financial', async () => {
    const destructive = operation('deleteAll', ['destructive'] as readonly EffectClassification[]);
    const { dispatcher } = bootWithPreset(snapshot(destructive), {
      permissions: { deleteAll: ['admin'] },
      principal: { id: 'u1', type: 'user', permissions: ['admin'] },
    });

    expect((await dispatcher.dispatch(command('deleteAll'))).error?.code).toBe(
      'CONFIRMATION_REQUIRED',
    );
  });
});
