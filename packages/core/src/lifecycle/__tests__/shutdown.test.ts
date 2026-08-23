// SPDX-License-Identifier: Apache-2.0
/**
 * The §8.6 shutdown sequence.
 *
 * The acceptance criterion is "shutdown sequence exactly matches §8.6", which
 * is an ORDER claim — so these tests record the order phases actually ran in
 * and compare it against the published constant, rather than checking that
 * each phase happened at some point.
 */

import { describe, it, expect } from '@jest/globals';

import { SHUTDOWN_SEQUENCE, createShutdownCoordinator } from '../index.js';
import type { ShutdownHooks } from '../types.js';

/** Records the order in which hooks fire. */
function recorder() {
  const order: string[] = [];
  const mark = (name: string) => () => {
    order.push(name);
  };

  const hooks: ShutdownHooks = {
    markNotReady: mark('mark-not-ready'),
    stopAccepting: mark('stop-accepting'),
    cancelQueued: mark('cancel-queued'),
    drainInFlight: async () => {
      order.push('drain-in-flight');
    },
    cancelInFlight: mark('cancel-in-flight'),
    flushAudit: async () => {
      order.push('flush-audit');
    },
    flushTelemetry: async () => {
      order.push('flush-telemetry');
    },
    closeResources: async () => {
      order.push('close-resources');
    },
  };

  return { order, hooks };
}

describe('sequence order (§8.6, immovable)', () => {
  it('runs the phases §8.6 lists, in the order §8.6 lists them', async () => {
    // Hardcoded, NOT compared against SHUTDOWN_SEQUENCE.
    //
    // Mutation testing showed why: swapping two entries in the constant left
    // an `expect(result.phases).toEqual(SHUTDOWN_SEQUENCE)` assertion green,
    // because both sides moved together. That check is worth keeping for what
    // it does prove — no phase skipped, none run twice — but it cannot pin
    // the ORDER, which is the actual acceptance criterion. This transcribes
    // §8.6 by hand so the spec and the code are two independent statements.
    const { order, hooks } = recorder();

    const result = await createShutdownCoordinator(hooks).shutdown();

    expect(result.phases).toEqual([
      'mark-not-ready',
      'stop-accepting',
      'cancel-queued',
      'drain-in-flight',
      'flush-audit',
      'flush-telemetry',
      'close-resources',
    ]);
    expect(order.filter((o) => o !== 'cancel-in-flight')).toEqual([...result.phases]);
  });

  it('keeps the published constant in step with what actually runs', async () => {
    // The complementary half: catches a phase that is declared but never
    // reached, or reached twice.
    const { hooks } = recorder();

    const result = await createShutdownCoordinator(hooks).shutdown();

    expect(result.phases).toEqual(SHUTDOWN_SEQUENCE);
  });

  it('marks not-ready FIRST, before it stops accepting', async () => {
    // The ordering that matters most operationally: a load balancer needs to
    // see 503 on /ready and drain its pool BEFORE the transport starts
    // refusing calls, or in-flight traffic is refused mid-rotation.
    const { order, hooks } = recorder();

    await createShutdownCoordinator(hooks).shutdown();

    expect(order.indexOf('mark-not-ready')).toBeLessThan(order.indexOf('stop-accepting'));
  });

  it('flushes audit BEFORE telemetry', async () => {
    // §8.6 gives audit stronger delivery. If telemetry went first, a slow
    // exporter would eat the shutdown budget ahead of the records that must
    // not be lost.
    const { order, hooks } = recorder();

    await createShutdownCoordinator(hooks).shutdown();

    expect(order.indexOf('flush-audit')).toBeLessThan(order.indexOf('flush-telemetry'));
  });

  it('closes resources LAST, after audit is flushed', async () => {
    // Closing the transport before flushing audit would take the sink's own
    // connection down with it.
    const { order, hooks } = recorder();

    await createShutdownCoordinator(hooks).shutdown();

    expect(order.indexOf('flush-audit')).toBeLessThan(order.indexOf('close-resources'));
    expect(order[order.length - 1]).toBe('close-resources');
  });
});

describe('drain deadline (§8.6 phase 4)', () => {
  it('returns at the deadline and cancels in-flight calls', async () => {
    // §8.6's stated case, scaled down: an executor that outlasts the drain
    // window. `close()` must return at the deadline, not at the hang.
    const order: string[] = [];
    let cancelled = false;

    const coordinator = createShutdownCoordinator({
      drainInFlight: () => new Promise<void>(() => undefined), // never resolves
      cancelInFlight: () => {
        cancelled = true;
        order.push('cancel-in-flight');
      },
      flushAudit: async () => {
        order.push('flush-audit');
      },
    });

    const startedAt = Date.now();
    const result = await coordinator.shutdown({ drainMs: 50 });

    expect(result.drainTimedOut).toBe(true);
    expect(cancelled).toBe(true);
    // The drain was capped, not waited out.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // And audit STILL flushed afterwards — a timed-out drain must not skip it.
    expect(order).toEqual(['cancel-in-flight', 'flush-audit']);
    expect(result.auditFlushed).toBe(true);
  });

  it('does not report a timeout when the drain finishes in time', async () => {
    let cancelled = false;

    const result = await createShutdownCoordinator({
      drainInFlight: async () => undefined,
      cancelInFlight: () => {
        cancelled = true;
      },
    }).shutdown({ drainMs: 1_000 });

    expect(result.drainTimedOut).toBe(false);
    // Cancelling calls that finished on their own would turn a clean drain
    // into spurious CANCELLED results for work that had already succeeded.
    expect(cancelled).toBe(false);
  });
});

describe('forceClose (§8.6)', () => {
  it('skips the drain but still cancels and still flushes audit', async () => {
    const order: string[] = [];
    let drained = false;

    const result = await createShutdownCoordinator({
      drainInFlight: async () => {
        drained = true;
      },
      cancelInFlight: () => {
        order.push('cancel-in-flight');
      },
      flushAudit: async () => {
        order.push('flush-audit');
      },
    }).shutdown({ force: true });

    expect(drained).toBe(false);
    expect(result.forced).toBe(true);
    // "still tries to flush audit" — the invariant §8.6 states explicitly.
    expect(order).toEqual(['cancel-in-flight', 'flush-audit']);
    expect(result.auditFlushed).toBe(true);
  });
});

describe('audit-delivery invariant', () => {
  it('flushes audit even when every earlier phase throws', async () => {
    // The invariant that decides whether the sequence collects errors or
    // aborts on them. Audit is phase 5, so anything that stops at the first
    // failure loses exactly the records §8.6 exists to preserve.
    let flushed = false;

    const boom = () => {
      throw new Error('phase failed');
    };

    const result = await createShutdownCoordinator({
      markNotReady: boom,
      stopAccepting: boom,
      cancelQueued: boom,
      drainInFlight: async () => boom(),
      flushAudit: async () => {
        flushed = true;
      },
    }).shutdown();

    expect(flushed).toBe(true);
    expect(result.auditFlushed).toBe(true);
    expect(result.errors.map((e) => e.phase)).toEqual([
      'mark-not-ready',
      'stop-accepting',
      'cancel-queued',
      'drain-in-flight',
    ]);
  });

  it('continues to later phases when the audit flush itself fails', async () => {
    let closed = false;

    const result = await createShutdownCoordinator({
      flushAudit: async () => {
        throw new Error('sink unreachable');
      },
      closeResources: async () => {
        closed = true;
      },
    }).shutdown();

    // Reported as NOT flushed — an unreachable sink must be visible to the
    // caller, not swallowed into a successful-looking shutdown.
    expect(result.auditFlushed).toBe(false);
    expect(result.errors.map((e) => e.phase)).toEqual(['flush-audit']);
    // But resources still close: leaving the process holding sockets because
    // the audit sink was down helps nobody.
    expect(closed).toBe(true);
  });

  it('never leaks an exception type or stack into the result', async () => {
    class SecretError extends Error {}

    const result = await createShutdownCoordinator({
      flushAudit: async () => {
        throw new SecretError('connection string postgres://user:pw@host');
      },
    }).shutdown();

    expect(result.errors[0]?.message).toBe('connection string postgres://user:pw@host');
    expect(JSON.stringify(result)).not.toContain('SecretError');
  });
});

describe('telemetry flush is bounded (§8.6 phase 6)', () => {
  it('gives up on a hanging exporter instead of holding the process open', async () => {
    let closed = false;

    const startedAt = Date.now();
    const result = await createShutdownCoordinator({
      flushTelemetry: () => new Promise<void>(() => undefined), // never resolves
      closeResources: async () => {
        closed = true;
      },
    }).shutdown({ telemetryFlushMs: 50 });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(closed).toBe(true);
    // Best-effort: a telemetry timeout is not an error worth reporting, since
    // the metrics are lost either way and nothing downstream can act on it.
    expect(result.errors).toEqual([]);
  });
});

describe('idempotency', () => {
  it('runs the sequence once however many times close() is called', async () => {
    let flushes = 0;

    const coordinator = createShutdownCoordinator({
      flushAudit: async () => {
        flushes += 1;
      },
    });

    const [a, b, c] = await Promise.all([
      coordinator.shutdown(),
      coordinator.shutdown(),
      coordinator.shutdown(),
    ]);

    // Two concurrent drains would double-flush the sink and race to close the
    // same resources.
    expect(flushes).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('reports shutting-down from the instant the first call starts', async () => {
    // Readiness reads this flag, so it has to be true BEFORE phase 1 runs —
    // otherwise there is a window where the server is shutting down and
    // /health/ready still says 200.
    const coordinator = createShutdownCoordinator({
      markNotReady: () => {
        expect(coordinator.isShuttingDown).toBe(true);
      },
    });

    expect(coordinator.isShuttingDown).toBe(false);
    const pending = coordinator.shutdown();
    expect(coordinator.isShuttingDown).toBe(true);
    await pending;
  });
});

describe('missing hooks', () => {
  it('runs every phase even when nothing is wired', async () => {
    // A phase with no hook is recorded as having run with nothing to do,
    // which is different from being skipped — the transport deliberately
    // supplies no cancel-queued hook, and that must not read as a gap.
    const result = await createShutdownCoordinator({}).shutdown();

    expect(result.phases).toEqual(SHUTDOWN_SEQUENCE);
    expect(result.errors).toEqual([]);
    expect(result.auditFlushed).toBe(true);
  });
});
