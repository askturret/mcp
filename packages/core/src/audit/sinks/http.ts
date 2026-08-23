// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP audit sink — POST with retry and backoff.
 */

import { computeBackoffMs } from '../../retry/policy.js';
import { defaultSleep } from '../../retry/sleep.js';
import type { AuditEvent, AuditSink } from '../types.js';

export interface HttpAuditSinkOptions {
  /** Fixed at config time. Never influenced by event content. */
  readonly url: string;

  readonly id?: string;

  /** Extra headers, e.g. an auth token. Never logged. */
  readonly headers?: Readonly<Record<string, string>>;

  /** Attempts per event, including the first. Default 3. */
  readonly maxAttempts?: number;

  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;

  /** Injected for tests. Defaults to global `fetch`. */
  readonly post?: (url: string, body: string, headers: Record<string, string>) => Promise<number>;

  /** Injected for tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;

  /** Injected for tests; jitter source. */
  readonly random?: () => number;
}

/**
 * POST each event, retrying transient failures with bounded backoff.
 *
 * Retry policy is #45's `computeBackoffMs` rather than a second
 * implementation: full jitter matters more here than on the request path,
 * because every instance's audit sink targets the SAME collector and a fixed
 * exponential would have them all retry in lockstep after a collector blip.
 *
 * ## Durability caveat, stated rather than implied
 *
 * There is no disk-backed write-ahead log. §48 makes a persistent buffer an
 * opt-in extra for this sink and says the absence must be documented: without
 * it, an UNCLEAN shutdown (SIGKILL, power loss) loses whatever was still in
 * memory. The graceful path is covered — §8.6 phase 5 flushes — but "graceful
 * only" is a real limit and adopters who cannot accept it should pair this
 * with the JSONL sink. Flagged for QA; the WAL is not built here.
 */
export function httpAuditSink(options: HttpAuditSinkOptions): AuditSink {
  const id = options.id ?? 'http';
  const maxAttempts = options.maxAttempts ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const resolved = {
    maxAttempts,
    baseDelayMs: options.baseDelayMs ?? 200,
    maxDelayMs: options.maxDelayMs ?? 5_000,
  };

  const post =
    options.post ??
    (async (url, body, headers) => {
      const response = await fetch(url, { method: 'POST', body, headers });
      return response.status;
    });

  /** In-flight sends, so `flush` can wait for retries already in progress. */
  const pending = new Set<Promise<void>>();

  /**
   * Backoff here is never cancelled by a request's signal.
   *
   * An audit send outlives the call that produced it — that is the point of
   * buffering — so cancelling its retry when the client disconnects would
   * discard the record of a call that really happened.
   */
  const neverAborts = new AbortController().signal;

  const send = async (event: AuditEvent): Promise<void> => {
    const body = JSON.stringify(event);
    const headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };

    let lastStatus = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const status = await post(options.url, body, headers);
        if (status >= 200 && status < 300) return;
        lastStatus = status;

        // A 4xx will fail identically on every retry — the collector has
        // rejected the record, not failed to receive it. Retrying wastes the
        // budget and delays shutdown for a request that cannot succeed.
        if (status >= 400 && status < 500) break;
      } catch {
        lastStatus = 0; // Transport failure; retryable.
      }

      if (attempt < maxAttempts) {
        await sleep(computeBackoffMs(attempt, resolved, random), neverAborts);
      }
    }

    // Rejects so the buffered sink counts it under `outcome: 'error'`. The
    // status is included; the BODY never is, because a collector's error
    // response can echo the record it rejected.
    throw new Error(`audit sink '${id}' failed after ${maxAttempts} attempts (status ${lastStatus})`);
  };

  return {
    id,

    append(event: AuditEvent): Promise<void> {
      const task = send(event);
      pending.add(task);
      // Detached settle-handler keeps the set clean without making the
      // returned promise's rejection anyone else's problem.
      void task.catch(() => undefined).finally(() => pending.delete(task));
      return task;
    },

    async flush(): Promise<void> {
      // Wait for retries ALREADY in progress — §48: "retries never gate
      // dispatcher progress on the primary path, but shutdown DOES flush
      // them". `allSettled`, because a send that ultimately fails must not
      // make flush reject and abort the rest of the shutdown sequence.
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
  };
}
