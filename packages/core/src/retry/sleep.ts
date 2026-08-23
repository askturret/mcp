// SPDX-License-Identifier: Apache-2.0
/**
 * Abortable backoff sleep.
 */

/**
 * Wait `ms`, or return early if `signal` aborts.
 *
 * Resolves rather than rejects on abort: the caller re-checks the signal
 * straight afterwards and has its own answer for a cancelled request, so a
 * rejection here would only be caught and discarded one frame later.
 *
 * Both the timer and the listener are torn down on every exit path. A backoff
 * that leaves a live `setTimeout` behind keeps the event loop open, which
 * turns a clean process exit into a hang — and the symptom shows up in a test
 * runner long before anyone connects it to a retry.
 */
export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };

    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
