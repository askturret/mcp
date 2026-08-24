// SPDX-License-Identifier: Apache-2.0
/**
 * Reload controller - compile, validate, swap, retain (§7.4).
 *
 * The one invariant everything else serves: a snapshot that failed validation
 * is NEVER published. Both reload modes retain the last-good snapshot; they
 * differ only in how the failure is surfaced to the caller.
 */

import type { RegistrySnapshot } from '../types.js';
import type { Logger } from '../sources/types.js';
import type { ReloadMode } from '../preset/types.js';
import { reloadMetricsFromRecorder } from './metrics.js';
import {
  DEFAULT_RETAIN_COUNT,
  type ReadinessState,
  type ReloadController,
  type ReloadControllerOptions,
  type ReloadErrorClass,
  type ReloadMetrics,
  type ReloadOutcome,
  type ReloadRejected,
  type ReloadResult,
  type RollbackResult,
  type SnapshotViolation,
} from './types.js';

const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const NOOP_METRICS: ReloadMetrics = {
  recordReload: () => undefined,
  recordActiveRegistry: () => undefined,
};

/**
 * Length of the hash prefix used as a metric label.
 *
 * Full hashes are unbounded-cardinality label values; a short prefix keeps the
 * `mcp_registry_operations` gauge bounded, which the issue requires explicitly.
 */
const SHORT_HASH_LENGTH = 12;

export function shortHash(hash: string): string {
  return hash.slice(0, SHORT_HASH_LENGTH);
}

/**
 * Raised by `reload()` when the controller is in `fail-fast` mode and the
 * candidate was rejected.
 *
 * Carries the full result so a caller that catches it is not worse off than a
 * caller in `degraded` mode - the failure detail is identical, only the
 * control flow differs.
 */
export class ReloadFailedError extends Error {
  readonly result: ReloadRejected;

  constructor(result: ReloadRejected) {
    super(
      `Reload rejected (${result.outcome}/${result.errorClass}): ${result.detail}. ` +
        `Retained snapshot ${shortHash(result.retainedHash)} (v${result.retainedVersion}) is still serving.`,
    );
    this.name = 'ReloadFailedError';
    this.result = result;
  }
}

/**
 * Create a reload controller over an existing registry reference.
 *
 * ## On the two reload modes
 *
 * `ReloadMode` is declared by the Production preset (§10.2) but its semantics
 * were never written down beyond `degraded`'s doc comment. The reading taken
 * here, and the reasoning:
 *
 * - `degraded` (preset default) - retain last-good, mark readiness degraded,
 *   RESOLVE with the rejected result. The server keeps serving.
 * - `fail-fast` - retain last-good, mark readiness degraded, and REJECT the
 *   promise so a caller that treats reload as part of startup fails loudly
 *   instead of silently continuing on a stale snapshot.
 *
 * What `fail-fast` deliberately does NOT mean: publishing the invalid snapshot,
 * or tearing the server down. "Reload failures do NOT take down the server" is
 * an unconditional invariant in the issue, so the mode cannot be allowed to
 * weaken it. The mode selects how the caller LEARNS about the failure, never
 * what happens to live traffic.
 *
 * ### The name is narrower than the convention (#37 QA note)
 *
 * "fail-fast" conventionally implies refuse-to-start: the process aborts rather
 * than run in a bad configuration. **This is not that.** Here BOTH modes
 * retain-and-degrade, and `fail-fast` only changes `reload()` from resolving
 * with a rejected result to rejecting its promise. A caller can build
 * refuse-to-start ON TOP of it - `await controller.reload()` unguarded during
 * boot will now propagate - but the controller never exits the process or
 * stops serving on its own, and nothing here does so implicitly.
 *
 * The name comes from `ReloadMode` in the Production preset (§10.2), so it is
 * not ours to rename unilaterally; whoever wires preset -> controller should
 * decide whether to keep it. Flagged here so that follow-up inherits the
 * discrepancy explicitly rather than discovering it from behaviour.
 *
 * Note also that `superseded` is exempt from the mode entirely: it is not a
 * candidate failure, so `fail-fast` does not throw for it. See `supersede()`.
 */
export function createReloadController(
  options: ReloadControllerOptions,
): ReloadController {
  return new DefaultReloadController(options);
}

class DefaultReloadController implements ReloadController {
  private readonly reference: ReloadControllerOptions['reference'];
  private readonly compile: ReloadControllerOptions['compile'];
  private readonly validate: ReloadControllerOptions['validate'];
  private readonly mode: ReloadMode;
  private readonly retainCount: number;
  private readonly logger: Logger;
  private readonly metrics: ReloadMetrics;

  /** Previous snapshots, most-recent first. Bounded by `retainCount`. */
  private history: RegistrySnapshot[] = [];

  /** Snapshots rolled back FROM, most-recent first. Bounded by `retainCount`. */
  private staleSnapshots: RegistrySnapshot[] = [];

  private readinessState: ReadinessState;

  /**
   * Serializes reload attempts against EACH OTHER.
   *
   * Without this, two overlapping reloads could both read `current()` as their
   * "previous", and the slower one would win the swap - publishing an older
   * candidate over a newer one, with the history recording a predecessor that
   * never actually served. Serializing is cheap because compilation is off the
   * request path anyway.
   *
   * This chain is NOT sufficient on its own, and assuming it was is what QA
   * caught on #37. `rollback()` is a SECOND WRITER to the same two pieces of
   * state (the reference and the history) and it does not run on this chain,
   * so a rollback landing between a reload's capture and its publish produced
   * exactly the failure described above - just with the operator, rather than
   * another reload, as the other writer. The compare-and-swap in `publish()`
   * is what actually closes it; this chain only orders reloads.
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: ReloadControllerOptions) {
    this.reference = options.reference;
    this.compile = options.compile;
    this.validate = options.validate;
    this.mode = options.mode ?? 'degraded';
    this.retainCount = Math.max(0, options.retain ?? DEFAULT_RETAIN_COUNT);
    this.logger = options.logger ?? NOOP_LOGGER;
    // An explicit `metrics` sink wins; otherwise bridge the §9.2 recorder if
    // one was supplied (#39). Falling all the way through to the no-op is what
    // leaves `mcp_registry_reload_total` and `mcp_registry_operations` empty.
    this.metrics =
      options.metrics ??
      (options.metricRecorder
        ? reloadMetricsFromRecorder(options.metricRecorder)
        : NOOP_METRICS);

    const initial = this.reference.current();
    this.readinessState = {
      ready: true,
      registryHash: initial.hash,
      registryVersion: initial.version,
      since: new Date(),
    };

    this.metrics.recordActiveRegistry(initial.operations.size);
  }

  current(): RegistrySnapshot {
    return this.reference.current();
  }

  retained(): readonly RegistrySnapshot[] {
    return [...this.history];
  }

  stale(): readonly RegistrySnapshot[] {
    return [...this.staleSnapshots];
  }

  readiness(): ReadinessState {
    return this.readinessState;
  }

  reload(): Promise<ReloadResult> {
    // Chain onto the tail so attempts run strictly in order. The tail absorbs
    // rejections (`() => undefined` on both paths) so one failed reload can
    // never poison every subsequent one.
    const attempt = this.tail.then(
      () => this.runReload(),
      () => this.runReload(),
    );

    this.tail = attempt.then(
      () => undefined,
      () => undefined,
    );

    return attempt;
  }

  private async runReload(): Promise<ReloadResult> {
    const previous = this.reference.current();

    let candidate: RegistrySnapshot;
    try {
      candidate = await this.compile();
    } catch (error) {
      return this.reject(previous, 'error', 'compile-failed', describeError(error), []);
    }

    let violations: readonly SnapshotViolation[];
    try {
      violations = this.validate ? await this.validate(candidate) : [];
    } catch (error) {
      // A validator that THREW is not the same as a candidate that failed
      // validation: we learned nothing about the candidate, so it cannot be
      // trusted. Same retention, different outcome label.
      return this.reject(
        previous,
        'error',
        'validation-failed',
        `Validator threw: ${describeError(error)}`,
        [],
      );
    }

    if (violations.length > 0) {
      return this.reject(
        previous,
        'invalid',
        'validation-failed',
        `Candidate ${shortHash(candidate.hash)} failed validation with ${violations.length} violation(s)`,
        violations,
      );
    }

    // COMPARE-AND-SWAP (#37 QA fix).
    //
    // `previous` was captured before the first await, so between then and now
    // the reference may have moved. The tail chain rules out another RELOAD
    // having moved it; it does not rule out `rollback()`, which is synchronous
    // and does not run on that chain.
    //
    // Identity, not hash, is the right comparison: the question is "is the
    // reference still holding the exact object I measured myself against",
    // and two structurally identical snapshots are still distinct entries as
    // far as history and rollback bookkeeping are concerned.
    const live = this.reference.current();
    if (live !== previous) {
      return this.supersede(previous, live, candidate);
    }

    return this.publish(previous, candidate);
  }

  /**
   * A reload that lost a race with an operator rollback.
   *
   * Handled separately from `reject()` because it is NOT a fault:
   *
   * - Readiness is left ALONE. The snapshot now serving is one the operator
   *   deliberately chose and that previously served successfully. Flipping
   *   readiness to degraded would report the remedy as the problem.
   * - `fail-fast` does NOT throw. That mode exists to make a BAD CANDIDATE
   *   loud at startup; a supersede says nothing about the candidate.
   * - Nothing is pushed to history and nothing is swapped, so the rollback's
   *   own bookkeeping stands untouched.
   *
   * The candidate is discarded rather than retried. Retrying here would mean
   * recompiling against a reference the operator is actively moving, which
   * risks a livelock between a rollback loop and a reload loop; the caller (or
   * the next watcher event) re-triggers instead.
   */
  private supersede(
    expected: RegistrySnapshot,
    live: RegistrySnapshot,
    candidate: RegistrySnapshot,
  ): ReloadResult {
    const detail =
      `Candidate ${shortHash(candidate.hash)} was superseded: the registry moved from ` +
      `${shortHash(expected.hash)} (v${expected.version}) to ${shortHash(live.hash)} ` +
      `(v${live.version}) while it was compiling. Discarded rather than published ` +
      `over the newer state.`;

    // The `superseded` class is what lets a consumer exclude this from a
    // reload-error alert (#39, closing a QA note on #37). Without it a benign
    // rollback race is indistinguishable from a real compile failure.
    this.metrics.recordReload('error', 'superseded');

    this.logger.info('Registry reload superseded - candidate discarded', {
      candidateHash: candidate.hash,
      expectedHash: expected.hash,
      liveHash: live.hash,
      liveVersion: live.version,
    });

    return {
      outcome: 'error',
      errorClass: 'superseded',
      retainedHash: live.hash,
      retainedVersion: live.version,
      detail,
      violations: [],
    };
  }

  /**
   * Atomic swap plus bookkeeping. The swap itself is the single reference
   * assignment in `AtomicRegistryReference`; everything around it is recording.
   */
  private publish(
    previous: RegistrySnapshot,
    candidate: RegistrySnapshot,
  ): ReloadResult {
    this.pushHistory(previous);

    this.reference.swap(candidate);

    this.readinessState = {
      ready: true,
      registryHash: candidate.hash,
      registryVersion: candidate.version,
      since: new Date(),
    };

    this.metrics.recordReload('success');
    this.metrics.recordActiveRegistry(candidate.operations.size);

    this.logger.info('Registry reload published', {
      previousHash: previous.hash,
      previousVersion: previous.version,
      hash: candidate.hash,
      version: candidate.version,
      operationCount: candidate.operations.size,
    });

    return {
      outcome: 'success',
      previousHash: previous.hash,
      previousVersion: previous.version,
      hash: candidate.hash,
      version: candidate.version,
    };
  }

  private reject(
    retained: RegistrySnapshot,
    outcome: Exclude<ReloadOutcome, 'success'>,
    errorClass: ReloadErrorClass,
    detail: string,
    violations: readonly SnapshotViolation[],
  ): ReloadResult {
    const result: ReloadRejected = {
      outcome,
      errorClass,
      retainedHash: retained.hash,
      retainedVersion: retained.version,
      detail,
      violations,
    };

    this.readinessState = {
      ready: false,
      registryHash: retained.hash,
      registryVersion: retained.version,
      errorClass,
      detail,
      since: new Date(),
    };

    this.metrics.recordReload(outcome, errorClass);

    this.logger.warn('Registry reload rejected - retaining previous snapshot', {
      outcome,
      errorClass,
      detail,
      retainedHash: retained.hash,
      retainedVersion: retained.version,
      violationCount: violations.length,
    });

    if (this.mode === 'fail-fast') {
      throw new ReloadFailedError(result);
    }

    return result;
  }

  rollback(): RollbackResult {
    const from = this.reference.current();
    const target = this.history.shift();

    if (!target) {
      this.logger.warn('Rollback requested with no retained snapshot', {
        retainedHash: from.hash,
      });
      return {
        rolledBack: false,
        reason: 'no-retained-snapshot',
        retainedHash: from.hash,
      };
    }

    this.reference.swap(target);

    // The snapshot we rolled back FROM is kept, bounded, so an operator can
    // see what was rejected rather than having it vanish.
    this.staleSnapshots.unshift(from);
    if (this.staleSnapshots.length > this.retainCount) {
      this.staleSnapshots.length = this.retainCount;
    }

    // Rolling back is a deliberate operator action returning to a snapshot
    // that WAS good, so readiness is restored. Leaving it degraded would make
    // rollback - the remedy - look like part of the fault.
    this.readinessState = {
      ready: true,
      registryHash: target.hash,
      registryVersion: target.version,
      since: new Date(),
    };

    this.metrics.recordActiveRegistry(target.operations.size);

    this.logger.info('Registry rolled back', {
      fromHash: from.hash,
      fromVersion: from.version,
      toHash: target.hash,
      toVersion: target.version,
    });

    return {
      rolledBack: true,
      fromHash: from.hash,
      fromVersion: from.version,
      toHash: target.hash,
      toVersion: target.version,
    };
  }

  private pushHistory(snapshot: RegistrySnapshot): void {
    if (this.retainCount === 0) {
      return;
    }
    this.history.unshift(snapshot);
    if (this.history.length > this.retainCount) {
      this.history.length = this.retainCount;
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
