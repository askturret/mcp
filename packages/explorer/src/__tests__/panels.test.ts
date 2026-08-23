// SPDX-License-Identifier: Apache-2.0
/**
 * The six Explorer panels (§13, ADR-020, #56).
 *
 * The redaction section is the one that matters most. §56 makes "no panel
 * bypasses the redaction pipeline" an acceptance criterion, and a leak there is
 * not a rendering bug — the Explorer is a page served to a browser, so a secret
 * that reaches a panel has left the process.
 *
 * So the redaction tests plant a known secret in EVERY panel's input and assert
 * it does not survive, rather than testing one representative panel and
 * assuming the rest.
 */

import { describe, it, expect } from '@jest/globals';

import {
  buildBreakerView,
  buildDiffView,
  buildExplorerPanels,
  buildPolicyExplanationView,
  buildPrincipalSurfaceView,
  buildProvenanceView,
  buildTraceView,
} from '../panels.js';
import type { OperationDefinition, Principal, RegistrySnapshot } from '@askturret/mcp-core';

const SECRET = 'sk_live_abcdef123456';

function operation(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return {
    id: 'createOrder',
    name: 'createOrder',
    description: 'Creates an order.',
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: false,
      idempotent: false,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'http' },
    ...overrides,
  } as OperationDefinition;
}

function snapshot(version: number, hash: string): RegistrySnapshot {
  return {
    version,
    hash,
    createdAt: new Date(0),
    operations: new Map([['a', operation({ id: 'a' })]]),
  } as RegistrySnapshot;
}

// ---------------------------------------------------------------------------
// Panel 1 — provenance
// ---------------------------------------------------------------------------

describe('panel 1 — provenance explainer', () => {
  const withProvenance = operation({
    provenance: [
      { field: 'description', kind: 'overlay', location: 'askturret.mcp.yaml#/operations/createOrder/description' },
      { field: 'name', kind: 'openapi', location: 'petstore.yaml' },
      { field: 'effects.readOnly', kind: 'inference' },
    ],
  });

  it('labels each field with its §5.3 precedence level', () => {
    const view = buildProvenanceView(withProvenance);

    const byField = Object.fromEntries(view.fields.map((f) => [f.field, f]));
    expect(byField['description']?.precedence).toContain('2 ·');
    expect(byField['name']?.precedence).toContain('4 ·');
    expect(byField['effects.readOnly']?.precedence).toContain('5 ·');
  });

  it('flags overlay-modified fields, which is what §56 asks to highlight', () => {
    const view = buildProvenanceView(withProvenance);

    expect(view.fields.find((f) => f.field === 'description')?.overlayModified).toBe(true);
    expect(view.fields.find((f) => f.field === 'name')?.overlayModified).toBe(false);
    expect(view.overlayModifiedCount).toBe(1);
  });

  it('carries the location so the hover points at a line, not just a file', () => {
    const view = buildProvenanceView(withProvenance);
    expect(view.fields.find((f) => f.field === 'description')?.location).toBe(
      'askturret.mcp.yaml#/operations/createOrder/description',
    );
  });

  it('says provenance is UNAVAILABLE rather than rendering an empty table', () => {
    // An operation with no provenance and one whose every field came from the
    // source are different states. An empty table implies the second.
    expect(buildProvenanceView(operation()).available).toBe(false);
    expect(buildProvenanceView(withProvenance).available).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Panel 2 — policy explanation
// ---------------------------------------------------------------------------

describe('panel 2 — policy explanation', () => {
  it('shows the specific policy and its evidence for a DENY', () => {
    // §56's named test: "policy explanation for a deny operation shows the
    // specific policy + evidence".
    const view = buildPolicyExplanationView('createOrder', 'allOf(authenticated, permissionPolicy)', {
      effect: 'deny',
      code: 'FORBIDDEN',
      safeReason: 'The caller lacks the permissions this operation requires.',
      evidence: [
        { policyId: 'authenticated', claim: 'principal is present' },
        {
          policyId: 'permissionPolicy',
          claim: 'principal is missing required permissions',
          detail: 'missing: orders:write',
        },
      ],
    });

    expect(view.denied).toBe(true);
    expect(view.policy).toContain('permissionPolicy');
    expect(view.evidence).toHaveLength(2);
    // The evidence has to name WHICH policy fired, or the panel says only
    // "denied" and the operator is back to guessing.
    expect(view.evidence[1]?.policyId).toBe('permissionPolicy');
    expect(view.evidence[1]?.detail).toContain('orders:write');
  });

  it('renders an allow without a denial code', () => {
    const view = buildPolicyExplanationView('a', 'authenticated', {
      effect: 'allow',
      evidence: [{ policyId: 'authenticated', claim: 'principal is present' }],
    });

    expect(view.denied).toBe(false);
    expect(view.code).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Panel 3 — principal-aware surface
// ---------------------------------------------------------------------------

describe('panel 3 — principal-aware effective surface', () => {
  const all = [operation({ id: 'a', name: 'a' }), operation({ id: 'b', name: 'b' })];

  it('shows BOTH visible and hidden, because hidden is the question', () => {
    const view = buildPrincipalSurfaceView(
      { id: 'u1', type: 'user', permissions: ['orders:read'] },
      all,
      [all[0] as OperationDefinition],
    );

    expect(view.visible.map((v) => v.id)).toEqual(['a']);
    // "Why can't customer X see this tool?" cannot be answered by a list of
    // what they CAN see.
    expect(view.hidden.map((v) => v.id)).toEqual(['b']);
    expect(view.totalCount).toBe(2);
  });

  it('NEVER echoes the principal id back into the page', () => {
    const view = buildPrincipalSurfaceView(
      { id: 'alice@example.com', type: 'user', permissions: ['orders:read'] },
      all,
      all,
    );

    // #33's evidence contract singles the id out as unsafe. A debugging page
    // rendering a real identifier is exactly that leak, arriving by a
    // different door.
    expect(JSON.stringify(view)).not.toContain('alice@example.com');
    expect(view.principal.type).toBe('user');
    expect(view.principal.permissions).toEqual(['orders:read']);
  });

  it('handles an anonymous principal', () => {
    const view = buildPrincipalSurfaceView(undefined, all, []);
    expect(view.principal.anonymous).toBe(true);
    expect(view.hidden).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Panel 4 — traces
// ---------------------------------------------------------------------------

describe('panel 4 — traces', () => {
  it('says UNAVAILABLE, with a reason, when no buffer is wired', () => {
    // The buffer is opt-in, so absence is normal — and an empty panel that
    // looked like "no traffic yet" would send someone hunting for requests
    // that were never recorded.
    const view = buildTraceView(undefined);

    expect(view.available).toBe(false);
    expect(view.reason).toContain('recordingObservability');
    expect(view.spans).toEqual([]);
  });

  it('renders a recorded tail when one is supplied', () => {
    const view = buildTraceView([
      {
        name: 'mcp.tool.call',
        attributes: { 'mcp.tool.name': 'createOrder' },
        outcome: 'success',
        startedAt: 0,
        durationMs: 12,
      },
    ]);

    expect(view.available).toBe(true);
    expect(view.spans[0]?.name).toBe('mcp.tool.call');
    expect(view.spans[0]?.startedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('filters to one tool when asked', () => {
    const spans = [
      { name: 's1', attributes: { 'mcp.tool.name': 'a' }, startedAt: 0 },
      { name: 's2', attributes: { 'mcp.tool.name': 'b' }, startedAt: 0 },
    ];

    expect(buildTraceView(spans, 'a').spans).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Panel 5 — breaker / bulkhead
// ---------------------------------------------------------------------------

describe('panel 5 — breaker and bulkhead state', () => {
  it('distinguishes "none configured" from "all closed"', () => {
    // Breakers are opt-in (#46). A UI that could not tell these apart would
    // show a reassuring row of green for a server with no breakers at all.
    expect(buildBreakerView(undefined, undefined).breakersConfigured).toBe(false);
    expect(buildBreakerView([], []).breakersConfigured).toBe(false);
    expect(buildBreakerView([{ name: 'default', state: 'closed' }], []).breakersConfigured).toBe(
      true,
    );
  });

  it('reports polling, and the interval, in the MODEL', () => {
    // §56 asks for the SSE-vs-polling choice to be documented. Documented in
    // the model rather than only in a comment, so the page and the docs cannot
    // disagree about how the panel refreshes.
    const view = buildBreakerView([], [], 5000);

    expect(view.refreshStrategy).toBe('polling');
    expect(view.pollIntervalMs).toBe(5000);
  });

  it('carries breaker state and bulkhead depth', () => {
    const view = buildBreakerView(
      [{ name: 'payments', state: 'open', failures: 5 }],
      [{ name: 'default', inFlight: 2, queued: 1, concurrency: 4, queueSize: 8 }],
    );

    expect(view.breakers[0]).toMatchObject({ name: 'payments', state: 'open', failures: 5 });
    expect(view.bulkheads[0]).toMatchObject({ inFlight: 2, queued: 1 });
  });
});

// ---------------------------------------------------------------------------
// Panel 6 — version diff
// ---------------------------------------------------------------------------

describe('panel 6 — version diff', () => {
  it('says UNAVAILABLE when fewer than two snapshots are retained', () => {
    // An empty diff and an impossible diff look identical otherwise.
    const view = buildDiffView(undefined, [snapshot(1, 'h1')]);

    expect(view.available).toBe(false);
    expect(view.reason).toContain('two retained snapshots');
  });

  it('lists retained snapshots for the two-panel selector', () => {
    const view = buildDiffView(undefined, [snapshot(2, 'h2'), snapshot(1, 'h1')]);

    expect(view.available).toBe(true);
    expect(view.snapshots.map((s) => s.hash)).toEqual(['h2', 'h1']);
  });

  it('renders the CLI classification verbatim', () => {
    // §56 asks the panel to match the `diff` CLI. It is fed by the SAME
    // diffSnapshots report the CLI prints, so this asserts the codes survive
    // unchanged rather than being re-derived.
    const view = buildDiffView(
      {
        changes: [
          { code: 'OPERATION_REMOVED', severity: 'breaking', operationId: 'gone' },
          { code: 'DESCRIPTION_CHANGED', severity: 'patch', operationId: 'a' },
        ],
        summary: { breaking: 1, minor: 0, patch: 1 },
      } as never,
      [snapshot(2, 'h2'), snapshot(1, 'h1')],
    );

    expect(view.changes.map((c) => c.code)).toEqual([
      'OPERATION_REMOVED',
      'DESCRIPTION_CHANGED',
    ]);
    expect(view.changes[0]?.severity).toBe('breaking');
    expect(view.summary).toEqual({ breaking: 1, minor: 0, patch: 1 });
  });
});

// ---------------------------------------------------------------------------
// The hard constraint
// ---------------------------------------------------------------------------

describe('NO PANEL BYPASSES THE REDACTION PIPELINE (§56 acceptance)', () => {
  /**
   * Every panel is planted with a secret the pipeline's BUILT-IN rules
   * genuinely catch, and must not emit it.
   *
   * The fixture is a Bearer token rather than an arbitrary high-entropy
   * string, and that distinction is the point — see the limitation test at the
   * bottom of this block. The built-ins are `keyNameRule`, `pemRule`,
   * `bearerRule`, `jwtRule` and `creditCardRule`; a bare `sk_live_…` under an
   * innocuous key matches none of them.
   *
   * Tested per panel rather than on one representative. The Explorer is a page
   * served to a browser, so a secret reaching a panel has left the process, and
   * "the other five are probably fine" is not a claim worth making.
   */
  const CAUGHT = 'Bearer abcdefghijklmnopqrstuvwxyz012345';

  it('panel 1 — provenance location', () => {
    const view = buildProvenanceView(
      operation({ provenance: [{ field: 'description', kind: 'overlay', location: CAUGHT }] }),
    );
    expect(JSON.stringify(view)).not.toContain(CAUGHT);
  });

  it('panel 2 — policy evidence detail and reason', () => {
    const view = buildPolicyExplanationView('a', 'p', {
      effect: 'deny',
      safeReason: CAUGHT,
      evidence: [{ policyId: 'p', claim: 'denied', detail: CAUGHT }],
    });
    expect(JSON.stringify(view)).not.toContain(CAUGHT);
  });

  it('panel 3 — principal permissions', () => {
    const view = buildPrincipalSurfaceView(
      { id: 'u', type: 'user', permissions: [CAUGHT] },
      [operation()],
      [],
    );
    expect(JSON.stringify(view)).not.toContain(CAUGHT);
  });

  it('panel 4 — span attributes, by key name', () => {
    const view = buildTraceView([
      { name: 's', attributes: { apiKey: 'sk_live_abcdef123456' }, startedAt: 0 },
    ]);
    expect(JSON.stringify(view)).not.toContain('sk_live_abcdef123456');
  });

  it('panel 5 — breaker name', () => {
    const view = buildBreakerView([{ name: CAUGHT, state: 'open' }], []);
    expect(JSON.stringify(view)).not.toContain(CAUGHT);
  });

  it('panel 6 — diff detail', () => {
    const view = buildDiffView(
      { changes: [{ code: 'X', severity: 'patch', detail: CAUGHT }], summary: {} } as never,
      [snapshot(2, 'h2'), snapshot(1, 'h1')],
    );
    expect(JSON.stringify(view)).not.toContain(CAUGHT);
  });

  it('and the assembled model, through every panel at once', () => {
    const assembled = buildExplorerPanels({
      operation: operation({
        provenance: [{ field: 'description', kind: 'overlay', location: CAUGHT }],
      }),
      policy: {
        policyId: 'p',
        decision: { effect: 'deny', evidence: [{ policyId: 'p', claim: 'no', detail: CAUGHT }] },
      },
      principal: { id: 'u', type: 'user', permissions: [CAUGHT] },
      allOperations: [operation()],
      visibleOperations: [],
      spans: [{ name: 's', attributes: { apiKey: 'sk_live_abcdef123456' }, startedAt: 0 }],
      breakers: [{ name: CAUGHT, state: 'open' }],
      retained: [snapshot(2, 'h2'), snapshot(1, 'h1')],
    });

    const json = JSON.stringify(assembled);
    expect(json).not.toContain(CAUGHT);
    expect(json).not.toContain('sk_live_abcdef123456');
  });

  it('DOES NOT catch a bare high-entropy value under an innocuous key — documented gap', () => {
    // This is a REAL limitation, asserted rather than hidden, because §56's
    // text says the redaction pipeline "already ensures no sensitive data
    // reaches this panel" — and that overstates what the DEFAULT pipeline
    // does.
    //
    // The built-ins are key-name plus four value SHAPES (PEM, Bearer, JWT,
    // credit card). High-entropy detection is deliberately opt-in (§9.4, #49),
    // because promoting it broke a span test by redacting a whole URL. So a
    // vendor key under a field named `location` survives every panel.
    //
    // The panels satisfy §56's constraint — every one routes through the
    // pipeline, proven above. What they cannot do is exceed it. An operator
    // who needs value-shape coverage adds a rule; this test exists so that
    // need is discovered here rather than in a screenshot.
    const view = buildProvenanceView(
      operation({
        provenance: [{ field: 'description', kind: 'overlay', location: 'sk_live_abcdef123456' }],
      }),
    );

    expect(JSON.stringify(view)).toContain('sk_live_abcdef123456');
  });
});

describe('the assembled panel set', () => {
  it('always includes traces, runtime and diff, even when unavailable', () => {
    // Those three answer "is this configured?", which is a question worth
    // answering. The other three are per-operation and absent when no
    // operation is selected.
    const panels = buildExplorerPanels({});

    expect(panels.traces.available).toBe(false);
    expect(panels.runtime.breakersConfigured).toBe(false);
    expect(panels.diff.available).toBe(false);
    expect(panels.provenance).toBeUndefined();
  });
});
