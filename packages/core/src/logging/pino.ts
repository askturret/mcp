// SPDX-License-Identifier: Apache-2.0
/**
 * Reference log adapter for pino (§ Log adapters).
 *
 * ## Why there is no pino dependency
 *
 * The adapter targets a STRUCTURAL type describing the shape of a pino
 * instance, rather than importing pino. Core therefore gains no runtime
 * dependency, no version constraint, and no transitive install cost for
 * adopters who use something else - while an adopter who does use pino passes
 * their instance straight in and it type-checks.
 *
 * That is also the honest demonstration of the issue's own claim that "any
 * structured logger is pluggable via the interface": if wiring the reference
 * adapter required depending on the reference logger, the interface would not
 * really be the seam.
 *
 * The shape below is pino's documented logger surface. Winston, bunyan and
 * roll-your-own emitters satisfy it too - it is not pino-specific in practice,
 * only in name.
 */

import type { LogRecord, LogSink } from './types.js';

/**
 * The subset of a pino logger this adapter uses.
 *
 * Pino's own signature is `(obj, msg)` - object first, message second - which
 * is the opposite order to most loggers and the easiest thing to get wrong
 * when wiring one by hand.
 */
export interface PinoLike {
  trace(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Turn a pino-like instance into a `LogSink`.
 *
 * Records arrive here ALREADY redacted - the sink is downstream of the
 * redaction hook - so this function must not need to know anything about
 * sensitive data. Any adapter that did would be a second place to get
 * redaction wrong.
 *
 * ```ts
 * import pino from 'pino';
 * const logger = createLogger({ sink: pinoSink(pino()) });
 * ```
 */
export function pinoSink(pino: PinoLike): LogSink {
  return (record: LogRecord) => {
    // `time` is passed through as our own field rather than left to pino's
    // clock: the record's timestamp is when the EVENT happened, and pino would
    // otherwise stamp when it reached the sink. Under back-pressure those
    // differ, and the event time is the one worth keeping.
    const payload = { ...record.fields, time: record.time };
    pino[record.level](payload, record.message);
  };
}
