// SPDX-License-Identifier: Apache-2.0
/**
 * Stage 11 through the REAL dispatcher (§9.3, §48).
 *
 * §48's first acceptance test is "all decisions land in audit: deny, allow,
 * confirmation_required, success, error". Each of those is driven here by
 * making the dispatcher actually take that path, not by calling the builder
 * with a hand-written decision.
 */

import { describe, it, expect } from '@jest/globals';

import { AtomicRegistryReference } from '../../registry-reference.js';
import { createDispatcher, type DispatcherOptions } from '../../dispatcher/index.js';
import { createSnapshot } from '../../compiler/passes/freeze-and-hash.js';
import { noopTracer } from '../../telemetry/tracer.js';
import { createRecordingMetricRecorder } from '../../telemetry/metrics.js';
import { AUDIT_REGISTRY_HASH_UNRESOLVED, bufferedSink } from '../index.js';
import type { AuditEvent, AuditSink } from '../types.js';
import type { OperationDefinition, OperationResult } from '../../types.js';
import type { OperationExecutor } from '../../executor/index.js';

function operation(id = 'op'): OperationDefinition {
  return {
    id,
    name: id,
    description: id,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'test' },
  };
}

/** Collects everything the dispatcher writes. */
function collector(id = 'test-sink'): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    id,
    events,
    append: async (event) => {
      events.push(event);
    },
    flush: async () => undefined,
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    traceId: 'trace-1',
    operationId: 'op',
    input: { message: 'hello' },
    deadline: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    registryHash: 'unused',
    ...overrides,
  } as Parameters<ReturnType<typeof createDispatcher>['dispatch']>[0];
}

function harness(params: {
  readonly sink?: AuditSink;
  readonly execute?: () => Promise<OperationResult>;
  readonly options?: Partial<DispatcherOptions>;
  readonly hooks?: Record<string, unknown>;
}) {
  const executor: OperationExecutor = {
    execute: params.execute ?? (async () => ({ ok: true, value: { ok: true } })),
  };

  return createDispatcher(
    new AtomicRegistryReference(createSnapshot([operation()], 1)),
    (params.hooks ?? {}) as never,
    new Map<string, OperationExecutor>([['test', executor]]),
    {
      observability: { metrics: createRecordingMetricRecorder(), tracer: noopTracer },
      ...(params.sink === undefined ? {} : { auditSink: params.sink }),
      ...(params.options ?? {}),
    },
  );
}

describe('every decision lands in audit (§48 acceptance)', () => {
  it('records a successful call as allow/success', async () => {
    const sink = collector();
    await harness({ sink }).dispatch(command());

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      policyDecision: 'allow',
      outcome: 'success',
      operationId: 'op',
      requestId: 'req-1',
      traceId: 'trace-1',
    });
  });

  it('records a hook denial as deny', async () => {
    const sink = collector();
    await harness({
      sink,
      hooks: {
        authorize: async () => ({
          shortCircuit: true,
          result: { ok: false, error: { code: 'FORBIDDEN', message: 'no' } },
        }),
      },
    }).dispatch(command());

    expect(sink.events[0]).toMatchObject({ policyDecision: 'deny', outcome: 'FORBIDDEN' });
  });

  it('records a confirmation challenge as confirmation_required, NOT deny', async () => {
    // The distinction an audit log must preserve: "refused" and "asked the
    // caller to confirm" are different events with different follow-ups.
    const sink = collector();

    await harness({
      sink,
      options: {
        authorization: {
          authorize: async () => ({
            kind: 'deny' as const,
            error: { code: 'CONFIRMATION_REQUIRED' as const, message: 'confirm' },
          }),
        } as never,
      },
    }).dispatch(command());

    expect(sink.events[0]).toMatchObject({
      policyDecision: 'confirmation_required',
      outcome: 'CONFIRMATION_REQUIRED',
    });
  });

  it('records a policy denial as deny', async () => {
    const sink = collector();

    await harness({
      sink,
      options: {
        authorization: {
          authorize: async () => ({
            kind: 'deny' as const,
            error: { code: 'FORBIDDEN' as const, message: 'nope' },
          }),
        } as never,
      },
    }).dispatch(command());

    expect(sink.events[0]).toMatchObject({ policyDecision: 'deny', outcome: 'FORBIDDEN' });
  });

  it('records an EXECUTION FAILURE, which no inline audit call covers', async () => {
    // The gap this issue closed. Before #48 stage 11 ran only on the success
    // path and the two denial paths, so a log contained successes and
    // refusals but not failures — the events an investigator is looking for.
    const sink = collector();

    await harness({
      sink,
      execute: async () => ({
        ok: false,
        error: { code: 'UPSTREAM_UNAVAILABLE', message: 'boom' },
      }),
    }).dispatch(command());

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      policyDecision: 'allow',
      outcome: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('records an unknown operation, where no policy ever ran', async () => {
    // `not_evaluated` rather than 'allow': claiming a decision that never
    // happened would be a false record. It is a fourth value beyond §48's
    // three, flagged rather than forced into one that fits.
    const sink = collector();

    await harness({ sink }).dispatch(command({ operationId: 'nonexistent' }));

    expect(sink.events[0]).toMatchObject({
      policyDecision: 'not_evaluated',
      outcome: 'INVALID_INPUT',
    });
  });

  it('writes exactly one record per dispatch', async () => {
    // The single-audited-exit design must not double-record a path that also
    // audits inline.
    const sink = collector();
    const dispatcher = harness({ sink });

    await dispatcher.dispatch(command());
    await dispatcher.dispatch(command());

    expect(sink.events).toHaveLength(2);
  });
});

describe('never-include rules (§9.3)', () => {
  it('carries a digest of the input, never the input', async () => {
    const sink = collector();

    await harness({ sink }).dispatch(
      command({ input: { password: 'hunter2', card: '4111111111111111' } }),
    );

    const serialized = JSON.stringify(sink.events[0]);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('4111');
    expect(sink.events[0]?.inputDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries a principal REFERENCE, never the identifier', async () => {
    const sink = collector();

    await harness({ sink }).dispatch(
      command({ principal: { id: 'alice@example.com', type: 'user' } }),
    );

    const serialized = JSON.stringify(sink.events[0]);
    expect(serialized).not.toContain('alice');
    expect(sink.events[0]?.principalRef).toMatch(/^[0-9a-f]{32}$/);
  });

  it('omits principalRef entirely for an unauthenticated call', async () => {
    // Absent and "hash of empty string" are different facts.
    const sink = collector();
    await harness({ sink }).dispatch(command());

    expect(sink.events[0]?.principalRef).toBeUndefined();
  });

  it('never carries the output', async () => {
    const sink = collector();

    await harness({
      sink,
      execute: async () => ({ ok: true, value: { secretToken: 'sk-live-abcdef' } }),
    }).dispatch(command());

    expect(JSON.stringify(sink.events[0])).not.toContain('sk-live-abcdef');
  });
});

describe('back-pressure reaches dispatch (§48)', () => {
  it('slows dispatch when the audit buffer is full', async () => {
    // The claim that makes "mandatory delivery" real: stage 11 AWAITS the
    // append, so a full buffer in block mode stalls the request rather than
    // discarding the record.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const sink = bufferedSink(
      { id: 'slow', append: () => gate, flush: async () => undefined },
      { maxBufferSize: 1 },
    );

    const dispatcher = harness({ sink });

    await dispatcher.dispatch(command()); // taken by the stalled delegate
    await dispatcher.dispatch(command()); // fills the single slot

    let third = false;
    const pending = dispatcher.dispatch(command()).then(() => {
      third = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(third).toBe(false);

    release();
    await pending;
    expect(third).toBe(true);
  });
});

describe('pre-#48 behaviour is preserved', () => {
  it('still calls the legacy audit hook', async () => {
    // The hook and the sink are not alternatives: the hook is a notification,
    // the sink is the record. An adopter using the hook must not be broken by
    // configuring a sink.
    const seen: string[] = [];
    const sink = collector();

    await harness({
      sink,
      hooks: {
        audit: async (_ctx: unknown, result: OperationResult) => {
          seen.push(result.ok ? 'success' : 'error');
        },
      },
    }).dispatch(command());

    expect(seen).toEqual(['success']);
    expect(sink.events).toHaveLength(1);
  });

  it('writes nothing when no sink is configured', async () => {
    const seen: string[] = [];

    const result = await harness({
      hooks: {
        audit: async () => {
          seen.push('hook');
        },
      },
    }).dispatch(command());

    expect(result.isError).toBe(false);
    expect(seen).toEqual(['hook']);
  });
});

// ---------------------------------------------------------------------------
// `OperationCommand.registryHash` never reaches the audit log (#129 → #218)
//
// #129 was filed on the premise that the field is never read, and pinned the
// one path that made that wrong: an unknown-operation call fell back to the
// CALLER's value. #218 decided that fallback was the defect and removed it, so
// the second test below now asserts the opposite of what it used to.
//
// That inversion is deliberate. The old test documented real behaviour
// faithfully; #218 is the decision that the behaviour was wrong. Left as one
// block so the reversal is visible to whoever reads it next, rather than
// looking like the earlier assertion was simply mistaken.
// ---------------------------------------------------------------------------

describe('OperationCommand.registryHash never reaches the audit log (#218)', () => {
  it('is IGNORED for a resolved operation — the audit carries the server snapshot hash', async () => {
    // A caller must not be able to relabel which snapshot served its own call,
    // or the atomic-reload invariant #37 built would be caller-controllable.
    const sink = collector();

    await harness({ sink }).dispatch(command({ registryHash: 'CALLER-CLAIMED-HASH' }));

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.registryHash).not.toBe('CALLER-CLAIMED-HASH');
    expect(sink.events[0]?.registryHash).toBeTruthy();
    // And not the sentinel either — this path DID observe a hash. Without this
    // the fix could satisfy every other assertion by blanking the field
    // everywhere, which would destroy the log's usefulness rather than fix it.
    expect(sink.events[0]?.registryHash).not.toBe(AUDIT_REGISTRY_HASH_UNRESOLVED);
  });

  it('is IGNORED for an unknown operation too — the sentinel lands, not the claim', async () => {
    // The #218 fix. `auditTrace.registryHash` is assigned only AFTER stage 1
    // resolves the operation, so an unknown operation returns before there is
    // one. That used to fall back to the caller's string.
    //
    // Not an exotic path: every call for an unknown operation takes it.
    const sink = collector();

    await harness({ sink }).dispatch(
      command({ operationId: 'no-such-operation', registryHash: 'CALLER-CLAIMED-HASH' }),
    );

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.registryHash).toBe(AUDIT_REGISTRY_HASH_UNRESOLVED);
    expect(sink.events[0]?.registryHash).not.toBe('CALLER-CLAIMED-HASH');
  });

  it('gives a caller no unredacted channel into the audit log through that field', async () => {
    // The sharper half of #218, and the reason tagging the source would not
    // have been enough. `registryHash` is in AUDIT_STRUCTURAL_FIELDS, so
    // redaction deliberately preserves it verbatim — an exemption justified by
    // the value being server-computed. While the caller could reach that field,
    // it could post arbitrary text through a surface that strips everything
    // else, including content redaction exists to catch.
    const sink = collector();
    const smuggled = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciJ9.c2lnbmF0dXJl';

    await harness({ sink }).dispatch(
      command({ operationId: 'no-such-operation', registryHash: smuggled }),
    );

    expect(sink.events).toHaveLength(1);
    // Asserted over the WHOLE record, not just the field: the point is that the
    // value is absent from the audit log, wherever it might have been copied.
    expect(JSON.stringify(sink.events[0])).not.toContain(smuggled);
  });

  it('proves that field really is exempt from redaction, so the guard above is not vacuous', async () => {
    // Guards the guard. If `registryHash` were redacted like an ordinary field,
    // the smuggling test would pass for the wrong reason — redaction would be
    // catching it, and removing the #218 fix would not reintroduce the hole.
    // A server hash that looks exactly like the high-entropy content redaction
    // strips must still survive, which is what makes the exemption real and the
    // fallback the only thing standing between a caller and this field.
    const sink = collector();

    await harness({ sink }).dispatch(command());

    const hash = sink.events[0]?.registryHash ?? '';
    expect(hash).not.toBe('[REDACTED]');
    expect(hash.length).toBeGreaterThan(0);
  });
});
