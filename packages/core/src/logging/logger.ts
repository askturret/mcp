// SPDX-License-Identifier: Apache-2.0
/**
 * Structured JSON logger (§9.3).
 *
 * One line per event, fields redacted immediately before emit, child loggers
 * for request-scoped bindings.
 */

import type { Logger as LegacyLogger } from '../sources/types.js';
import {
  LOG_LEVEL_SEVERITY,
  type JsonSerializable,
  type LogFields,
  type LogLevel,
  type LogRecord,
  type LoggerOptions,
  type LogSink,
  type SafeLogFields,
  type StructuredLogger,
} from './types.js';
import { redactWithGaps, type RedactionGap } from './redaction.js';

/**
 * Default sink: one JSON line on stdout.
 *
 * Uses `process.stdout.write` rather than `console.log` deliberately - §
 * Log adapters forbids a `console.log` fallback on production paths, and
 * `console` is a formatting layer that can interpolate, colourise, and
 * inspect objects. A structured pipeline needs bytes it can parse.
 */
export const jsonStdoutSink: LogSink = (record) => {
  process.stdout.write(`${JSON.stringify(serialize(record))}\n`);
};

/**
 * A sink that discards everything.
 *
 * The default for library-internal loggers, so importing core never writes to
 * an adopter's stdout uninvited.
 */
export const silentSink: LogSink = () => undefined;

/**
 * Flatten a record to the emitted wire shape.
 *
 * Reserved keys (`level`, `time`, `msg`) are written LAST so a field named
 * `level` cannot displace the real severity. Shadowing here would corrupt log
 * routing for anything downstream that filters on level.
 */
function serialize(record: LogRecord): Record<string, JsonSerializable> {
  return {
    ...record.fields,
    level: record.level,
    time: record.time,
    msg: record.message,
  };
}

export function createLogger(options?: LoggerOptions): StructuredLogger {
  return new JsonLogger(options ?? {});
}

class JsonLogger implements StructuredLogger {
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly bindings: LogFields;
  private readonly now: () => Date;
  private readonly redact: LoggerOptions['redact'];

  constructor(private readonly options: LoggerOptions) {
    this.level = options.level ?? 'info';
    this.sink = options.sink ?? silentSink;
    this.bindings = options.bindings ?? {};
    this.now = options.now ?? (() => new Date());
    this.redact = options.redact;
  }

  trace<T extends LogFields>(message: string, fields?: T & SafeLogFields<T>): void {
    this.emit('trace', message, fields);
  }

  debug<T extends LogFields>(message: string, fields?: T & SafeLogFields<T>): void {
    this.emit('debug', message, fields);
  }

  info<T extends LogFields>(message: string, fields?: T & SafeLogFields<T>): void {
    this.emit('info', message, fields);
  }

  warn<T extends LogFields>(message: string, fields?: T & SafeLogFields<T>): void {
    this.emit('warn', message, fields);
  }

  error<T extends LogFields>(message: string, fields?: T & SafeLogFields<T>): void {
    this.emit('error', message, fields);
  }

  child<T extends LogFields>(bindings: T & SafeLogFields<T>): StructuredLogger {
    return new JsonLogger({
      ...this.options,
      // Call-site fields win over bindings at emit time; between PARENT and
      // CHILD bindings the child is more specific, so it wins here.
      bindings: { ...this.bindings, ...(bindings as LogFields) },
    });
  }

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LOG_LEVEL_SEVERITY[level] < LOG_LEVEL_SEVERITY[this.level]) {
      return;
    }

    // Bindings first: a per-call field overrides an inherited one, never the
    // reverse. A request-scoped logger must not be able to silently overwrite
    // the value a caller is actively trying to report.
    const merged: LogFields = { ...this.bindings, ...(fields ?? {}) };

    let emitted: LogFields;
    let gaps: readonly RedactionGap[] = [];

    if (this.redact) {
      emitted = this.redact(merged);
    } else {
      const result = redactWithGaps(merged);
      emitted = result.fields;
      gaps = result.gaps;
    }

    this.sink({
      level,
      time: this.now().toISOString(),
      message,
      fields: emitted,
    });

    // Emitted AFTER the record it refers to, so the two read in causal order,
    // and only for the built-in placeholder - a caller supplying their own
    // RedactionFn has taken over the responsibility and should not receive
    // warnings about a heuristic they are not using.
    if (gaps.length > 0) {
      this.emitGapWarning(gaps);
    }
  }

  /**
   * Warn that the v0.2 placeholder saw something it does not know how to
   * redact (§ "emit warnings when the placeholder would need to strip more").
   *
   * Only paths and reasons are reported - NEVER the offending value. A warning
   * about an unredacted secret must not itself leak the secret, which is the
   * obvious way to get this exactly backwards.
   */
  private emitGapWarning(gaps: readonly RedactionGap[]): void {
    if (LOG_LEVEL_SEVERITY.warn < LOG_LEVEL_SEVERITY[this.level]) {
      return;
    }

    this.sink({
      level: 'warn',
      time: this.now().toISOString(),
      message: 'Redaction placeholder encountered values it does not cover',
      fields: {
        redactionGaps: gaps.map((gap) => ({ path: gap.path, reason: gap.reason })),
        trackedBy: 49,
      },
    });
  }
}

/**
 * View a `StructuredLogger` as the legacy discovery/compiler `Logger`.
 *
 * The codebase already had a `Logger` (debug/info/warn/error, `meta?:
 * Record<string, unknown>`) used by the compiler, the source adapters and the
 * reload controller. #38 specifies a richer one, and unifying them would mean
 * changing every one of those call sites - more than this issue asked for, and
 * a change that deserves its own review.
 *
 * So both exist, with this one-way adapter between them, and the duplication
 * is flagged rather than hidden. `meta` is cast at the boundary because the
 * legacy type permits `unknown` values that `JsonSerializable` does not; the
 * JSON sink is the thing that would actually fail on a non-serializable value,
 * and it fails loudly rather than silently.
 */
export function asLegacyLogger(logger: StructuredLogger): LegacyLogger {
  const call = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): void => {
    logger[level](message, (meta ?? {}) as LogFields);
  };

  return {
    debug: (message, meta) => call('debug', message, meta),
    info: (message, meta) => call('info', message, meta),
    warn: (message, meta) => call('warn', message, meta),
    error: (message, meta) => call('error', message, meta),
  };
}
