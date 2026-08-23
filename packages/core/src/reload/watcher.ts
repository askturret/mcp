// SPDX-License-Identifier: Apache-2.0
/**
 * File-watch reload trigger with debounce (§ Reload triggers).
 *
 * Editors and build tools rarely emit one filesystem event per logical change
 * - a single save can produce several (write, rename, attribute change). The
 * debounce is what turns "10 writes in 500ms" into one reload.
 */

import type { Logger } from '../sources/types.js';
import { DEFAULT_DEBOUNCE_MS } from './types.js';

const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Handle to one underlying filesystem watch.
 */
export interface WatchHandle {
  close(): void;
}

/**
 * Opens a filesystem watch on `path`, invoking `onEvent` for every raw event.
 *
 * Injectable so the debounce logic can be tested without touching the real
 * filesystem. Filesystem watch semantics differ across platforms (and are
 * genuinely flaky on some CI runners), which would make a debounce test
 * measure the OS rather than this module.
 */
export type WatchFactory = (path: string, onEvent: () => void) => WatchHandle;

export interface ReloadWatcherOptions {
  /** Paths to watch - an OpenAPI spec, overlay files, and so on. */
  readonly paths: readonly string[];

  /** Invoked once per debounced burst. Usually `controller.reload()`. */
  readonly reload: () => Promise<unknown>;

  /** Debounce window. Defaults to `DEFAULT_DEBOUNCE_MS` (500ms). */
  readonly debounceMs?: number;

  readonly logger?: Logger;

  /** Defaults to a `node:fs` watch. Override in tests. */
  readonly watchFactory?: WatchFactory;
}

export interface ReloadWatcher {
  /** Begin watching. Idempotent. */
  start(): Promise<void>;

  /** Stop watching and cancel any pending debounce. Idempotent. */
  stop(): void;

  /** True while watches are open. */
  isWatching(): boolean;
}

export function createReloadWatcher(
  options: ReloadWatcherOptions,
): ReloadWatcher {
  return new DebouncedReloadWatcher(options);
}

class DebouncedReloadWatcher implements ReloadWatcher {
  private readonly paths: readonly string[];
  private readonly reload: () => Promise<unknown>;
  private readonly debounceMs: number;
  private readonly logger: Logger;
  private readonly watchFactory: WatchFactory | undefined;

  private handles: WatchHandle[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watching = false;

  constructor(options: ReloadWatcherOptions) {
    this.paths = options.paths;
    this.reload = options.reload;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.watchFactory = options.watchFactory;
  }

  isWatching(): boolean {
    return this.watching;
  }

  async start(): Promise<void> {
    if (this.watching) {
      return;
    }

    const factory = this.watchFactory ?? (await defaultWatchFactory());

    for (const path of this.paths) {
      try {
        this.handles.push(factory(path, () => this.onEvent(path)));
      } catch (error) {
        // One unwatchable path must not prevent the others from being watched.
        // A missing overlay file is a normal state, not a fatal one.
        this.logger.warn('Could not watch path for reload', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.watching = true;
    this.logger.info('Reload watcher started', {
      paths: this.paths,
      watched: this.handles.length,
      debounceMs: this.debounceMs,
    });
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    for (const handle of this.handles) {
      try {
        handle.close();
      } catch {
        // Closing an already-closed watch is not an error worth surfacing.
      }
    }

    this.handles = [];
    this.watching = false;
  }

  /**
   * Trailing-edge debounce: every event RESETS the window, so a burst fires
   * exactly once, `debounceMs` after the last event in the burst.
   *
   * Leading-edge would be wrong here - it would reload from the first write of
   * a multi-write save and read a half-written file.
   */
  private onEvent(path: string): void {
    this.logger.debug('Reload watcher observed change', { path });

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.fire();
    }, this.debounceMs);

    // Do not hold the process open purely for a pending debounce.
    this.timer.unref?.();
  }

  private async fire(): Promise<void> {
    try {
      await this.reload();
    } catch (error) {
      // The controller already records and logs rejected reloads. A watcher
      // that rethrows here would surface as an unhandled rejection on a timer
      // callback and take the process down - precisely the "reload failures do
      // not take down the server" invariant, violated by the trigger rather
      // than by the reload.
      this.logger.warn('Watch-triggered reload failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Lazily import `node:fs` so this module stays importable in environments
 * without filesystem access. Only reached when no `watchFactory` is supplied.
 */
async function defaultWatchFactory(): Promise<WatchFactory> {
  const fs = await import('node:fs');
  return (path, onEvent) => {
    const watcher = fs.watch(path, { persistent: false }, () => onEvent());
    return { close: () => watcher.close() };
  };
}
