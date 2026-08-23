// SPDX-License-Identifier: Apache-2.0
/**
 * Compile-time forbidden-field test (§ Tests, "type test").
 *
 * ## How this test actually fails
 *
 * `@ts-expect-error` inverts the usual assertion: the build FAILS if the line
 * below stops being an error. So the enforcement lives in `tsc` (run by
 * `npm run build` and by the `test-core` CI job), not in the jest assertions -
 * those exist only so the file is also exercised at runtime.
 *
 * Delete `SafeLogFields` from the Logger signatures and this file stops
 * compiling. That is the intended behaviour and the reason the test is written
 * this way rather than as a runtime check: a runtime check could not catch a
 * developer writing `rawInput` in source, which is the whole point.
 */

import { describe, it, expect } from '@jest/globals';
import { createLogger } from '../logger.js';
import type { LogRecord } from '../types.js';

describe('forbidden log fields', () => {
  it('rejects every §9.4 never-include field name at COMPILE time', () => {
    const records: LogRecord[] = [];
    const log = createLogger({ sink: (r) => records.push(r) });

    // @ts-expect-error - `rawInput` is on the never-include list (the exact
    // case named in the issue's type test).
    log.info('nope', { rawInput: { big: 'object' } });

    // @ts-expect-error - raw `input` is on the never-include list.
    log.info('nope', { input: 'anything' });

    // @ts-expect-error - raw `output` is on the never-include list.
    log.info('nope', { output: 'anything' });

    // @ts-expect-error - `rawOutput` is on the never-include list.
    log.info('nope', { rawOutput: 'anything' });

    // @ts-expect-error - the principal identifier is on the never-include list.
    log.info('nope', { principal: 'user-42' });

    // @ts-expect-error - ditto, under its other common spelling.
    log.info('nope', { principalId: 'user-42' });

    // @ts-expect-error - credentials are on the never-include list.
    log.info('nope', { credentials: 'anything' });

    // The calls still RUN - `@ts-expect-error` suppresses the type error, it
    // does not remove the statement - so this also documents that the guard is
    // purely compile-time. A field that slips past it at runtime is the
    // redaction placeholder's job, not this one's.
    expect(records).toHaveLength(7);
  });

  it('rejects forbidden names on every level and on child bindings', () => {
    const records: LogRecord[] = [];
    const log = createLogger({ sink: (r) => records.push(r), level: 'trace' });

    // @ts-expect-error - trace is guarded too.
    log.trace('nope', { input: 'x' });
    // @ts-expect-error - debug is guarded too.
    log.debug('nope', { input: 'x' });
    // @ts-expect-error - warn is guarded too.
    log.warn('nope', { input: 'x' });
    // @ts-expect-error - error is guarded too.
    log.error('nope', { input: 'x' });
    // @ts-expect-error - and bindings, which would otherwise leak the field
    // onto EVERY subsequent record rather than just one.
    const scoped = log.child({ principal: 'user-42' });

    // The compile-time guard is asserted by the directives above; these
    // assertions cover the RUNTIME half, which the directives say nothing
    // about - that every level is really wired to the sink, and that `child`
    // returns a working logger rather than the same instance.
    expect(records.map((r) => r.level)).toEqual(['trace', 'debug', 'warn', 'error']);
    expect(scoped).not.toBe(log);

    scoped.info('from child');
    expect(records[records.length - 1]?.message).toBe('from child');
  });

  it('accepts ordinary field names', () => {
    // The guard must not be so broad that normal logging fights it.
    const records: LogRecord[] = [];
    const log = createLogger({ sink: (r) => records.push(r), level: 'trace' });

    log.info('fine', {
      requestId: 'r-1',
      operationId: 'listPets',
      registryHash: 'abc',
      outcome: 'success',
      traceId: 't-1',
      stage: 4,
      nested: { depth: 2, ok: true },
      list: [1, 2, 3],
      nothing: null,
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.fields['operationId']).toBe('listPets');
  });

  it('accepts a field whose name merely CONTAINS a forbidden word', () => {
    // `inputValidationMs` is not `input`. An over-broad substring rule would
    // block legitimate operational fields and push people to log worse names.
    const records: LogRecord[] = [];
    const log = createLogger({ sink: (r) => records.push(r) });

    log.info('timing', { inputValidationMs: 3, outputSchemaId: 'schema-1' });

    expect(records[0]?.fields).toEqual({ inputValidationMs: 3, outputSchemaId: 'schema-1' });
  });
});
