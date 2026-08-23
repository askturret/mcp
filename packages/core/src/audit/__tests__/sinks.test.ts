// SPDX-License-Identifier: Apache-2.0
/**
 * The three shipped sinks (§48).
 */

import { describe, it, expect } from '@jest/globals';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { httpAuditSink, jsonlAuditSink, stdoutAuditSink } from '../index.js';
import type { AuditEvent } from '../types.js';
import type { AuditWritable } from '../sinks/stdout.js';

function event(id: string): AuditEvent {
  return {
    eventId: id,
    timestamp: new Date(0).toISOString(),
    requestId: id,
    operationId: 'op',
    registryHash: 'h',
    policyDecision: 'allow',
    outcome: 'success',
    durationMs: 1,
  };
}

describe('stdout sink', () => {
  function capture(): { stream: AuditWritable; lines: () => string[] } {
    const chunks: string[] = [];
    return {
      stream: {
        write(chunk: string, callback?: (error?: Error | null) => void) {
          chunks.push(chunk);
          callback?.(null);
          return true;
        },
        once() {
          return undefined;
        },
      },
      lines: () => chunks.join('').split('\n').filter(Boolean),
    };
  }

  it('writes one JSON object per line', async () => {
    const { stream, lines } = capture();
    const sink = stdoutAuditSink({ stream });

    await sink.append(event('a'));
    await sink.append(event('b'));

    expect(lines()).toHaveLength(2);
    expect(JSON.parse(lines()[0] as string).eventId).toBe('a');
  });

  it('resolves only after the stream accepts the write', async () => {
    // A sink that resolved before the write was accepted would let the
    // buffered sink free a slot for a record still in flight.
    let deferred: ((error?: Error | null) => void) | undefined;
    const sink = stdoutAuditSink({
      stream: {
        write(_chunk: string, callback?: (error?: Error | null) => void) {
          deferred = callback;
          return true;
        },
        once: () => undefined,
      },
    });

    let done = false;
    const pending = sink.append(event('a')).then(() => {
      done = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);

    deferred?.(null);
    await pending;
    expect(done).toBe(true);
  });

  it('rejects when the stream reports an error', async () => {
    const sink = stdoutAuditSink({
      stream: {
        write(_chunk: string, callback?: (error?: Error | null) => void) {
          callback?.(new Error('EPIPE'));
          return true;
        },
        once: () => undefined,
      },
    });

    await expect(sink.append(event('a'))).rejects.toThrow('EPIPE');
  });
});

describe('JSON-lines file sink', () => {
  async function tempPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'));
    return join(dir, 'nested', 'audit.jsonl');
  }

  it('appends newline-delimited JSON and creates missing directories', async () => {
    const path = await tempPath();
    const sink = jsonlAuditSink({ path });

    await sink.append(event('a'));
    await sink.append(event('b'));
    await sink.flush();

    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string).eventId).toBe('b');
  });

  it('keeps every record when appends are issued concurrently', async () => {
    // O_APPEND picks the offset per write, so records cannot interleave — but
    // the property worth pinning is that none go missing and every line still
    // parses.
    const path = await tempPath();
    const sink = jsonlAuditSink({ path });

    await Promise.all(Array.from({ length: 50 }, (_, i) => sink.append(event(`e${i}`))));
    await sink.flush();

    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(50);
    expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
  });

  it('rotates once the file exceeds maxBytes', async () => {
    const path = await tempPath();
    const sink = jsonlAuditSink({ path, maxBytes: 200 });

    for (let i = 0; i < 20; i += 1) await sink.append(event(`e${i}`));
    await sink.flush();

    const files = await readdir(join(path, '..'));
    expect(files).toContain('audit.jsonl');
    expect(files).toContain('audit.jsonl.1');
  });

  it('does not rotate a file still under the limit', async () => {
    const path = await tempPath();
    const sink = jsonlAuditSink({ path, maxBytes: 1_000_000 });

    await sink.append(event('a'));
    await sink.flush();

    expect(await readdir(join(path, '..'))).toEqual(['audit.jsonl']);
  });

  it('loses no records across a rotation', async () => {
    // The property that actually matters. Rotation is housekeeping, and
    // housekeeping that discards audit records is worse than an over-size
    // file: every event appended must still be readable somewhere afterwards.
    // Sized to stay INSIDE the retention ring. Beyond `maxFiles` generations
    // the oldest file is discarded — that is what bounded log rotation is,
    // not a defect — so a no-loss claim is only meaningful within the ring.
    // An earlier version of this test ran 30 events through a 5-file ring and
    // failed for exactly that reason.
    const path = await tempPath();
    const sink = jsonlAuditSink({ path, maxBytes: 300, maxFiles: 5 });

    const total = 6;
    for (let i = 0; i < total; i += 1) await sink.append(event(`e${i}`));
    await sink.flush();

    const dir = join(path, '..');
    const files = await readdir(dir);
    expect(files.length).toBeGreaterThan(1); // rotation definitely happened

    const ids: string[] = [];
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      for (const line of text.split('\n').filter(Boolean)) {
        ids.push(JSON.parse(line).eventId);
      }
    }

    expect(ids.sort()).toEqual(
      Array.from({ length: total }, (_, i) => `e${i}`).sort(),
    );
  });
});

describe('HTTP sink', () => {
  it('POSTs the event and resolves on 2xx', async () => {
    const seen: string[] = [];
    const sink = httpAuditSink({
      url: 'https://collector.example.com/audit',
      post: async (_url, body) => {
        seen.push(body);
        return 202;
      },
    });

    await sink.append(event('a'));

    expect(JSON.parse(seen[0] as string).eventId).toBe('a');
  });

  it('retries a transient failure and succeeds', async () => {
    let attempts = 0;
    const sink = httpAuditSink({
      url: 'https://collector.example.com/audit',
      post: async () => {
        attempts += 1;
        return attempts < 3 ? 503 : 200;
      },
      sleep: async () => undefined,
      random: () => 0,
    });

    await sink.append(event('a'));

    expect(attempts).toBe(3);
  });

  it('does NOT retry a 4xx', async () => {
    // The collector rejected the record; it did not fail to receive it.
    // Retrying wastes the budget and delays shutdown for a request that
    // cannot succeed.
    let attempts = 0;
    const sink = httpAuditSink({
      url: 'https://collector.example.com/audit',
      post: async () => {
        attempts += 1;
        return 400;
      },
      sleep: async () => undefined,
      random: () => 0,
    });

    await expect(sink.append(event('a'))).rejects.toThrow(/status 400/);
    expect(attempts).toBe(1);
  });

  it('gives up after maxAttempts on a persistent 5xx', async () => {
    let attempts = 0;
    const sink = httpAuditSink({
      url: 'https://collector.example.com/audit',
      maxAttempts: 4,
      post: async () => {
        attempts += 1;
        return 500;
      },
      sleep: async () => undefined,
      random: () => 0,
    });

    await expect(sink.append(event('a'))).rejects.toThrow();
    expect(attempts).toBe(4);
  });

  it('retries a transport failure', async () => {
    let attempts = 0;
    const sink = httpAuditSink({
      url: 'https://collector.example.com/audit',
      post: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('ECONNRESET');
        return 200;
      },
      sleep: async () => undefined,
      random: () => 0,
    });

    await sink.append(event('a'));

    expect(attempts).toBe(2);
  });

  it('flush waits for retries already in progress (§8.6 phase 5)', async () => {
    // §48: retries never gate dispatch, but shutdown DOES flush them.
    let releaseSleep!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    let attempts = 0;

    const sink = httpAuditSink({
      url: 'https://collector.example.com/audit',
      post: async () => {
        attempts += 1;
        return attempts < 2 ? 503 : 200;
      },
      sleep: () => sleeping,
      random: () => 0,
    });

    void sink.append(event('a')).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));

    let flushed = false;
    const flushing = sink.flush().then(() => {
      flushed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushed).toBe(false);

    releaseSleep();
    await flushing;
    expect(attempts).toBe(2);
  });

  it('flush does not reject when a send ultimately failed', async () => {
    // A rejecting flush would abort the rest of the §8.6 sequence, so a
    // failing collector would also cost us the resource-close phase.
    const sink = httpAuditSink({
      url: 'https://collector.example.com/audit',
      maxAttempts: 1,
      post: async () => 500,
      sleep: async () => undefined,
    });

    void sink.append(event('a')).catch(() => undefined);

    await expect(sink.flush()).resolves.toBeUndefined();
  });

  it('never puts the event body in the error message', async () => {
    const sink = httpAuditSink({
      url: 'https://collector.example.com/audit',
      maxAttempts: 1,
      post: async () => 500,
      sleep: async () => undefined,
    });

    await expect(sink.append(event('secret-request-id'))).rejects.toThrow(
      /^(?!.*secret-request-id).*$/,
    );
  });
});
