// SPDX-License-Identifier: Apache-2.0
/**
 * stdout audit sink — for containers whose sidecar consumes stdout.
 */

import type { AuditEvent, AuditSink } from '../types.js';

/** The slice of a writable stream this sink needs. Injected for tests. */
export interface AuditWritable {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  once(event: 'drain', listener: () => void): unknown;
}

export interface StdoutSinkOptions {
  readonly id?: string;
  readonly stream?: AuditWritable;
}

/**
 * Newline-delimited JSON on stdout.
 *
 * `append` resolves only once the write has been ACCEPTED by the stream, and
 * honours back-pressure: when `write` returns false the kernel buffer is
 * full, and continuing to write would grow an unbounded queue inside the
 * stream — moving the overflow somewhere the buffered sink's bound cannot see
 * it.
 */
export function stdoutAuditSink(options: StdoutSinkOptions = {}): AuditSink {
  const stream: AuditWritable = options.stream ?? (process.stdout as unknown as AuditWritable);
  const id = options.id ?? 'stdout';

  return {
    id,

    append(event: AuditEvent): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const ok = stream.write(`${JSON.stringify(event)}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });

        // `write` returning false is back-pressure, not failure — the
        // callback still fires. Waiting for 'drain' is what keeps this sink
        // from outrunning a slow consumer.
        if (!ok) stream.once('drain', () => undefined);
      });
    },

    async flush(): Promise<void> {
      // Every `append` already resolved on its own write callback, so by the
      // time flush is reachable there is nothing outstanding to wait for.
      // Deliberately NOT a no-op-by-oversight: stated so a reader does not
      // "fix" it into something that waits on a stream that has already
      // accepted everything.
    },
  };
}
