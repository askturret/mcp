// SPDX-License-Identifier: Apache-2.0
/**
 * Reload controller tests - swap, retention, rollback, readiness, metrics.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { AtomicRegistryReference } from '../../registry-reference.js';
import {
  createReloadController,
  ReloadFailedError,
  shortHash,
} from '../controller.js';
import type { ReloadMetrics, ReloadOutcome, SnapshotViolation } from '../types.js';
import { snapshot } from './fixtures.js';

function recordingMetrics(): {
  metrics: ReloadMetrics;
  reloads: ReloadOutcome[];
  gauges: Array<{ hash: string; count: number }>;
} {
  const reloads: ReloadOutcome[] = [];
  const gauges: Array<{ hash: string; count: number }> = [];
  return {
    reloads,
    gauges,
    metrics: {
      recordReload: (outcome) => {
        reloads.push(outcome);
      },
      recordActiveRegistry: (hash, count) => {
        gauges.push({ hash, count });
      },
    },
  };
}

const VIOLATION: SnapshotViolation = {
  code: 'effect-incoherent',
  message: 'readOnly operation declares a destructive classification',
};

describe('createReloadController', () => {
  it('swaps in a valid candidate and reports both hashes', async () => {
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);

    const controller = createReloadController({
      reference: ref,
      compile: async () => v2,
    });

    const result = await controller.reload();

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') throw new Error('unreachable');
    expect(result.previousHash).toBe(v1.hash);
    expect(result.hash).toBe(v2.hash);
    expect(ref.current().hash).toBe(v2.hash);
  });

  it('retains the previous snapshot when the candidate fails validation', async () => {
    const v1 = snapshot(1, ['a']);
    const bad = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);

    const controller = createReloadController({
      reference: ref,
      compile: async () => bad,
      validate: () => [VIOLATION],
    });

    const result = await controller.reload();

    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'success') throw new Error('unreachable');
    expect(result.errorClass).toBe('validation-failed');
    expect(result.violations).toEqual([VIOLATION]);

    // The invariant that matters: nothing invalid ever reached the reference.
    expect(ref.current().hash).toBe(v1.hash);
    expect(controller.current().hash).toBe(v1.hash);
  });

  it('flips readiness to degraded on rejection and back on the next success', async () => {
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);

    let valid = false;
    const controller = createReloadController({
      reference: ref,
      compile: async () => v2,
      validate: () => (valid ? [] : [VIOLATION]),
    });

    expect(controller.readiness().ready).toBe(true);

    await controller.reload();
    const degraded = controller.readiness();
    expect(degraded.ready).toBe(false);
    expect(degraded.errorClass).toBe('validation-failed');
    // Readiness reports the snapshot STILL SERVING, not the rejected candidate.
    expect(degraded.registryHash).toBe(v1.hash);

    valid = true;
    await controller.reload();
    const recovered = controller.readiness();
    expect(recovered.ready).toBe(true);
    expect(recovered.registryHash).toBe(v2.hash);
    expect(recovered.errorClass).toBeUndefined();
  });

  it('treats a compile throw as error, not invalid, and keeps serving', async () => {
    const v1 = snapshot(1, ['a']);
    const ref = new AtomicRegistryReference(v1);

    const controller = createReloadController({
      reference: ref,
      compile: async () => {
        throw new Error('spec file is unparseable');
      },
    });

    const result = await controller.reload();

    expect(result.outcome).toBe('error');
    if (result.outcome === 'success') throw new Error('unreachable');
    expect(result.errorClass).toBe('compile-failed');
    expect(result.detail).toContain('unparseable');
    expect(ref.current().hash).toBe(v1.hash);
  });

  it('treats a throwing validator as error rather than as a passed validation', async () => {
    // The dangerous failure would be treating "the validator blew up" as
    // "nothing to report, therefore valid" and publishing an unchecked
    // candidate.
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);

    const controller = createReloadController({
      reference: ref,
      compile: async () => v2,
      validate: () => {
        throw new Error('validator exploded');
      },
    });

    const result = await controller.reload();

    expect(result.outcome).toBe('error');
    if (result.outcome === 'success') throw new Error('unreachable');
    expect(result.errorClass).toBe('validation-failed');
    expect(ref.current().hash).toBe(v1.hash);
  });

  it('rejects the promise in fail-fast mode but still retains last-good', async () => {
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);

    const controller = createReloadController({
      reference: ref,
      compile: async () => v2,
      validate: () => [VIOLATION],
      mode: 'fail-fast',
    });

    await expect(controller.reload()).rejects.toBeInstanceOf(ReloadFailedError);

    // fail-fast changes how the caller LEARNS of the failure, never whether
    // an invalid snapshot goes live.
    expect(ref.current().hash).toBe(v1.hash);
    expect(controller.readiness().ready).toBe(false);
  });

  it('records reload outcomes and a short, bounded registry-hash label', async () => {
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);
    const { metrics, reloads, gauges } = recordingMetrics();

    let valid = true;
    const controller = createReloadController({
      reference: ref,
      compile: async () => v2,
      validate: () => (valid ? [] : [VIOLATION]),
      metrics,
    });

    await controller.reload();
    valid = false;
    await controller.reload();

    expect(reloads).toEqual(['success', 'invalid']);

    // Construction gauge + one per successful swap.
    expect(gauges).toEqual([
      { hash: shortHash(v1.hash), count: 1 },
      { hash: shortHash(v2.hash), count: 2 },
    ]);
    // Low cardinality is the point of the short label.
    for (const gauge of gauges) {
      expect(gauge.hash.length).toBe(12);
      expect(v1.hash.length).toBeGreaterThan(gauge.hash.length);
    }
  });

  it('logs every reload with old and new hash', async () => {
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);
    const info = jest.fn();

    const controller = createReloadController({
      reference: ref,
      compile: async () => v2,
      logger: { debug: jest.fn(), info, warn: jest.fn(), error: jest.fn() },
    });

    await controller.reload();

    expect(info).toHaveBeenCalledWith(
      'Registry reload published',
      expect.objectContaining({ previousHash: v1.hash, hash: v2.hash }),
    );
  });
});

describe('retention and rollback', () => {
  it('keeps the previous 3 snapshots by default and evicts the oldest', async () => {
    const versions = [
      snapshot(1, ['a']),
      snapshot(2, ['a', 'b']),
      snapshot(3, ['a', 'b', 'c']),
      snapshot(4, ['a', 'b', 'c', 'd']),
      snapshot(5, ['a', 'b', 'c', 'd', 'e']),
    ];
    const ref = new AtomicRegistryReference(versions[0]!);

    let next = 1;
    const controller = createReloadController({
      reference: ref,
      compile: async () => versions[next++]!,
    });

    await controller.reload();
    await controller.reload();
    await controller.reload();
    await controller.reload();

    const retained = controller.retained();
    expect(retained).toHaveLength(3);
    // Most-recent first; v1 has been evicted past the window.
    expect(retained.map((s) => s.version)).toEqual([4, 3, 2]);
  });

  it('rolls back to the immediately previous snapshot', async () => {
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const v3 = snapshot(3, ['a', 'b', 'c']);
    const ref = new AtomicRegistryReference(v1);

    const queue = [v2, v3];
    const controller = createReloadController({
      reference: ref,
      compile: async () => queue.shift()!,
    });

    await controller.reload();
    await controller.reload();
    expect(ref.current().version).toBe(3);

    const result = controller.rollback();

    expect(result.rolledBack).toBe(true);
    if (!result.rolledBack) throw new Error('unreachable');
    expect(result.fromVersion).toBe(3);
    expect(result.toVersion).toBe(2);
    expect(ref.current().hash).toBe(v2.hash);
  });

  it('walks further back on repeated rollback and retains what it left', async () => {
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const v3 = snapshot(3, ['a', 'b', 'c']);
    const ref = new AtomicRegistryReference(v1);

    const queue = [v2, v3];
    const controller = createReloadController({
      reference: ref,
      compile: async () => queue.shift()!,
    });

    await controller.reload();
    await controller.reload();

    controller.rollback();
    controller.rollback();

    expect(ref.current().hash).toBe(v1.hash);
    // The snapshots rolled back FROM are kept rather than discarded.
    expect(controller.stale().map((s) => s.version)).toEqual([2, 3]);
  });

  it('restores readiness on rollback, since rollback is the remedy', async () => {
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);

    let valid = true;
    const controller = createReloadController({
      reference: ref,
      compile: async () => v2,
      validate: () => (valid ? [] : [VIOLATION]),
    });

    await controller.reload();
    valid = false;
    await controller.reload();
    expect(controller.readiness().ready).toBe(false);

    controller.rollback();

    expect(controller.readiness().ready).toBe(true);
    expect(controller.readiness().registryHash).toBe(v1.hash);
  });

  it('refuses to roll back past the retained window instead of throwing', () => {
    const v1 = snapshot(1, ['a']);
    const ref = new AtomicRegistryReference(v1);
    const controller = createReloadController({
      reference: ref,
      compile: async () => v1,
    });

    const result = controller.rollback();

    expect(result.rolledBack).toBe(false);
    if (result.rolledBack) throw new Error('unreachable');
    expect(result.reason).toBe('no-retained-snapshot');
    expect(ref.current().hash).toBe(v1.hash);
  });
});

describe('concurrency', () => {
  it('serializes overlapping reloads so the newest candidate ends up live', async () => {
    // Without serialization both attempts read v1 as "previous" and the
    // slower one swaps last, publishing the OLDER candidate over the newer.
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const v3 = snapshot(3, ['a', 'b', 'c']);
    const ref = new AtomicRegistryReference(v1);

    const queue = [
      { snap: v2, delayMs: 40 },
      { snap: v3, delayMs: 0 },
    ];

    const controller = createReloadController({
      reference: ref,
      compile: async () => {
        const job = queue.shift()!;
        await new Promise((resolve) => setTimeout(resolve, job.delayMs));
        return job.snap;
      },
    });

    const [first, second] = await Promise.all([
      controller.reload(),
      controller.reload(),
    ]);

    expect(first.outcome).toBe('success');
    expect(second.outcome).toBe('success');
    expect(ref.current().hash).toBe(v3.hash);

    // Serialized, so the second attempt saw the first one's result as its
    // predecessor rather than both racing from v1.
    if (second.outcome !== 'success') throw new Error('unreachable');
    expect(second.previousHash).toBe(v2.hash);
  });

  it('does not let one failed reload poison subsequent ones', async () => {
    const v1 = snapshot(1, ['a']);
    const v2 = snapshot(2, ['a', 'b']);
    const ref = new AtomicRegistryReference(v1);

    let firstCall = true;
    const controller = createReloadController({
      reference: ref,
      compile: async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error('transient read failure');
        }
        return v2;
      },
      mode: 'fail-fast',
    });

    await expect(controller.reload()).rejects.toBeInstanceOf(ReloadFailedError);

    const recovered = await controller.reload();
    expect(recovered.outcome).toBe('success');
    expect(ref.current().hash).toBe(v2.hash);
  });
});
