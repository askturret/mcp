// SPDX-License-Identifier: Apache-2.0
/**
 * Option B — the internal divergence check (#64, §11.2).
 *
 * The four scenarios §64 names are the first four describe blocks. The rest are
 * the failure modes that decide whether this is safe to switch on at all: a
 * dead pod's leftover entry, a peer store outage, and scope isolation. Each of
 * those turns the detector into an outage if it is wrong, which is why they are
 * tested as first-class behaviour rather than edge cases.
 *
 * Time is injected. A grace period tested with real timers is either a slow
 * suite or a flaky one, and neither would be trusted enough to keep.
 */

import { describe, it, expect } from '@jest/globals';

import { createDivergenceMonitor } from '../monitor.js';
import { createMemoryPeerStore } from '../memory-store.js';
import type { PeerEntry, RegistryPeerStore } from '../types.js';

const SCOPE = 'petstore-prod';
const GRACE_MS = 300_000; // 5 min, the default

/** A clock the test drives. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function monitorFor(
  store: RegistryPeerStore,
  instanceId: string,
  hash: () => string,
  now: () => number,
  overrides: Record<string, unknown> = {},
) {
  return createDivergenceMonitor({
    store,
    instanceId,
    scope: SCOPE,
    currentHash: hash,
    graceMs: GRACE_MS,
    refreshMs: 15_000,
    now,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('two instances with the same config', () => {
  it('agree, so nothing is reported', async () => {
    const store = createMemoryPeerStore();
    const c = clock();
    const a = monitorFor(store, 'pod-a', () => 'sha256:same', c.now);
    const b = monitorFor(store, 'pod-b', () => 'sha256:same', c.now);

    await a.refresh();
    const state = await b.refresh();

    expect(state.status).toBe('ok');
    expect(state.hashesInScope).toEqual(['sha256:same']);
  });
});

describe('two instances with different overlays', () => {
  it('do NOT report divergence inside the grace period', async () => {
    // This is the rolling-update case, and reporting here would break every
    // deploy — so it is asserted before the positive case.
    const store = createMemoryPeerStore();
    const c = clock();
    const a = monitorFor(store, 'pod-a', () => 'sha256:aaa', c.now);
    const b = monitorFor(store, 'pod-b', () => 'sha256:bbb', c.now);

    await a.refresh();
    const state = await b.refresh();

    expect(state.status).toBe('ok');
    expect(state.hashesInScope).toEqual(['sha256:aaa', 'sha256:bbb']);
    // ...but it SAYS so, so an operator curling the health body mid-deploy is
    // not met with unexplained silence.
    expect(state.detail).toContain('grace period');
  });

  it('report divergence once it outlasts the grace period', async () => {
    const store = createMemoryPeerStore();
    const c = clock();
    const a = monitorFor(store, 'pod-a', () => 'sha256:aaa', c.now);
    const b = monitorFor(store, 'pod-b', () => 'sha256:bbb', c.now);

    await a.refresh();
    await b.refresh();

    c.advance(GRACE_MS + 1_000);
    await a.refresh();
    const state = await b.refresh();

    expect(state.status).toBe('diverged');
    expect(state.divergedForMs).toBeGreaterThan(GRACE_MS);
    expect(state.detail).toContain('sha256:aaa');
    expect(state.detail).toContain('sha256:bbb');
  });
});

describe('a rolling update that completes', () => {
  it('clears the divergence clock rather than carrying it', async () => {
    // The property that makes the grace period safe across repeated deploys: a
    // divergence that RESOLVES must reset. Otherwise two rollouts an hour apart
    // would accumulate toward the threshold and alert on a healthy cluster.
    const store = createMemoryPeerStore();
    const c = clock();
    let bHash = 'sha256:new';
    const a = monitorFor(store, 'pod-a', () => 'sha256:old', c.now);
    const b = monitorFor(store, 'pod-b', () => bHash, c.now);

    await a.refresh();
    await b.refresh(); // diverged, inside grace

    c.advance(60_000);
    bHash = 'sha256:old'; // rollout finishes; b now matches
    await b.refresh();
    const converged = await b.refresh();
    expect(converged.status).toBe('ok');

    // A second, LATER divergence starts its own clock from zero.
    c.advance(60_000);
    bHash = 'sha256:newer';
    await b.refresh();
    c.advance(GRACE_MS - 10_000); // still inside the new window
    const state = await b.refresh();

    expect(state.status).toBe('ok');
  });
});

describe('a dead instance', () => {
  it('does not diverge the deployment forever', async () => {
    // Without expiry, one pod that died mid-deploy leaves an entry that
    // disagrees with every survivor permanently — and the first rolling update
    // would wedge readiness for good.
    const store = createMemoryPeerStore();
    const c = clock();
    const ghost = monitorFor(store, 'pod-dead', () => 'sha256:old', c.now, {
      staleAfterMs: 60_000,
    });
    const live = monitorFor(store, 'pod-live', () => 'sha256:new', c.now, {
      staleAfterMs: 60_000,
    });

    await ghost.refresh();
    await live.refresh();

    // The ghost stops refreshing; time passes well beyond both the staleness
    // window and the grace period.
    c.advance(GRACE_MS + 120_000);
    const state = await live.refresh();

    expect(state.status).toBe('ok');
    expect(state.hashesInScope).toEqual(['sha256:new']);
  });
});

describe('a peer store outage', () => {
  const broken: RegistryPeerStore = {
    put: () => Promise.reject(new Error('redis unreachable')),
    list: () => Promise.reject(new Error('redis unreachable')),
  };

  it('reports unknown, NOT diverged', async () => {
    // The monitor's dependency failing must not become the application's
    // failure — reporting `diverged` would pull a correctly-configured
    // deployment from rotation because Redis blinked.
    const c = clock();
    const m = monitorFor(broken, 'pod-a', () => 'sha256:aaa', c.now);

    const state = await m.refresh();

    expect(state.status).toBe('unknown');
    expect(state.detail).toContain('unreachable');
    expect(state.detail).toContain('not absent');
  });

  it('does not restart the divergence clock on every failed read', async () => {
    // A store failing intermittently DURING a real divergence must not
    // postpone the verdict indefinitely by resetting the timer each time.
    const store = createMemoryPeerStore();
    const c = clock();
    let fail = false;
    const flaky: RegistryPeerStore = {
      put: (entry: PeerEntry) => (fail ? Promise.reject(new Error('down')) : store.put(entry)),
      list: (scope: string) => (fail ? Promise.reject(new Error('down')) : store.list(scope)),
    };

    const other = monitorFor(store, 'pod-b', () => 'sha256:bbb', c.now);
    const m = monitorFor(flaky, 'pod-a', () => 'sha256:aaa', c.now);

    // The peer keeps refreshing throughout. It has to: entries expire after
    // `staleAfterMs`, so a peer that went quiet would age out and the
    // divergence would resolve legitimately — which is the staleness rule
    // working, and would mask the property under test here.
    await other.refresh();
    await m.refresh(); // divergence clock starts

    fail = true;
    c.advance(GRACE_MS / 2);
    await other.refresh();
    const duringOutage = await m.refresh();
    expect(duringOutage.status).toBe('unknown'); // clock must NOT reset

    fail = false;
    c.advance(GRACE_MS / 2 + 1_000);
    await other.refresh();
    const state = await m.refresh();

    // Total elapsed divergence exceeds the grace period, even though half of
    // it was spent unable to read. A reset-on-failure implementation would
    // report `ok` here, and would keep doing so for as long as the store
    // stayed flaky — postponing a real alert indefinitely.
    expect(state.status).toBe('diverged');
  });

  it('starts as unknown before the first refresh', async () => {
    // A monitor that never ran must not be mistaken for one that checked and
    // found agreement.
    const c = clock();
    const m = monitorFor(createMemoryPeerStore(), 'pod-a', () => 'sha256:aaa', c.now);

    expect(m.state().status).toBe('unknown');
    await m.refresh();
    expect(m.state().status).toBe('ok');
  });
});

describe('scope', () => {
  it('does not compare two deployments sharing one store', async () => {
    // Two deployments of different configurations in one Redis are not
    // diverged — they are two deployments. Comparing them would fire on a
    // correct setup, which is the fastest way to get a detector switched off.
    const store = createMemoryPeerStore();
    const c = clock();

    const prod = createDivergenceMonitor({
      store,
      instanceId: 'prod-a',
      scope: 'prod',
      currentHash: () => 'sha256:prod',
      graceMs: 0,
      now: c.now,
    });
    const staging = createDivergenceMonitor({
      store,
      instanceId: 'staging-a',
      scope: 'staging',
      currentHash: () => 'sha256:staging',
      graceMs: 0,
      now: c.now,
    });

    await staging.refresh();
    const state = await prod.refresh();

    expect(state.status).toBe('ok');
    expect(state.hashesInScope).toEqual(['sha256:prod']);
  });
});

describe('start/stop', () => {
  it('is idempotent and does not hold the process open', () => {
    const m = monitorFor(createMemoryPeerStore(), 'pod-a', () => 'sha256:a', () => Date.now());

    m.start();
    m.start(); // must not create a second timer
    m.stop();
    m.stop();

    expect(m.state().status).toBe('unknown');
  });
});
