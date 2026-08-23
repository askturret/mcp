// SPDX-License-Identifier: Apache-2.0
/**
 * Regulated preset tests (§10.2 Regulated column, #52).
 *
 * Same two halves as the Production suite, and the same reason: a table test
 * confirms someone typed §10.2 twice, so the half that matters boots a real
 * dispatcher from the preset and checks the controls it declares actually
 * refuse things.
 *
 * The refusal tests are the third thing, and they are what §52's acceptance is
 * really about — "all refusals are boot-time, not runtime". Each one asserts
 * that expansion THROWS, which is a stronger claim than any per-call assertion
 * could make: a configuration that cannot expand cannot start a server at all.
 */

import { describe, it, expect } from '@jest/globals';

import {
  regulatedPreset,
  RegulatedPresetRefusal,
  REGULATED_BOUNDS,
  REGULATED_EVIDENCE_KIND,
} from '../regulated.js';
import { describePreset } from '../production.js';
import { createDispatcher } from '../../dispatcher/index.js';
import { AtomicRegistryReference } from '../../registry-reference.js';
import { createAuthorizationEngine } from '../../policy/authorization.js';
import { createConfirmationRegistry } from '../../policy/confirmation.js';
import type { EvidenceVerifier } from '../../policy/builtins.js';
import type { RegulatedPresetOptions } from '../types.js';
import type {
  ConfirmationProof,
  OperationDefinition,
  Principal,
  RegistrySnapshot,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A signature scheme standing in for the adopter's. */
const GOOD_SIGNATURE = 'sig:valid-approver';

const acceptGoodSignature: EvidenceVerifier = (proof) => proof.response === GOOD_SIGNATURE;

function options(overrides?: Partial<RegulatedPresetOptions>): RegulatedPresetOptions {
  return {
    auditSink: { id: 'postgres-audit', durability: 'durable' },
    customReviewAcknowledged: true,
    verifyEvidence: acceptGoodSignature,
    ...overrides,
  };
}

function operation(id: string): OperationDefinition {
  return {
    id,
    name: id,
    description: `operation ${id}`,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      // Deliberately readOnly with NO classifications. Under Production this
      // operation would need no confirmation at all; under Regulated it must,
      // which is the "explicit evidence policy (not just effect-based)" row of
      // §10.2 expressed as a fixture.
      readOnly: true,
      idempotent: true,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications: [],
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

const PRINCIPAL: Principal = { id: 'approver-1', type: 'user', permissions: ['pets:read'] };

/**
 * Boot a dispatcher wired from the Regulated preset, exactly as an adopter
 * would. Nothing special-cases the preset — the composed policy is handed over
 * like any other, which is ADR-007's requirement demonstrated rather than
 * asserted.
 */
function bootRegulated(
  snap: RegistrySnapshot,
  opts?: Partial<RegulatedPresetOptions> & { principal?: Principal },
) {
  const { principal, ...presetOverrides } = opts ?? {};
  const configuration = regulatedPreset(
    options({ permissions: { listPets: ['pets:read'] }, ...presetOverrides }),
  );

  const calls: unknown[] = [];
  const executors = new Map([
    [
      'stub',
      {
        execute: async (_op: OperationDefinition, input: unknown) => {
          calls.push(input);
          return { ok: true as const, value: { done: true } };
        },
      },
    ],
  ]);

  const dispatcher = createDispatcher(
    new AtomicRegistryReference(snap),
    principal === undefined ? {} : { authenticate: async () => principal },
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

describe('the §10.2 Regulated expansion', () => {
  it('matches the Regulated column exactly', () => {
    const { configuration } = describePreset('regulated', options());

    expect(configuration).toEqual({
      // Explicit-only on BOTH axes — Production narrows only writes.
      discovery: { readInclude: 'explicit-only', writeInclude: 'explicit-only' },
      authentication: { required: true },
      authorization: {
        callTime: true,
        policy: `allOf(authenticated, permissionPolicy, requireEvidence(${REGULATED_EVIDENCE_KIND}))`,
      },
      audit: { enabled: true, sink: null, durability: 'required' },
      outputValidation: 'strict',
      redaction: { mode: 'required', customReviewAcknowledged: true },
      reloadMode: 'fail-readiness',
      transport: { session: 'stateless' },
      bounds: { requestMaxBytes: 524288, responseMaxBytes: 1048576, deadlineMs: 20000 },
    });
  });

  it('is strictly tighter than Production on every bound', () => {
    const production = describePreset('production').configuration.bounds;
    const regulated = describePreset('regulated', options()).configuration.bounds;

    // Asserted as a relationship rather than as three more literals: the point
    // of the Regulated column is that it is stricter, and a future edit that
    // raised a Regulated bound above Production's would pass a literal table
    // test while destroying the property the table exists to express.
    expect(regulated.requestMaxBytes).toBeLessThan(production.requestMaxBytes);
    expect(regulated.responseMaxBytes).toBeLessThan(production.responseMaxBytes);
    expect(regulated.deadlineMs).toBeLessThan(production.deadlineMs);
    expect(regulated).toEqual({ ...REGULATED_BOUNDS });
  });

  it('names its pending controls rather than implying they are enforced', () => {
    const { pending } = describePreset('regulated', options());

    // Selecting a stricter preset does not make an unenforced control
    // enforced. The list must say so, and specifically must name reloadMode:
    // fail-readiness is a new mode no controller implements yet.
    expect(pending.map((p) => p.control)).toContain('reloadMode');
    expect(pending.map((p) => p.control)).toContain('discovery.readInclude');
    expect(pending.every((p) => p.detail.length > 0 && p.trackedBy > 0)).toBe(true);
  });

  it('stays JSON-safe and deterministic, like the Production description', () => {
    const a = JSON.stringify(describePreset('regulated', options()));
    const b = JSON.stringify(describePreset('regulated', options()));

    expect(a).toBe(b);
    // The composed policy is a closure; JSON.stringify would silently drop its
    // methods. The summary must carry the tree as text instead.
    expect(JSON.parse(a).configuration.authorization.policy).toContain('requireEvidence');
  });
});

// ---------------------------------------------------------------------------
// Boot-time refusals (§52 acceptance)
// ---------------------------------------------------------------------------

describe('boot-time refusals', () => {
  it('refuses a stdout audit sink', () => {
    expect(() => regulatedPreset(options({ auditSink: { id: 'stdout', durability: 'stdout' } })))
      .toThrow(RegulatedPresetRefusal);
  });

  it('refuses an in-memory audit sink', () => {
    expect(() =>
      regulatedPreset(options({ auditSink: { id: 'ring-buffer', durability: 'memory' } })),
    ).toThrow(RegulatedPresetRefusal);
  });

  it('names the offending sink and the control, so the error is actionable', () => {
    try {
      regulatedPreset(options({ auditSink: { id: 'stdout', durability: 'stdout' } }));
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(RegulatedPresetRefusal);
      const refusal = error as RegulatedPresetRefusal;
      // `control` is the stable field; the message is not contractual.
      expect(refusal.control).toBe('audit.durability');
      expect(refusal.message).toContain('stdout');
    }
  });

  it('accepts a sink that declares durability', () => {
    expect(() => regulatedPreset(options())).not.toThrow();
  });

  it('refuses when customReviewAcknowledged is false', () => {
    expect(() => regulatedPreset(options({ customReviewAcknowledged: false }))).toThrow(
      RegulatedPresetRefusal,
    );
  });

  it('refuses when customReviewAcknowledged is omitted entirely', () => {
    // Omission and explicit `false` must behave identically. An adopter who
    // never saw the field has not reviewed anything, which is the same state
    // as one who set it false — and a preset that accepted the default would
    // make the acknowledgement opt-in, defeating it.
    const { customReviewAcknowledged: _omitted, ...withoutAck } = options();
    expect(() => regulatedPreset(withoutAck as RegulatedPresetOptions)).toThrow(
      RegulatedPresetRefusal,
    );
  });

  it('refuses when no evidence verifier is supplied', () => {
    // NOTE: this is a THIRD refusal, beyond §52's two named ones. Flagged
    // deliberately for review rather than added silently — see the PR. The
    // reasoning: a missing verifier has no safe default, since accepting every
    // proof makes the evidence policy decorative and rejecting every proof
    // turns each guarded call into a runtime denial an operator must debug
    // from behaviour.
    const { verifyEvidence: _omitted, ...withoutVerifier } = options();
    expect(() => regulatedPreset(withoutVerifier as RegulatedPresetOptions)).toThrow(
      RegulatedPresetRefusal,
    );
  });

  it('reports the audit sink before the acknowledgement when both are wrong', () => {
    try {
      regulatedPreset(
        options({
          auditSink: { id: 'stdout', durability: 'stdout' },
          customReviewAcknowledged: false,
        }),
      );
      throw new Error('expected a refusal');
    } catch (error) {
      // Ordering is deliberate: the structural problem first, so an adopter
      // fixing several is not sent to the checkbox before the sink.
      expect((error as RegulatedPresetRefusal).control).toBe('audit.durability');
    }
  });
});

// ---------------------------------------------------------------------------
// The controls actually bite (the half a table test cannot reach)
// ---------------------------------------------------------------------------

describe('the preset enforces what it declares', () => {
  it('denies an unauthenticated call', async () => {
    const { dispatcher, calls } = bootRegulated(snapshot(operation('listPets')));

    const result = await dispatcher.dispatch(command('listPets'));

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('requires confirmation even for an operation with NO risky classifications', async () => {
    const { dispatcher, calls } = bootRegulated(snapshot(operation('listPets')), {
      principal: PRINCIPAL,
    });

    const result = await dispatcher.dispatch(command('listPets'));

    // This is the §10.2 "explicit evidence policy (not just effect-based)" row.
    // The fixture is read-only and unclassified, so `confirmationForEffects`
    // would have allowed it outright — the Production preset does exactly that.
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('refuses an UNSIGNED confirmation', async () => {
    const { dispatcher, calls } = bootRegulated(snapshot(operation('listPets')), {
      principal: PRINCIPAL,
    });

    const issued = await dispatcher.dispatch(command('listPets'));
    const challenge = (issued.error?.details as { challenge?: { id: string } } | undefined)
      ?.challenge;

    const unsigned: ConfirmationProof = {
      challengeId: challenge?.id ?? 'fixed-nonce',
      response: 'i-agree',
      confirmedAt: new Date(),
    };

    const result = await dispatcher.dispatch(command('listPets', { confirmation: unsigned }));

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('allows a correctly SIGNED confirmation', async () => {
    const { dispatcher, calls } = bootRegulated(snapshot(operation('listPets')), {
      principal: PRINCIPAL,
    });

    const issued = await dispatcher.dispatch(command('listPets'));
    const challenge = (issued.error?.details as { challenge?: { id: string } } | undefined)
      ?.challenge;
    expect(challenge?.id).toBeDefined();

    const signed: ConfirmationProof = {
      challengeId: challenge?.id as string,
      response: GOOD_SIGNATURE,
      confirmedAt: new Date(),
    };

    const result = await dispatcher.dispatch(command('listPets', { confirmation: signed }));

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('still consumes the challenge — a valid signature is not a reusable key', async () => {
    const { dispatcher, calls } = bootRegulated(snapshot(operation('listPets')), {
      principal: PRINCIPAL,
    });

    const issued = await dispatcher.dispatch(command('listPets'));
    const challenge = (issued.error?.details as { challenge?: { id: string } } | undefined)
      ?.challenge;

    const signed: ConfirmationProof = {
      challengeId: challenge?.id as string,
      response: GOOD_SIGNATURE,
      confirmedAt: new Date(),
    };

    const first = await dispatcher.dispatch(command('listPets', { confirmation: signed }));
    const second = await dispatcher.dispatch(command('listPets', { confirmation: signed }));

    // The load-bearing assertion for `requireEvidence`'s design. It returns
    // confirmation_required even when the signature verifies, precisely so the
    // engine still redeems the proof — binding, freshness and single use. Had
    // it returned `allow` on a valid signature, redemption would be skipped and
    // this second call would succeed, turning one signature into a permanent
    // key.
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('denies a caller lacking the required permission, signature or not', async () => {
    const { dispatcher, calls } = bootRegulated(snapshot(operation('listPets')), {
      principal: { id: 'nobody', type: 'user', permissions: [] },
    });

    const result = await dispatcher.dispatch(command('listPets'));

    // permissionPolicy runs inside the same allOf, so evidence never gets the
    // chance to rescue an unauthorised caller.
    expect(result.isError).toBe(true);
    expect(result.error?.code).not.toBe('CONFIRMATION_REQUIRED');
    expect(calls).toHaveLength(0);
  });
});
