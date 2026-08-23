// SPDX-License-Identifier: Apache-2.0
/**
 * The §8.6 shutdown coordinator.
 */

import {
  SHUTDOWN_SEQUENCE,
  type ShutdownHooks,
  type ShutdownOptions,
  type ShutdownPhase,
  type ShutdownPhaseError,
  type ShutdownResult,
} from './types.js';

export const DEFAULT_DRAIN_MS = 30_000;
export const DEFAULT_TELEMETRY_FLUSH_MS = 5_000;

/**
 * Run the §8.6 sequence exactly once.
 *
 * Idempotent by construction: the first call owns the shutdown and every
 * later call receives that same promise. Two concurrent `close()` calls
 * running two drains would double-flush the audit sink and race each other to
 * close the same resources.
 */
export function createShutdownCoordinator(hooks: ShutdownHooks) {
  let inFlight: Promise<ShutdownResult> | undefined;
  let shuttingDown = false;

  return {
    /** True from the instant a shutdown starts, for readiness to read. */
    get isShuttingDown(): boolean {
      return shuttingDown;
    },

    shutdown(options: ShutdownOptions = {}): Promise<ShutdownResult> {
      if (inFlight !== undefined) return inFlight;
      shuttingDown = true;
      inFlight = runSequence(hooks, options);
      return inFlight;
    },
  };
}

async function runSequence(
  hooks: ShutdownHooks,
  options: ShutdownOptions,
): Promise<ShutdownResult> {
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  const telemetryFlushMs = options.telemetryFlushMs ?? DEFAULT_TELEMETRY_FLUSH_MS;
  const forced = options.force === true;

  const phases: ShutdownPhase[] = [];
  const errors: ShutdownPhaseError[] = [];
  let drainTimedOut = false;
  let auditFlushed = false;

  /**
   * Run one phase, recording rather than propagating any failure.
   *
   * This is what makes the sequence total: every phase is attempted even if
   * an earlier one threw. See `ShutdownResult.errors` for why aborting early
   * would be the wrong trade.
   */
  const runPhase = async (phase: ShutdownPhase, body: () => unknown): Promise<boolean> => {
    phases.push(phase);
    try {
      await body();
      return true;
    } catch (error) {
      errors.push({ phase, message: describe(error) });
      return false;
    }
  };

  // Iterating the exported constant rather than writing seven statements: the
  // order lives in exactly one place, and it is the same place a test reads.
  for (const phase of SHUTDOWN_SEQUENCE) {
    switch (phase) {
      case 'mark-not-ready':
        await runPhase(phase, () => hooks.markNotReady?.());
        break;

      case 'stop-accepting':
        await runPhase(phase, () => hooks.stopAccepting?.());
        break;

      case 'cancel-queued':
        await runPhase(phase, () => hooks.cancelQueued?.());
        break;

      case 'drain-in-flight':
        await runPhase(phase, async () => {
          if (forced) {
            // `forceClose` skips the WAIT, not the cancellation: in-flight
            // calls still have to be told, or they hang until their own
            // deadlines with nothing left to answer them.
            await hooks.cancelInFlight?.();
            return;
          }

          const finished = await raceWithTimeout(hooks.drainInFlight?.(), drainMs);
          if (!finished) {
            drainTimedOut = true;
            await hooks.cancelInFlight?.();
          }
        });
        break;

      case 'flush-audit':
        // The one phase whose success is reported separately. §8.6 gives the
        // audit sink stronger delivery than telemetry, so "did it flush?" is
        // an answer a caller needs, not a detail buried in `errors`.
        auditFlushed = await runPhase(phase, () => hooks.flushAudit?.());
        break;

      case 'flush-telemetry':
        await runPhase(phase, async () => {
          // Best-effort AND bounded. An exporter that cannot reach its
          // collector must not hold the process open past shutdown — the
          // metrics are already lost either way, and hanging turns a lost
          // metric into a stuck container.
          await raceWithTimeout(hooks.flushTelemetry?.(), telemetryFlushMs);
        });
        break;

      case 'close-resources':
        await runPhase(phase, () => hooks.closeResources?.());
        break;
    }
  }

  return { phases, drainTimedOut, forced, auditFlushed, errors };
}

/**
 * Resolve `true` if `work` settled within `ms`, `false` if the timer won.
 *
 * The timer is always cleared — including on the fast path. A stray
 * `setTimeout` from the drain race would keep the event loop alive for the
 * full drain window after shutdown finished, which looks exactly like the
 * hang this function exists to prevent.
 */
async function raceWithTimeout(work: Promise<unknown> | undefined, ms: number): Promise<boolean> {
  if (work === undefined) return true;

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Never leak a stack or a type name into a result an adopter may log. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
