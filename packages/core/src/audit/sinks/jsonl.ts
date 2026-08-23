// SPDX-License-Identifier: Apache-2.0
/**
 * Append-only JSON-lines file sink, rotating by size.
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AuditEvent, AuditSink } from '../types.js';

export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface JsonlSinkOptions {
  /** Destination path. Parent directories are created if missing. */
  readonly path: string;

  readonly id?: string;

  /** Rotate once the file exceeds this. Default 64 MiB. */
  readonly maxBytes?: number;

  /** Rotated files kept, newest first: `.1`, `.2`, … Default 5. */
  readonly maxFiles?: number;
}

/**
 * Newline-delimited JSON appended to a file.
 *
 * Writes go through `appendFile` with the O_APPEND flag, so concurrent
 * writers cannot interleave a partial line: the append offset is chosen by
 * the kernel per write, not by this process. That matters because a torn line
 * is an audit record that no longer parses, and a log where one bad line can
 * break a reader is not much better than a missing one.
 *
 * Each event is written as a SINGLE `appendFile` call including its trailing
 * newline, so the atomicity above covers the whole record.
 */
export function jsonlAuditSink(options: JsonlSinkOptions): AuditSink {
  const { path } = options;
  const id = options.id ?? 'jsonl';
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = options.maxFiles ?? 5;

  let ensuredDir = false;

  /**
   * Serialises writes within this process.
   *
   * Not for the append itself — O_APPEND already handles that — but for
   * ROTATION: two concurrent appends that both observed an over-size file
   * would rotate twice, and the second rename would move a fresh file
   * containing records that had just been written to it.
   */
  let tail: Promise<void> = Promise.resolve();

  const rotateIfNeeded = async (): Promise<void> => {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return; // No file yet: nothing to rotate.
    }

    if (size < maxBytes) return;

    // Shift the ring downward from the oldest, so nothing is overwritten
    // before it has been moved.
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      try {
        await rename(`${path}.${index}`, `${path}.${index + 1}`);
      } catch {
        // Absent generation — expected until the ring fills.
      }
    }

    try {
      await rename(path, `${path}.1`);
    } catch {
      // Rotation is best-effort: if the rename fails the sink keeps appending
      // to an over-size file, which is strictly better than dropping records
      // because housekeeping did not work.
    }
  };

  const write = async (event: AuditEvent): Promise<void> => {
    if (!ensuredDir) {
      await mkdir(dirname(path), { recursive: true });
      ensuredDir = true;
    }

    await rotateIfNeeded();
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
  };

  return {
    id,

    append(event: AuditEvent): Promise<void> {
      const next = tail.then(() => write(event));
      // Swallow on the CHAIN only, so one failed write does not poison every
      // subsequent append. The returned promise still rejects, so the caller
      // (and the buffered sink's error counter) still sees the failure.
      tail = next.catch(() => undefined);
      return next;
    },

    async flush(): Promise<void> {
      // `appendFile` resolves after the data reaches the OS. Waiting on the
      // write chain is therefore what "durable" means at this layer; an
      // fsync-per-record would be the stronger guarantee and is deliberately
      // not taken, since it would make the audit path slower than the
      // operation being audited. Flagged for QA.
      await tail;
    },
  };
}
