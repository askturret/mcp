// SPDX-License-Identifier: Apache-2.0
/**
 * Signal handling (§8.6 Signals).
 *
 * Driven against an injected target rather than the real `process`: a test
 * that registered handlers on the actual process would leak them into every
 * later test file in the same worker, and one that raised a real SIGTERM
 * would kill the runner.
 */

import { describe, it, expect } from '@jest/globals';

import { installSignalHandlers } from '../signals.js';

/** Stands in for `process`, and lets a test fire signals synchronously. */
function fakeProcess() {
  const handlers = new Map<string, Set<() => void>>();

  return {
    target: {
      on(signal: string, handler: () => void) {
        const set = handlers.get(signal) ?? new Set();
        set.add(handler);
        handlers.set(signal, set);
        return this;
      },
      off(signal: string, handler: () => void) {
        handlers.get(signal)?.delete(handler);
        return this;
      },
    } as unknown as Pick<NodeJS.Process, 'on' | 'off'>,

    raise(signal: string) {
      for (const handler of handlers.get(signal) ?? []) handler();
    },

    count(signal: string): number {
      return handlers.get(signal)?.size ?? 0;
    },
  };
}

function harness(escalateWindowMs = 5_000) {
  const proc = fakeProcess();
  const calls: string[] = [];

  const uninstall = installSignalHandlers({
    close: async () => {
      calls.push('close');
    },
    forceClose: async () => {
      calls.push('forceClose');
    },
    escalateWindowMs,
    target: proc.target,
  });

  return { proc, calls, uninstall };
}

describe('installation', () => {
  it('registers for SIGTERM and SIGINT by default', () => {
    const { proc, uninstall } = harness();

    expect(proc.count('SIGTERM')).toBe(1);
    expect(proc.count('SIGINT')).toBe(1);

    uninstall();
  });

  it('removes its handlers on uninstall', () => {
    // A library that could not be cleanly uninstalled would leak a handler
    // into any host that created and discarded a server — in tests, once per
    // case.
    const { proc, uninstall } = harness();

    uninstall();

    expect(proc.count('SIGTERM')).toBe(0);
    expect(proc.count('SIGINT')).toBe(0);
  });

  it('is opt-in — nothing is registered until it is called', () => {
    // The design decision worth pinning: importing the runtime must NOT take
    // over the host application's shutdown. This asserts the module has no
    // import-time side effect on the target.
    const proc = fakeProcess();

    expect(proc.count('SIGTERM')).toBe(0);
  });
});

describe('escalation (§8.6)', () => {
  it('starts a graceful close on the first signal', () => {
    const { proc, calls, uninstall } = harness();

    proc.raise('SIGTERM');

    expect(calls).toEqual(['close']);
    uninstall();
  });

  it('escalates to forceClose on a second signal inside the window', () => {
    const { proc, calls, uninstall } = harness();

    proc.raise('SIGTERM');
    proc.raise('SIGTERM');

    expect(calls).toEqual(['close', 'forceClose']);
    uninstall();
  });

  it('escalates across DIFFERENT signals', () => {
    // An operator who sends SIGTERM then hits Ctrl-C means "hurry up", and
    // matching only repeats of the same signal would ignore that.
    const { proc, calls, uninstall } = harness();

    proc.raise('SIGTERM');
    proc.raise('SIGINT');

    expect(calls).toEqual(['close', 'forceClose']);
    uninstall();
  });

  it('escalates at most once', () => {
    // Re-entering would race the escalation already running; there is no
    // state past "closing immediately".
    const { proc, calls, uninstall } = harness();

    proc.raise('SIGTERM');
    proc.raise('SIGTERM');
    proc.raise('SIGTERM');
    proc.raise('SIGTERM');

    expect(calls).toEqual(['close', 'forceClose']);
    uninstall();
  });

  it('does NOT escalate on a second signal after the window', async () => {
    // A late second signal is most likely an operator wondering why the drain
    // is slow. The graceful close has its own deadline and is still
    // progressing, so tearing it down would discard a working drain.
    const { proc, calls, uninstall } = harness(10);

    proc.raise('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 30));
    proc.raise('SIGTERM');

    expect(calls).toEqual(['close']);
    uninstall();
  });
});
