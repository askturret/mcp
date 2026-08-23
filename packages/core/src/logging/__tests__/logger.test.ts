// SPDX-License-Identifier: Apache-2.0
/**
 * Structured logger tests - shape, levels, child bindings, redaction wiring,
 * and the golden log fixture.
 */

import { describe, it, expect } from '@jest/globals';
import { createLogger, asLegacyLogger, silentSink, jsonStdoutSink } from '../logger.js';
import { REDACTED } from '../redaction.js';
import type { LogRecord } from '../types.js';

function capture() {
  const records: LogRecord[] = [];
  return {
    records,
    sink: (record: LogRecord) => {
      records.push(record);
    },
    // Fixed clock so golden fixtures are stable rather than stripped.
    now: () => new Date('2026-08-23T01:00:00.000Z'),
  };
}

describe('createLogger', () => {
  it('emits one record per call with level, time and message', () => {
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now, level: 'trace' });

    log.info('served request', { requestId: 'r-1' });

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      level: 'info',
      time: '2026-08-23T01:00:00.000Z',
      message: 'served request',
      fields: { requestId: 'r-1' },
    });
  });

  it('emits every level when the threshold allows', () => {
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now, level: 'trace' });

    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(records.map((r) => r.level)).toEqual(['trace', 'debug', 'info', 'warn', 'error']);
  });

  it('drops records below the configured level', () => {
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now, level: 'warn' });

    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('defaults to a SILENT sink so importing core never writes to stdout', () => {
    // Not cosmetic: a library that logs by default corrupts an adopter's own
    // structured stream the moment they install it. Asserted against the real
    // stdout rather than via `toBeDefined`, because "the logger exists" is not
    // the claim being made here - "nothing was written" is.
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const log = createLogger({ level: 'trace' });
      log.error('should not appear');
      log.info('nor this', { requestId: 'r-1' });
      createLogger({ sink: silentSink }).error('nor this either');
    } finally {
      process.stdout.write = original;
    }

    expect(written).toEqual([]);
  });

  it('writes exactly one JSON line per record when given the stdout sink', () => {
    // The other half of the claim: opting IN produces parseable output, one
    // line per event, not pretty-printed or multi-line.
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      createLogger({ sink: jsonStdoutSink, now: () => new Date('2026-08-23T01:00:00.000Z') }).info(
        'served',
        { requestId: 'r-1' },
      );
    } finally {
      process.stdout.write = original;
    }

    expect(written).toHaveLength(1);
    expect(written[0]?.endsWith('\n')).toBe(true);
    expect(written[0]?.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(written[0] ?? '{}')).toEqual({
      requestId: 'r-1',
      level: 'info',
      time: '2026-08-23T01:00:00.000Z',
      msg: 'served',
    });
  });

  it('redacts through the default placeholder before emit', () => {
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now });

    log.info('auth attempt', { password: 'hunter2', requestId: 'r-1' });

    expect(records[0]?.fields).toEqual({ password: REDACTED, requestId: 'r-1' });
  });

  it('honours a caller-supplied RedactionFn instead of the placeholder', () => {
    // This is the #49 seam: a real pipeline replaces the placeholder wholesale.
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now, redact: () => ({ everything: 'gone' }) });

    log.info('anything', { password: 'hunter2' });

    expect(records[0]?.fields).toEqual({ everything: 'gone' });
  });

  it('does not emit gap warnings when the caller supplied their own redaction', () => {
    // They have taken over the responsibility; warning them about a heuristic
    // they are not running would be noise about someone else's design.
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now, redact: (f) => f });

    log.info('blob', { sessionBlob: 'aZ3kP9xQ7mW2rT8vY5nB1cF6' });

    expect(records).toHaveLength(1);
  });

  it('emits a gap warning AFTER the record it refers to', () => {
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now });

    log.info('blob', { cacheKey: 'aZ3kP9xQ7mW2rT8vY5nB1cF6' });

    expect(records).toHaveLength(2);
    expect(records[0]?.level).toBe('info');
    expect(records[1]?.level).toBe('warn');
    expect(records[1]?.message).toContain('does not cover');
    expect(records[1]?.fields['trackedBy']).toBe(49);
  });

  it('never puts the offending VALUE in the gap warning', () => {
    // A warning about an unredacted secret that quotes the secret is the
    // exact inversion of the point.
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now });

    log.info('blob', { cacheKey: 'aZ3kP9xQ7mW2rT8vY5nB1cF6' });

    expect(JSON.stringify(records[1])).not.toContain('aZ3kP9xQ7mW2rT8vY5nB1cF6');
  });
});

describe('child loggers', () => {
  it('attaches bindings to every subsequent record', () => {
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now }).child({ requestId: 'r-1', traceId: 't-9' });

    log.info('one');
    log.info('two', { stage: 4 });

    expect(records[0]?.fields).toEqual({ requestId: 'r-1', traceId: 't-9' });
    expect(records[1]?.fields).toEqual({ requestId: 'r-1', traceId: 't-9', stage: 4 });
  });

  it('lets a call-site field override an inherited binding', () => {
    // Bindings winning would let a request-scoped logger silently overwrite
    // the value a caller was actively trying to report.
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now }).child({ outcome: 'pending' });

    log.info('done', { outcome: 'success' });

    expect(records[0]?.fields['outcome']).toBe('success');
  });

  it('nests, with the deeper child winning', () => {
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now })
      .child({ layer: 'outer', keep: 'yes' })
      .child({ layer: 'inner' });

    log.info('nested');

    expect(records[0]?.fields).toEqual({ layer: 'inner', keep: 'yes' });
  });

  it('does not mutate the parent', () => {
    const { records, sink, now } = capture();
    const parent = createLogger({ sink, now });
    parent.child({ scoped: 'yes' });

    parent.info('from parent');

    expect(records[0]?.fields).toEqual({});
  });

  it('redacts bindings too, not only call-site fields', () => {
    // A credential bound once at request scope would otherwise be emitted on
    // every subsequent line - strictly worse than a single leak.
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now }).child({ token: 'abc' });

    log.info('anything');

    expect(records[0]?.fields['token']).toBe(REDACTED);
  });
});

describe('golden log shape', () => {
  it('produces a stable serialized line for a canonical request', () => {
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now, level: 'info' }).child({
      traceId: 'trace-abc',
      requestId: 'req-001',
      operationId: 'listPets',
      registryHash: 'a1b2c3d4e5f6',
    });

    log.info('dispatch stage', { stage: 12, stageName: 'map-result', outcome: 'success' });

    const serialized = {
      ...records[0]?.fields,
      level: records[0]?.level,
      time: records[0]?.time,
      msg: records[0]?.message,
    };

    expect(serialized).toEqual({
      traceId: 'trace-abc',
      requestId: 'req-001',
      operationId: 'listPets',
      registryHash: 'a1b2c3d4e5f6',
      stage: 12,
      stageName: 'map-result',
      outcome: 'success',
      level: 'info',
      time: '2026-08-23T01:00:00.000Z',
      msg: 'dispatch stage',
    });
  });

  it('keeps level/time/msg authoritative even when a field shadows them', () => {
    // A field literally named `level` must not be able to displace the real
    // severity, or log routing downstream silently misfiles the record.
    const { records, sink, now } = capture();
    const log = createLogger({ sink, now });

    log.warn('real message', { level: 'trace', msg: 'fake' });

    const serialized = {
      ...records[0]?.fields,
      level: records[0]?.level,
      time: records[0]?.time,
      msg: records[0]?.message,
    };

    expect(serialized['level']).toBe('warn');
    expect(serialized['msg']).toBe('real message');
  });
});

describe('asLegacyLogger', () => {
  it('bridges to the pre-existing discovery/compiler Logger shape', () => {
    const { records, sink, now } = capture();
    const legacy = asLegacyLogger(createLogger({ sink, now, level: 'debug' }));

    legacy.debug('compiling', { pass: 'normalize-schemas' });
    legacy.error('failed', {});

    expect(records.map((r) => r.level)).toEqual(['debug', 'error']);
    expect(records[0]?.fields).toEqual({ pass: 'normalize-schemas' });
  });

  it('still redacts through the structured logger underneath', () => {
    const { records, sink, now } = capture();
    const legacy = asLegacyLogger(createLogger({ sink, now }));

    legacy.info('legacy path', { apiKey: 'k' });

    expect(records[0]?.fields['apiKey']).toBe(REDACTED);
  });
});
