// SPDX-License-Identifier: Apache-2.0
/**
 * SIGTERM / SIGINT handling (§8.6 Signals).
 */

/** §8.6: "A second signal within 5s escalates to immediate close". */
export const DEFAULT_ESCALATE_WINDOW_MS = 5_000;

export interface SignalHandlerOptions {
  /** Graceful path. */
  readonly close: () => Promise<unknown>;

  /** Escalation path, on a second signal inside the window. */
  readonly forceClose: () => Promise<unknown>;

  /** Default `['SIGTERM', 'SIGINT']`. */
  readonly signals?: readonly NodeJS.Signals[];

  readonly escalateWindowMs?: number;

  /** Injected for tests; defaults to the real `process`. */
  readonly target?: Pick<NodeJS.Process, 'on' | 'off'>;
}

/**
 * Install shutdown signal handlers, returning an uninstall function.
 *
 * ## This is OPT-IN, and that is a deliberate design decision
 *
 * §8.6 says "SIGTERM triggers shutdown", which reads like something the
 * runtime should just do. It is not, for a library: `process.on('SIGTERM')`
 * is global, and installing it on import would silently take over the
 * shutdown behaviour of whatever application embedded us. A host app with its
 * own orderly shutdown would find ours running alongside it, in an order
 * neither side chose.
 *
 * So the runtime never installs these by itself. An adopter running our
 * server AS the process calls this once; an adopter embedding us in a larger
 * application wires their existing handler to `close()` instead. Flagged for
 * QA rather than resolved silently, because it is a departure from the
 * literal wording.
 *
 * Handlers are registered with `once`-like semantics of our own: the first
 * signal starts the graceful close, and a second within the window escalates.
 * A third does nothing further — there is no state past "closing immediately",
 * and re-entering would race the escalation already in progress.
 */
export function installSignalHandlers(options: SignalHandlerOptions): () => void {
  const target = options.target ?? process;
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as const);
  const windowMs = options.escalateWindowMs ?? DEFAULT_ESCALATE_WINDOW_MS;

  let firstSignalAt: number | undefined;
  let escalated = false;

  const onSignal = (): void => {
    const now = Date.now();

    if (firstSignalAt === undefined) {
      firstSignalAt = now;
      void options.close();
      return;
    }

    if (escalated) return;

    if (now - firstSignalAt <= windowMs) {
      escalated = true;
      void options.forceClose();
      return;
    }

    // A second signal AFTER the window is not an escalation request — it is
    // most likely an operator wondering why the drain is taking so long. The
    // graceful close is still running and still has its own deadline, so
    // tearing it down here would discard a drain that was progressing fine.
    firstSignalAt = now;
  };

  for (const signal of signals) target.on(signal, onSignal);

  return () => {
    for (const signal of signals) target.off(signal, onSignal);
  };
}
