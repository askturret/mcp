// SPDX-License-Identifier: Apache-2.0
/**
 * `createMcpServer` integration tests (#131).
 *
 * #131 asks for the reload behaviour to be verified "through `createMcpServer`
 * rather than constructing the controller directly", and that distinction is
 * the whole point of the issue. #37's suite already proves the controller
 * honours `degraded`; what was missing was proof that a server booted from a
 * PRESET ends up with that controller at all. A test that built the controller
 * itself would pass just as well against the old stub, which is exactly the
 * gap it is supposed to close.
 *
 * So every test below starts at `createMcpServer(...)` and never imports
 * `createReloadController`.
 */

import { describe, it, expect } from '@jest/globals';

import { createMcpServer, UnsupportedReloadModeError } from '../index.js';
import type { DiscoveredOperation, OperationSource } from '../../sources/types.js';
import type { SnapshotValidator } from '../../reload/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function discovered(id: string): DiscoveredOperation {
  return {
    candidateId: id,
    name: id,
    description: `operation ${id}`,
    rawInput: { type: 'object' },
    rawOutput: { type: 'object' },
    source: { kind: 'code', location: 'test' },
    executor: { type: 'test' },
  } as unknown as DiscoveredOperation;
}

/** Valid Regulated options, so its own boot refusals do not mask the mode check. */
const regulatedOptions = {
  permissions: { alpha: ['alpha:read'] },
  auditSink: { id: 'postgres-audit', durability: 'durable' },
  customReviewAcknowledged: true,
  verifyEvidence: () => true,
} as never;

/**
 * A source whose contents can change between discoveries.
 *
 * Reload is only observable when the SECOND compile differs from the first, so
 * a fixed source could not tell a working controller from one that never ran.
 */
function mutableSource(initial: string[]): OperationSource & { ids: string[] } {
  const state = { ids: [...initial] };
  return {
    ids: state.ids,
    id: 'mutable',
    discover: () => Promise.resolve(state.ids.map(discovered)),
  } as OperationSource & { ids: string[] };
}

/** Rejects every candidate, so the degraded path is exercised deterministically. */
const alwaysInvalid: SnapshotValidator = () => [
  { code: 'test-rejection', message: 'rejected by the test validator' },
];

/**
 * `include: '*'` throughout, deliberately.
 *
 * With `include` absent the compile path applies the facade's Light default —
 * read-only operations only — which would silently filter these fixtures to
 * nothing and make every "the snapshot changed" assertion read zero. That is a
 * property of the include filter, not of reload wiring, and leaving it implicit
 * would put an unrelated variable inside the test under test.
 */
const productionServer = (overrides: Record<string, unknown> = {}) =>
  createMcpServer({
    preset: 'production',
    sources: [mutableSource(['alpha'])],
    include: '*',
    ...overrides,
  });

// ---------------------------------------------------------------------------
// The wiring #131 exists to establish
// ---------------------------------------------------------------------------

describe('createMcpServer wires the preset to a live reload controller (#131)', () => {
  it('boots a production server with a controller, not a stub', async () => {
    const server = productionServer();
    await server.ready;

    // The old implementation returned an object whose start/stop threw and
    // carried nothing else. Anything real here is a change from that.
    expect(server.configuration.reloadMode).toBe('degraded');
    expect(typeof server.reload.reload).toBe('function');
    expect(server.reload.current().operations.size).toBe(1);
  });

  it('serves the compiled snapshot only after ready resolves', async () => {
    const server = productionServer();

    // Before the first compile lands the reference holds the empty bootstrap
    // snapshot. A caller that skipped `ready` would see "this server exposes
    // nothing" and report it as a configuration problem.
    expect(server.reload.current().operations.size).toBe(0);

    await server.ready;

    expect(server.reload.current().operations.size).toBe(1);
  });

  it('picks up a changed source on reload', async () => {
    // Proves the controller's `compile` is genuinely re-running discovery,
    // rather than closing over the boot snapshot.
    const source = mutableSource(['alpha']);
    const server = createMcpServer({ preset: 'production', sources: [source], include: '*' });
    await server.ready;

    source.ids.push('beta');
    const result = await server.reload.reload();

    expect(result.outcome).toBe('success');
    expect(server.reload.current().operations.size).toBe(2);
  });

  it('ENFORCES degraded mode: an invalid candidate resolves and retains last-good', async () => {
    // The acceptance criterion, through the preset rather than the controller.
    // `degraded` means: keep serving what we had, say so in readiness, and do
    // NOT reject the caller's promise.
    const source = mutableSource(['alpha']);
    const server = createMcpServer({
      preset: 'production',
      sources: [source],
      include: '*',
      reload: { validate: alwaysInvalid },
    });
    await server.ready;

    const before = server.reload.current();
    source.ids.push('beta');

    // Resolves rather than throws — that is the degraded half of the contract.
    const result = await server.reload.reload();

    expect(result.outcome).toBe('invalid');
    // The rejected candidate was NOT published.
    expect(server.reload.current().hash).toBe(before.hash);
    expect(server.reload.current().operations.size).toBe(1);
    // ...and the failure is visible rather than silent.
    expect(server.reload.readiness().ready).toBe(false);
  });

  it('does not let a caller override the preset-declared mode', async () => {
    // There is deliberately no `reload.mode` option: an override would let the
    // declared configuration and the enforced behaviour disagree again, which
    // is the exact gap #131 closes. Asserted structurally — passing one is a
    // no-op, so the mode stays what the preset said.
    const server = productionServer({ reload: { mode: 'fail-fast' } as never });
    await server.ready;

    expect(server.configuration.reloadMode).toBe('degraded');

    const source = mutableSource(['alpha']);
    const withValidator = createMcpServer({
      preset: 'production',
      sources: [source],
      include: '*',
      reload: { validate: alwaysInvalid, mode: 'fail-fast' } as never,
    });
    await withValidator.ready;

    // Still degraded: resolves rather than rejecting.
    await expect(withValidator.reload.reload()).resolves.toMatchObject({ outcome: 'invalid' });
  });
});

// ---------------------------------------------------------------------------
// The mode the controller does NOT implement
// ---------------------------------------------------------------------------

describe('an unimplemented reload mode is refused, not silently downgraded (#131)', () => {
  it('refuses to build a Regulated server, naming the pending entry', () => {
    // Regulated declares `fail-readiness`, which createReloadController has no
    // branch for. Passing it through would quietly yield `degraded` — turning
    // "pull me from the load balancer" into "keep serving while flagged", which
    // Regulated's own pending entry says is the entire reason §10.2 lists the
    // mode separately.
    expect(() =>
      createMcpServer({
        preset: 'regulated',
        sources: [mutableSource(['alpha'])],
        presetOptions: regulatedOptions,
      }),
    ).toThrow(UnsupportedReloadModeError);
  });

  it('refuses at the door, leaving no compile in flight', async () => {
    // A runtime that half-builds and then refuses is harder to reason about
    // than one that refuses immediately, and would leave discovery running
    // against sources for a server that will never exist.
    //
    // Two details make this test load-bearing rather than decorative, and both
    // were found by removing the guard and watching it stay green:
    //
    //  1. The AWAIT. `ready` starts `compile()` in a microtask, so a
    //     synchronous check reports "not called" whether or not the guard ran.
    //  2. VALID Regulated options. With invalid ones `regulatedPreset` refuses
    //     first, so the test would pass on a completely different throw and
    //     never exercise the mode guard at all.
    let discoverCalled = false;
    const spy: OperationSource = {
      id: 'spy',
      discover: () => {
        discoverCalled = true;
        return Promise.resolve([]);
      },
    } as OperationSource;

    expect(() =>
      createMcpServer({
        preset: 'regulated',
        sources: [spy],
        presetOptions: regulatedOptions,
      }),
    ).toThrow(UnsupportedReloadModeError);

    // Yield twice, so any microtask-scheduled compile has had its chance to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(discoverCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claims must not outrun what is wired
// ---------------------------------------------------------------------------

describe('createMcpServer does not overclaim (#131)', () => {
  it('still refuses to serve traffic, and says why', async () => {
    const server = productionServer();
    await server.ready;

    await expect(server.start()).rejects.toThrow(/not implemented/i);
    await expect(server.stop()).rejects.toThrow(/expressMcp|gateway/);
  });

  it('no longer lists reloadMode as pending, but still lists what is not wired', async () => {
    const server = productionServer();
    await server.ready;

    const controls = server.pending.map((p) => p.control);

    expect(controls).not.toContain('reloadMode');
    // The other three depend on Epic #3 primitives that do not exist yet, so
    // they must stay declared. A PR that quietly dropped them would be claiming
    // more than it wired — the failure this test exists to prevent.
    expect(controls).toContain('audit.sink');
    expect(controls).toContain('redaction');
    expect(controls).toContain('outputValidation');
  });
});
