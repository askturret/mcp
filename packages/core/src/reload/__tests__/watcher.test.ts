// SPDX-License-Identifier: Apache-2.0
/**
 * File-watch debounce tests.
 *
 * The watch SOURCE is injected rather than using a real filesystem watch.
 * Real fs.watch emits a platform-dependent number of events per write (and is
 * genuinely flaky on some CI runners), so a real-fs debounce test would be
 * measuring the OS, not this module. The debounce itself - the logic under
 * test - is production code either way.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createReloadWatcher } from '../watcher.js';
import type { WatchFactory } from '../watcher.js';

/**
 * A watch source we can fire by hand.
 */
function controllableWatch(): {
  factory: WatchFactory;
  fire: (times: number) => void;
  closed: () => number;
} {
  const listeners: Array<() => void> = [];
  let closeCount = 0;

  return {
    factory: (_path, onEvent) => {
      listeners.push(onEvent);
      return {
        close: () => {
          closeCount += 1;
        },
      };
    },
    fire: (times: number) => {
      for (let i = 0; i < times; i += 1) {
        for (const listener of listeners) {
          listener();
        }
      }
    },
    closed: () => closeCount,
  };
}

describe('createReloadWatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('collapses 10 events inside the debounce window into exactly one reload', async () => {
    const watch = controllableWatch();
    const reload = jest.fn(async () => undefined);

    const watcher = createReloadWatcher({
      paths: ['spec.yaml'],
      reload,
      watchFactory: watch.factory,
    });
    await watcher.start();

    // 10 writes, each 40ms apart - 360ms total, comfortably inside the 500ms
    // window, and each one resets it.
    for (let i = 0; i < 10; i += 1) {
      watch.fire(1);
      jest.advanceTimersByTime(40);
    }

    expect(reload).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);
    expect(reload).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it('fires on the trailing edge, not the leading one', async () => {
    // Leading-edge would reload from the FIRST write of a multi-write save and
    // read a half-written file.
    const watch = controllableWatch();
    const reload = jest.fn(async () => undefined);

    const watcher = createReloadWatcher({
      paths: ['spec.yaml'],
      reload,
      watchFactory: watch.factory,
    });
    await watcher.start();

    watch.fire(1);
    expect(reload).not.toHaveBeenCalled();

    jest.advanceTimersByTime(499);
    expect(reload).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it('treats separated bursts as separate reloads', async () => {
    const watch = controllableWatch();
    const reload = jest.fn(async () => undefined);

    const watcher = createReloadWatcher({
      paths: ['spec.yaml'],
      reload,
      watchFactory: watch.factory,
    });
    await watcher.start();

    watch.fire(3);
    jest.advanceTimersByTime(600);
    expect(reload).toHaveBeenCalledTimes(1);

    watch.fire(3);
    jest.advanceTimersByTime(600);
    expect(reload).toHaveBeenCalledTimes(2);

    watcher.stop();
  });

  it('honours a custom debounce window', async () => {
    const watch = controllableWatch();
    const reload = jest.fn(async () => undefined);

    const watcher = createReloadWatcher({
      paths: ['spec.yaml'],
      reload,
      debounceMs: 50,
      watchFactory: watch.factory,
    });
    await watcher.start();

    watch.fire(1);
    jest.advanceTimersByTime(50);

    expect(reload).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('cancels a pending reload when stopped', async () => {
    const watch = controllableWatch();
    const reload = jest.fn(async () => undefined);

    const watcher = createReloadWatcher({
      paths: ['spec.yaml'],
      reload,
      watchFactory: watch.factory,
    });
    await watcher.start();

    watch.fire(1);
    watcher.stop();
    jest.advanceTimersByTime(1000);

    expect(reload).not.toHaveBeenCalled();
    expect(watch.closed()).toBe(1);
    expect(watcher.isWatching()).toBe(false);
  });

  it('does not surface a failing reload as an unhandled rejection', async () => {
    // A throw on a timer callback would take the process down - the "reload
    // failures do not take down the server" invariant broken by the TRIGGER
    // rather than by the reload.
    const watch = controllableWatch();
    const warn = jest.fn();
    const reload = jest.fn(async () => {
      throw new Error('candidate rejected');
    });

    const watcher = createReloadWatcher({
      paths: ['spec.yaml'],
      reload,
      watchFactory: watch.factory,
      logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() },
    });
    await watcher.start();

    watch.fire(1);
    jest.advanceTimersByTime(500);

    // Let the rejected promise settle inside fire().
    await Promise.resolve();
    await Promise.resolve();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Watch-triggered reload failed',
      expect.objectContaining({ error: 'candidate rejected' }),
    );

    watcher.stop();
  });

  it('keeps watching the remaining paths when one cannot be watched', async () => {
    const reload = jest.fn(async () => undefined);
    let liveListener: (() => void) | undefined;

    const factory: WatchFactory = (path, onEvent) => {
      if (path === 'missing.yaml') {
        throw new Error('ENOENT');
      }
      liveListener = onEvent;
      return { close: () => undefined };
    };

    const watcher = createReloadWatcher({
      paths: ['missing.yaml', 'spec.yaml'],
      reload,
      watchFactory: factory,
    });
    await watcher.start();

    expect(watcher.isWatching()).toBe(true);
    expect(liveListener).toBeDefined();

    liveListener?.();
    jest.advanceTimersByTime(500);
    expect(reload).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it('is idempotent across repeated start and stop', async () => {
    const watch = controllableWatch();
    const reload = jest.fn(async () => undefined);

    const watcher = createReloadWatcher({
      paths: ['spec.yaml'],
      reload,
      watchFactory: watch.factory,
    });

    await watcher.start();
    await watcher.start();

    watch.fire(1);
    jest.advanceTimersByTime(500);
    expect(reload).toHaveBeenCalledTimes(1);

    watcher.stop();
    watcher.stop();
    expect(watcher.isWatching()).toBe(false);
  });
});
