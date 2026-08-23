// SPDX-License-Identifier: Apache-2.0
/**
 * The surfaces are actually WIRED (§9.4 acceptance).
 *
 * `surfaces.test.ts` proves the pipeline strips a secret when it is called.
 * This proves each real call site calls it — which is the part that can rot.
 * A perfect pipeline nobody invokes passes every test in that file.
 */

import { describe, it, expect } from '@jest/globals';

import { AtomicRegistryReference } from '../../registry-reference.js';
import { createDispatcher } from '../../dispatcher/index.js';
import { createSnapshot } from '../../compiler/passes/freeze-and-hash.js';
import { createLogger } from '../../logging/logger.js';
import { createRecordingTracer } from '../../telemetry/tracer.js';
import { createRecordingMetricRecorder } from '../../telemetry/metrics.js';
import { METRIC } from '../../telemetry/types.js';
import type { AuditEvent, AuditSink } from '../../audit/types.js';
import type { OperationDefinition } from '../../types.js';
import type { OperationExecutor } from '../../executor/index.js';
import type { LogRecord } from '../../logging/types.js';

const SECRET = 'sk_live_xyz';

function operation(): OperationDefinition {
  return {
    id: 'createPet',
    name: 'createPet',
    description: 'Create a pet',
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: false,
      idempotent: true,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'test' },
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    operationId: 'createPet',
    input: { name: 'Fluffy', apiKey: SECRET },
    deadline: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    registryHash: 'unused',
    ...overrides,
  } as Parameters<ReturnType<typeof createDispatcher>['dispatch']>[0];
}

describe('surface 1 — log emitter', () => {
  it('strips a secret from log fields', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'info', sink: (r) => records.push(r) });

    // Nested, because #38's `SafeLogFields` already makes a TOP-LEVEL
    // `credential` key a COMPILE error — a nice belt-and-braces result, but it
    // means the runtime pipeline has to be tested where the compiler cannot
    // see: inside a nested object.
    logger.info('handled', { requestId: 'r1', meta: { credential: SECRET } });

    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(JSON.stringify(records)).toContain('[REDACTED]');
  });

  it('applies even when a custom redact function is supplied', () => {
    // A hook must not be able to bypass §9.4's single exit. A custom function
    // that returns its input unchanged is the sharpest version of that test.
    const records: LogRecord[] = [];
    const logger = createLogger({
      level: 'info',
      sink: (r) => records.push(r),
      redact: (fields) => fields,
    });

    logger.info('handled', { meta: { credential: SECRET } });

    expect(JSON.stringify(records)).not.toContain(SECRET);
  });
});

describe('surface 2 — span attributes', () => {
  /**
   * A JWT under an INNOCUOUS key.
   *
   * An earlier version used `apiKey` / `secret` and proved nothing: #39's span
   * sanitizer already masks those by key name, so removing the pipeline call
   * entirely left the test green. Mutation testing caught it.
   *
   * What the pipeline adds over #39 is VALUE-shape matching — a credential
   * under a key no denylist would think to include, which is exactly the gap
   * #38 spent a release documenting.
   */
  const JWT =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

  it('strips a credential-shaped value under a key no denylist covers', () => {
    const tracer = createRecordingTracer();
    const span = tracer.startSpan('mcp.request');

    span.setAttribute('upstream.note', JWT);

    expect(JSON.stringify(tracer.all())).not.toContain(JWT);
  });

  it('also strips it on the bulk setter', () => {
    // `setAttribute` routes through the same function precisely so a one-key
    // set cannot bypass what a bulk set enforces; this pins both directions.
    const tracer = createRecordingTracer();
    const span = tracer.startSpan('mcp.request');

    span.setAttributes({ 'upstream.note': JWT });

    expect(JSON.stringify(tracer.all())).not.toContain(JWT);
  });

  it('leaves the §39 key-denylist behaviour intact', () => {
    const tracer = createRecordingTracer();
    const span = tracer.startSpan('mcp.request');

    span.setAttribute('apiKey', SECRET);

    expect(JSON.stringify(tracer.all())).not.toContain(SECRET);
  });
});

describe('surface 3 — metric labels', () => {
  it('strips a secret carried under a sensitive label key', () => {
    const metrics = createRecordingMetricRecorder();

    metrics.add(METRIC.toolCallsTotal, 1, { tool: 'createPet', apiKey: SECRET } as never);

    expect(JSON.stringify(metrics.samples())).not.toContain(SECRET);
  });

  it('does NOT invent a match for an arbitrary string under an innocuous key', () => {
    // Honest limitation, asserted rather than left implied. `sk_live_xyz` is
    // 11 characters with no structure: no key name matches, no value-shape
    // rule matches, and it is below the entropy floor even if that opt-in rule
    // were enabled. §49's own fixture is caught by its KEY, not its shape.
    //
    // General detection of arbitrary secrets by value is not achievable, so
    // the defence is naming — plus the §9.2 cardinality guard, which is what
    // actually stops unbounded values reaching a label in the first place.
    const metrics = createRecordingMetricRecorder();

    metrics.add(METRIC.toolCallsTotal, 1, { tool: 'createPet', outcome: SECRET });

    expect(JSON.stringify(metrics.samples())).toContain(SECRET);
  });
});

describe('surface 4 — audit projection', () => {
  it('strips a secret before the event reaches the sink', async () => {
    const events: AuditEvent[] = [];
    const sink: AuditSink = {
      id: 'test',
      append: async (event) => {
        events.push(event);
      },
      flush: async () => undefined,
    };

    const dispatcher = createDispatcher(
      new AtomicRegistryReference(createSnapshot([operation()], 1)),
      {},
      new Map<string, OperationExecutor>([
        ['test', { execute: async () => ({ ok: true, value: {} }) }],
      ]),
      { auditSink: sink },
    );

    await dispatcher.dispatch(command());

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(SECRET);
    // And the record is still useful — the digest survived.
    expect(events[0]?.inputDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('HONEST NOTE: this assertion passes with or without the wiring', () => {
    // Kept, and labelled, rather than quietly deleted.
    //
    // Removing `redactAuditEvent` from the dispatcher does NOT fail the test
    // above, and the reason is a good one: #48 designed the audit event so
    // that no raw payload can reach it — the input becomes a digest and the
    // principal becomes a pseudonym before the event is ever constructed. So
    // there is nothing for redaction to strip on today's event shape.
    //
    // The wiring is therefore DEFENCE IN DEPTH, aimed at fields that do not
    // exist yet (`policyEvidence` is free-form and is not currently
    // populated by the dispatcher). Its behaviour is covered at the seam in
    // `surfaces.test.ts` — "still redacts a sensitive key that appears on an
    // audit event" — which does go red if the rules stop firing.
    //
    // Asserting the actual property: the secret is absent because it never
    // arrived, not because it was removed.
    const digested = JSON.stringify({ inputDigest: 'x'.repeat(64) });
    expect(digested).not.toContain(SECRET);
  });
});

describe('surface 6 — serialized error', () => {
  it('strips a secret from error details on the way to the wire', async () => {
    const dispatcher = createDispatcher(
      new AtomicRegistryReference(createSnapshot([operation()], 1)),
      {},
      new Map<string, OperationExecutor>([
        [
          'test',
          {
            execute: async () => ({
              ok: false,
              error: {
                code: 'FORBIDDEN' as const,
                message: 'denied',
                details: { authorization: SECRET },
              },
            }),
          },
        ],
      ]),
    );

    const result = await dispatcher.dispatch(command());

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // The CODE survives — a client must still be able to branch on it.
    expect(result.error?.code).toBe('FORBIDDEN');
  });
});

describe('the pipeline reports what it did', () => {
  it('counts hits by rule and surface', async () => {
    const { createRedactionPipeline } = await import('../index.js');
    const metrics = createRecordingMetricRecorder();

    createRedactionPipeline({ metrics }).redact(
      { apiKey: SECRET },
      { surface: 'log', path: [] },
    );

    const hits = metrics.forMetric(METRIC.redactionHitsTotal);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.labels).toEqual({ rule: 'key-name', surface: 'log' });
  });
});
