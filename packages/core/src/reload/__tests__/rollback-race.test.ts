// SPDX-License-Identifier: Apache-2.0
/**
 * Rollback/reload interleaving (QA FAIL on #37).
 *
 * `rollback()` is synchronous and mutates the reference plus the history
 * OUTSIDE the tail chain, while `runReload()` captures `previous` BEFORE its
 * first await. So an operator rollback landing between a reload's capture and
 * its publish used to be silently overwritten by that reload.
 *
 * This is verbatim the failure the original serialization comment described -
 * "history recording a predecessor that never actually served". That comment's
 * reasoning was right; it just only ever considered reload-vs-reload, and
 * missed rollback as a SECOND WRITER to the same two pieces of state.
 *
 * The guard is a compare-and-swap in publish(): a reload whose captured
 * `previous` is no longer what the reference holds has been superseded, and
 * must not publish.
 */

import { describe, it, expect } from '@jest/globals';
import { AtomicRegistryReference } from '../../registry-reference.js';
import { createReloadController } from '../controller.js';
import type { ReloadMetrics, ReloadOutcome } from '../types.js';
import { snapshot } from './fixtures.js';

/**
 * Drive a controller to v3 with two reloads, then park a THIRD reload inside
 * compile() so a rollback can interleave with it.
 */
async function parkedAtV3() {
  const v1 = snapshot(1, ['a']);
  const v2 = snapshot(2, ['a', 'b']);
  const v3 = snapshot(3, ['a', 'b', 'c']);
  const v4 = snapshot(4, ['a', 'b', 'c', 'd']);
  const ref = new AtomicRegistryReference(v1);

  const outcomes: ReloadOutcome[] = [];
  const metrics: ReloadMetrics = {
    recordReload: (o) => {
      outcomes.push(o);
    },
    recordActiveRegistry: () => undefined,
  };

  // Third compile parks until released, so the rollback lands mid-flight.
  let releaseCompile!: () => void;
  const compileGate = new Promise<void>((resolve) => {
    releaseCompile = resolve;
  });

  const queue = [v2, v3];
  const controller = createReloadController({
    reference: ref,
    compile: async () => {
      const queued = queue.shift();
      if (queued) return queued;
      await compileGate;
      return v4;
    },
    metrics,
  });

  await controller.reload(); // -> v2
  await controller.reload(); // -> v3
  expect(ref.current().hash).toBe(v3.hash);

  return { v1, v2, v3, v4, ref, controller, releaseCompile, outcomes };
}

describe('rollback racing an in-flight reload', () => {
  it('does not let a mid-flight reload silently undo a rollback', async () => {
    const { v2, v3, v4, ref, controller, releaseCompile } = await parkedAtV3();

    // Reload starts and parks inside compile(), having already captured v3.
    const inFlight = controller.reload();
    await new Promise((resolve) => setImmediate(resolve));

    // Operator rolls back v3 -> v2 while that reload is still parked.
    const rollback = controller.rollback();
    expect(rollback.rolledBack).toBe(true);
    expect(ref.current().hash).toBe(v2.hash);

    // The parked reload now completes. It must NOT publish v4 over the
    // rollback the operator just performed.
    releaseCompile();
    const result = await inFlight;

    expect(ref.current().hash).toBe(v2.hash);
    expect(ref.current().hash).not.toBe(v4.hash);
    expect(ref.current().hash).not.toBe(v3.hash);

    expect(result.outcome).not.toBe('success');
    if (result.outcome === 'success') throw new Error('unreachable');
    expect(result.errorClass).toBe('superseded');
    expect(result.retainedHash).toBe(v2.hash);
  });

  it('keeps the rollback target recoverable rather than losing it', async () => {
    // The original defect made v2 unrecoverable: it was shifted off history by
    // the rollback, then the reload pushed v3 back on, so nothing pointed at
    // v2 any more.
    const { v1, v2, ref, controller, releaseCompile } = await parkedAtV3();

    const inFlight = controller.reload();
    await new Promise((resolve) => setImmediate(resolve));
    controller.rollback();
    releaseCompile();
    await inFlight;

    expect(ref.current().hash).toBe(v2.hash);
    // v1 is still behind v2, so the operator can keep walking back.
    expect(controller.retained().map((s) => s.version)).toEqual([1]);

    const second = controller.rollback();
    expect(second.rolledBack).toBe(true);
    expect(ref.current().hash).toBe(v1.hash);
  });

  it('never lists the same snapshot as both retained and stale', async () => {
    // The original defect put v3 in BOTH lists at once - retained by the
    // superseding reload, stale from the rollback.
    const { ref, controller, releaseCompile } = await parkedAtV3();

    const inFlight = controller.reload();
    await new Promise((resolve) => setImmediate(resolve));
    controller.rollback();
    releaseCompile();
    await inFlight;

    const retained = controller.retained().map((s) => s.hash);
    const stale = controller.stale().map((s) => s.hash);
    const overlap = retained.filter((h) => stale.includes(h));

    expect(overlap).toEqual([]);
    // And the live snapshot is in neither list.
    expect(retained).not.toContain(ref.current().hash);
    expect(stale).not.toContain(ref.current().hash);
  });

  it('leaves readiness TRUE, because a rollback is not a fault', async () => {
    // A superseded reload must not look like a failure: the operator asked for
    // the rollback, and the snapshot now serving is a known-good one. Flipping
    // readiness would make the remedy look like the problem.
    const { controller, releaseCompile } = await parkedAtV3();

    const inFlight = controller.reload();
    await new Promise((resolve) => setImmediate(resolve));
    controller.rollback();
    releaseCompile();
    await inFlight;

    const readiness = controller.readiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.errorClass).toBeUndefined();
  });

  it('records the superseded attempt as a reload outcome', async () => {
    const { controller, releaseCompile, outcomes } = await parkedAtV3();

    const inFlight = controller.reload();
    await new Promise((resolve) => setImmediate(resolve));
    controller.rollback();
    releaseCompile();
    await inFlight;

    // Two successes from the setup, then the superseded attempt.
    expect(outcomes).toEqual(['success', 'success', 'error']);
  });

  it('lets a FRESH reload succeed after a supersede, from the rolled-back state', async () => {
    // Supersede must not wedge the controller - the next reload compiles
    // against the new current and publishes normally.
    const { v2, v4, ref, controller, releaseCompile } = await parkedAtV3();

    const inFlight = controller.reload();
    await new Promise((resolve) => setImmediate(resolve));
    controller.rollback();
    releaseCompile();
    await inFlight;
    expect(ref.current().hash).toBe(v2.hash);

    const retry = await controller.reload();

    expect(retry.outcome).toBe('success');
    if (retry.outcome !== 'success') throw new Error('unreachable');
    expect(retry.previousHash).toBe(v2.hash);
    expect(ref.current().hash).toBe(v4.hash);
  });

  it('still reports an accurate predecessor when NO rollback interleaves', async () => {
    // The guard must not change the ordinary path.
    const { v3, v4, ref, controller, releaseCompile } = await parkedAtV3();

    const inFlight = controller.reload();
    await new Promise((resolve) => setImmediate(resolve));
    releaseCompile();
    const result = await inFlight;

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') throw new Error('unreachable');
    expect(result.previousHash).toBe(v3.hash);
    expect(ref.current().hash).toBe(v4.hash);
  });

  it('supersedes in fail-fast mode without rejecting the promise', async () => {
    // fail-fast exists to make a BAD CANDIDATE loud. A supersede is not a bad
    // candidate - it is a healthy operator action winning a race - so it must
    // not be escalated to a throw.
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const v3 = snapshot(3, ['a', 'b', 'c']);
    const ref = new AtomicRegistryReference(v1);

    let releaseCompile!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCompile = resolve;
    });

    const queue = [v2];
    const controller = createReloadController({
      reference: ref,
      compile: async () => {
        const queued = queue.shift();
        if (queued) return queued;
        await gate;
        return v3;
      },
      mode: 'fail-fast',
    });

    await controller.reload(); // -> v2

    const inFlight = controller.reload();
    await new Promise((resolve) => setImmediate(resolve));
    controller.rollback(); // -> v1
    releaseCompile();

    const result = await inFlight;
    expect(result.outcome).toBe('error');
    if (result.outcome === 'success') throw new Error('unreachable');
    expect(result.errorClass).toBe('superseded');
    expect(ref.current().hash).toBe(v1.hash);
  });
});
