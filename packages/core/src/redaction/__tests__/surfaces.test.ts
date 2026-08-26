// SPDX-License-Identifier: Apache-2.0
/**
 * The sixfold-surface guarantee (§9.4, §49 acceptance).
 *
 * §49 asks for two things that are easy to confuse:
 *
 *  1. a snapshot proving each of the six surfaces strips a known secret, and
 *  2. a NEGATIVE test — "adding a new surface without wiring it into redaction
 *     fails the snapshot check".
 *
 * (2) is the one with teeth, and it cannot be written as an assertion about
 * behaviour, because the surface it is about does not exist yet. It is written
 * instead as an exhaustiveness check over the `RedactionSurface` union: a
 * seventh member with no entry in the table below fails to compile, and a
 * seventh member with an entry that does not strip fails at runtime.
 */

import { describe, it, expect } from '@jest/globals';

import { REDACTION_SURFACES, createRedactionPipeline, highEntropyRule } from '../index.js';
import type { RedactionSurface } from '../types.js';

/** The fixture §49 names verbatim. */
const SECRET = 'sk_live_xyz';

/**
 * One representative payload per surface, shaped like what that surface
 * actually carries.
 *
 * Deliberately NOT the same object six times: a table that redacted one shape
 * six times would prove the pipeline works once, not that six different
 * call-sites feed it correctly-shaped data.
 */
const FIXTURES: Record<RedactionSurface, unknown> = {
  log: { requestId: 'req-1', token: SECRET },
  span: { 'mcp.tool.name': 'createPet', apiKey: SECRET },
  metric: { tool: 'createPet', secret: SECRET },
  audit: {
    eventId: 'e1',
    requestId: 'req-1',
    operationId: 'createPet',
    credential: SECRET,
  },
  explorer: {
    tools: [{ id: 'createPet', description: 'Create', example: { password: SECRET } }],
  },
  error: { message: 'upstream rejected', details: { authorization: SECRET } },
  // Added by #50, and ONLY because this table forced it: adding
  // 'diagnostic-bundle' to the union produced a compile error naming the
  // missing key before a single line of the CLI existed. That is the negative
  // test §49 asked for, doing its job on its first real consumer.
  'diagnostic-bundle': {
    versions: { node: 'v20.11.0' },
    env: { API_KEY: SECRET },
  },
};

describe('every surface strips a known secret (§49 acceptance)', () => {
  it.each(REDACTION_SURFACES)('surface %s removes the secret', (surface) => {
    const pipeline = createRedactionPipeline();

    const result = pipeline.redact(FIXTURES[surface], { surface, path: [] });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('[REDACTED]');
  });

  it('covers every surface in the union — the negative test', () => {
    // THE guard §49 asks for. `FIXTURES` is typed as `Record<RedactionSurface,
    // unknown>`, so adding a seventh surface to the union without adding a
    // fixture is a COMPILE error; this assertion catches the other direction,
    // where the union grows and `REDACTION_SURFACES` is not kept in step.
    //
    // Between them, a new observable exit cannot be added without someone
    // being made to state how it redacts.
    expect(Object.keys(FIXTURES).sort()).toEqual([...REDACTION_SURFACES].sort());
    expect(REDACTION_SURFACES).toHaveLength(7);
  });
});

/**
 * A realistic SHA-256, not a repeated character.
 *
 * `'c'.repeat(64)` looks like a digest and is useless as a fixture: Shannon
 * entropy of a single repeated character is ZERO, so the entropy rule
 * correctly ignores it and the test passes without exercising anything. Cost
 * me a red test to notice.
 */
const DIGEST = 'a3f1c09e7b2d4856ef01927a6c3b5d8e4f7092a1bc63d5e8f0a2947c1b6d3e85';
const PRINCIPAL_REF = '9c1f7a02e5b384d6a07f2c19b83e4d5a';

describe('audit keeps its structural fields (§9.4 surface-specific)', () => {
  it('does not redact the digest, principal reference or ids', () => {
    // The trap this rule exists for. An audit event is mostly hex — a 64-char
    // inputDigest, a 32-char principalRef — and a naive value-shape rule
    // reduces the whole record to [REDACTED], destroying both #48's digest
    // stability and any ability to correlate two records.
    const event = {
      eventId: '0000018f1a2b-2c3d4e5f',
      requestId: 'req-1',
      principalRef: PRINCIPAL_REF,
      registryHash: DIGEST,
      inputDigest: DIGEST,
      operationId: 'createPet',
      policyDecision: 'allow',
      outcome: 'success',
      durationMs: 12,
    };

    // The entropy rule is ADDED here on purpose. With only the default
    // built-ins the exemption is not load-bearing — no default rule matches a
    // hex digest — so a test using defaults alone would pass whether or not
    // the exemption existed. This drives the case the exemption is FOR.
    const pipeline = createRedactionPipeline();
    pipeline.add(highEntropyRule);

    const result = pipeline.redact(event, { surface: 'audit', path: [] }) as typeof event;

    expect(result.inputDigest).toBe(DIGEST);
    expect(result.principalRef).toBe(PRINCIPAL_REF);
    expect(result.registryHash).toBe(DIGEST);
    expect(result.eventId).toBe(event.eventId);
  });

  it('does NOT exempt a structural field name NESTED inside an audit payload (#383 item 3)', () => {
    // THE AUDIT ANCHORING ASSERTION.
    //
    // Before the per-surface refactor, `path.length === 1` made root-anchoring a
    // COMPILE-TIME invariant. The refactor turned it into `anchored: true` — a
    // data flag — and nothing observed it. Flipping the audit entries to
    // `anchored: false` left the entire suite green while materially widening
    // what stays unredacted: protection disappearing with nothing going red.
    //
    // The fixture sits at a NON-SENSITIVE key name deliberately. `keyNameRule`
    // does not consult the structural exemption at all, so a nested
    // `payload.inner.token` would be masked by key name regardless and this
    // would pass for the wrong reason. `eventId` is not in SENSITIVE_KEY_NAMES,
    // so the only thing that can mask it here is `creditCardRule` declining to
    // stand down — which is the property under test.
    const CARD = '4242424242424242';

    const result = createRedactionPipeline().redact(
      { eventId: CARD, payload: { inner: { eventId: CARD } } },
      { surface: 'audit', path: [] },
    ) as { eventId: string; payload: { inner: { eventId: string } } };

    // Nested: NOT exempt, so the card-shaped value is masked.
    expect(result.payload.inner.eventId).toBe('[REDACTED]');

    // The paired positive, at the root where the exemption genuinely applies.
    // Without it, an implementation that exempted nothing at all would satisfy
    // the assertion above.
    expect(result.eventId).toBe(CARD);
  });

  it('still redacts a sensitive key that appears on an audit event', () => {
    // The exemption is for NAMED structural fields only — it is not a blanket
    // pass for the audit surface.
    const result = createRedactionPipeline().redact(
      { inputDigest: DIGEST, password: SECRET },
      { surface: 'audit', path: [] },
    ) as Record<string, unknown>;

    expect(result['inputDigest']).toBe(DIGEST);
    expect(result['password']).toBe('[REDACTED]');
  });

  it('does NOT exempt those field names on other surfaces', () => {
    // `inputDigest` is non-sensitive because of what an AUDIT event is, not
    // because of the name. A log field that happens to share the name gets no
    // special treatment — with the opt-in entropy rule enabled it would be
    // redacted like anything else.
    const pipeline = createRedactionPipeline();
    pipeline.add(highEntropyRule);

    const result = pipeline.redact({ inputDigest: DIGEST }, {
      surface: 'log',
      path: [],
    }) as Record<string, unknown>;

    expect(result['inputDigest']).toBe('[REDACTED]');
  });
});

describe('rule ordering (§49)', () => {
  it('runs user rules after built-ins', () => {
    const pipeline = createRedactionPipeline();
    // Scoped to named keys rather than `() => true`: a rule that matches
    // everything also matches the ROOT object, so the whole payload is
    // replaced before the walk ever descends. That is correct
    // first-match-wins behaviour at every node, root included — but it makes
    // the test about something else entirely. (It caught me once.)
    pipeline.add({
      id: 'user-rule',
      matches: (context) => ['password', 'harmless'].includes(context.path[0] ?? ''),
      transform: () => 'USER',
    });

    const result = pipeline.redact({ password: 'x', harmless: 'y' }, {
      surface: 'log',
      path: [],
    }) as Record<string, unknown>;

    // The built-in claimed `password` first; the user rule got what was left.
    expect(result['password']).toBe('[REDACTED]');
    expect(result['harmless']).toBe('USER');
  });

  it('places a user rule at the end of the evaluation order', () => {
    const pipeline = createRedactionPipeline();
    pipeline.add({ id: 'user-rule', matches: () => false, transform: (v) => v });

    const ids = pipeline.rules().map((r) => r.id);
    expect(ids[ids.length - 1]).toBe('user-rule');
    expect(ids[0]).toBe('key-name');
  });
});

describe('failing closed', () => {
  it('redacts when a rule throws rather than emitting the value', () => {
    // A throwing rule must not be read as "no match" — that would emit the
    // value the rule might have been protecting.
    const pipeline = createRedactionPipeline({
      rules: [
        {
          id: 'broken',
          matches: () => {
            throw new Error('rule bug');
          },
          transform: () => '[REDACTED]',
        },
      ],
    });

    expect(pipeline.redact({ a: SECRET }, { surface: 'log', path: [] })).toBe('[REDACTED]');
  });

  it('does not recurse forever on a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;

    const result = createRedactionPipeline().redact(cyclic, {
      surface: 'log',
      path: [],
    }) as Record<string, unknown>;

    expect(result['name']).toBe('root');
    expect(result['self']).toBe('[REDACTED:cycle]');
  });

  it('truncates beyond the depth cap rather than passing the value through', () => {
    let deep: Record<string, unknown> = { token: SECRET };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };

    const serialized = JSON.stringify(
      createRedactionPipeline({ maxDepth: 3 }).redact(deep, { surface: 'log', path: [] }),
    );

    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('[REDACTED:depth]');
  });
});
