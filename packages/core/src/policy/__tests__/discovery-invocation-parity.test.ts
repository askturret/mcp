// SPDX-License-Identifier: Apache-2.0
/**
 * @fileoverview Readiness criterion #4: policy is enforced at BOTH discovery
 * and invocation, and the two surfaces AGREE.
 *
 * ## What makes this test worth having
 *
 * The parity claim is not "the policy function is deterministic" — a pure
 * function trivially is. It is that TWO SEPARATE PRODUCTION ENGINES, reached by
 * different call paths, reach the same verdict from one `Policy`:
 *
 * - `createVisibilityEngine` (discovery / `tools/list`) — hides denied operations
 * - `createAuthorizationEngine` (invocation / `tools/call`) — refuses them
 *
 * So this test imports and drives both real engines. It deliberately does NOT
 * define its own copy of the rule and assert against that — a test that
 * re-implements the decision it is checking passes even when production is
 * deleted, which is the `Transcribed Oracle` antipattern in `docs/TESTING.md`.
 * The only rule expressed here is the RELATIONSHIP between the two engines.
 *
 * ## The asymmetry the parity rule deliberately excludes
 *
 * Parity is about `deny`. `confirmation_required` is SHOWN at discovery on
 * purpose (`visibility.ts` documents why: hiding it would make a confirmable
 * operation indistinguishable from a forbidden one), so it is not a parity
 * violation and is not asserted as one here.
 */

import { describe, it, expect } from '@jest/globals';
import { createVisibilityEngine } from '../visibility.js';
import { createAuthorizationEngine } from '../authorization.js';
import type { Policy, PolicyContext, PolicyDecision } from '../types.js';
import type { OperationDefinition, RegistrySnapshot } from '../../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OPERATION_IDS = ['public-read', 'admin-delete', 'admin-reset', 'user-profile'] as const;

function operation(id: string): OperationDefinition {
  return {
    id,
    name: id,
    description: `operation ${id}`,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'test' },
  };
}

function snapshot(): RegistrySnapshot {
  const operations = new Map<string, OperationDefinition>();
  for (const id of OPERATION_IDS) operations.set(id, operation(id));
  return { version: 1, hash: 'parity-hash-0001', createdAt: new Date(0), operations };
}

/** Denies any operation whose name begins `admin`. One policy, both phases. */
const denyAdmin: Policy = {
  id: 'deny-admin',
  evaluate: (ctx: PolicyContext): Promise<PolicyDecision> =>
    Promise.resolve(
      ctx.operation.name.startsWith('admin')
        ? {
            effect: 'deny',
            code: 'SENSITIVE_OPERATION',
            safeReason: 'administrative operation',
            evidence: [],
          }
        : { effect: 'allow', evidence: [] },
    ),
};

// ---------------------------------------------------------------------------
// Drivers — each one runs the REAL engine for its phase
// ---------------------------------------------------------------------------

/** `ttlMs: 0` disables caching: this test is about parity, not about the cache. */
async function discoveryVisibleIds(policy: Policy): Promise<ReadonlySet<string>> {
  const engine = createVisibilityEngine({ policy, ttlMs: 0 });
  const visible = await engine.visibleOperations({ snapshot: snapshot() });
  return new Set(visible.map((op) => op.id));
}

async function invocationOutcomes(policy: Policy): Promise<ReadonlyMap<string, string>> {
  const engine = createAuthorizationEngine({ policy });
  const snap = snapshot();
  const outcomes = new Map<string, string>();
  for (const op of snap.operations.values()) {
    const outcome = await engine.authorize({
      operation: op,
      registryHash: snap.hash,
      input: {},
    });
    outcomes.set(op.id, outcome.kind);
  }
  return outcomes;
}

describe('Policy parity: discovery vs invocation (readiness #4)', () => {
  it('hides at discovery exactly the operations it denies at invocation', async () => {
    const visible = await discoveryVisibleIds(denyAdmin);
    const outcomes = await invocationOutcomes(denyAdmin);

    // Anti-vacuity: a fixture where nothing is allowed, or nothing is denied,
    // would satisfy the parity loop below without exercising either branch.
    const deniedCount = [...outcomes.values()].filter((k) => k === 'deny').length;
    expect(visible.size).toBeGreaterThan(0);
    expect(deniedCount).toBeGreaterThan(0);
    expect(visible.size + deniedCount).toBe(OPERATION_IDS.length);

    for (const id of OPERATION_IDS) {
      const hiddenAtDiscovery = !visible.has(id);
      const deniedAtInvocation = outcomes.get(id) === 'deny';
      // The parity invariant itself.
      expect(hiddenAtDiscovery).toBe(deniedAtInvocation);
    }
  });

  it('fails closed on BOTH surfaces when the policy throws', async () => {
    const throwing: Policy = {
      id: 'throws',
      evaluate: () => {
        throw new Error('policy exploded');
      },
    };

    const visible = await discoveryVisibleIds(throwing);
    const outcomes = await invocationOutcomes(throwing);

    // An operation whose visibility could not be determined is hidden, and an
    // operation whose authorization could not be determined is refused. If only
    // one of the two failed closed, a hidden tool would still be callable.
    expect(visible.size).toBe(0);
    for (const id of OPERATION_IDS) {
      expect(outcomes.get(id)).toBe('deny');
    }
  });

  it('agrees when the policy allows everything', async () => {
    const allowAll: Policy = {
      id: 'allow-all',
      evaluate: () => Promise.resolve({ effect: 'allow', evidence: [] }),
    };

    const visible = await discoveryVisibleIds(allowAll);
    const outcomes = await invocationOutcomes(allowAll);

    expect(visible.size).toBe(OPERATION_IDS.length);
    for (const id of OPERATION_IDS) {
      expect(outcomes.get(id)).toBe('allow');
    }
  });
});
