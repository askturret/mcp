// SPDX-License-Identifier: Apache-2.0
/**
 * Structured JSON logger (§9.3).
 *
 * One line per event, fields redacted immediately before emit, child loggers
 * for request-scoped bindings.
 */

import type { Logger as LegacyLogger } from '../sources/types.js';
import {
  FORBIDDEN_FIELD_KEYS,
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
import { redactLogFields } from '../redaction/surfaces.js';

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
      // #38's pass still runs, so its gap warnings keep firing: the signal
      // that motivated #49 stays observable even now that #49 acts on it.
      emitted = result.fields;
      gaps = result.gaps;
    }

    // Surface 1 of §9.4, applied to BOTH branches.
    //
    // A caller-supplied `redact` cannot opt out of the central pipeline. The
    // point of §9.4 is that there is exactly one place data leaves the
    // process, and a hook able to bypass it would make that claim false for
    // precisely the deployments that customised logging. Running last means a
    // custom function may redact MORE, never less.
    emitted = redactLogFields(emitted);

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
 * Split `meta` into what may be logged and the forbidden key names found.
 *
 * Own-enumerable keys only, and no recursion into nested objects. That bound is
 * deliberate: `FORBIDDEN_FIELD_KEYS` is the §9.4 list of names a developer
 * writes at the TOP level of a log call, and the runtime redaction pipeline —
 * not this adapter — is what walks values of unknown shape. Recursing here
 * would duplicate that layer badly while still not being it.
 */
function withoutForbiddenFields(meta?: Record<string, unknown>): {
  readonly safe: LogFields;
  readonly dropped: readonly string[];
} {
  if (meta === undefined) return { safe: {} as LogFields, dropped: [] };

  const safe: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(meta)) {
    if ((FORBIDDEN_FIELD_KEYS as readonly string[]).includes(key)) {
      dropped.push(key);
      continue;
    }
    safe[key] = value;
  }

  return { safe: safe as LogFields, dropped };
}

/**
 * Field name carrying the forbidden keys this adapter refused to forward.
 *
 * The NAMES are safe to emit — they are eight fixed strings from a list in this
 * repository, not data. The values are what §9.4 forbids, and those never
 * leave the adapter.
 */
export const DROPPED_FIELDS_KEY = 'forbiddenFieldsDropped';

/**
 * View a `StructuredLogger` as the legacy discovery/compiler `Logger`.
 *
 * The codebase already had a `Logger` (debug/info/warn/error, `meta?:
 * Record<string, unknown>`) used by the compiler, the source adapters and the
 * reload controller. #38 specifies a richer one, and unifying them would mean
 * changing every one of those call sites - more than that issue asked for.
 * Both therefore exist; see `docs/adr/ADR-021-two-logger-types.md` for why, and
 * for the condition under which the legacy one retires (Epic #3 / #49).
 *
 * ## The §9.4 guard, and why this adapter has to re-implement it (#133)
 *
 * `StructuredLogger`'s methods are generic over `T & SafeLogFields<T>` for one
 * reason: to make `logger.info('x', { rawInput: big })` a COMPILE error. This
 * adapter used to hand `meta` across as `(meta ?? {}) as LogFields`, and that
 * cast erased the guard — a legacy-side caller passing `{ rawInput: … }`
 * compiled cleanly and emitted. The runtime layer did not catch it either:
 * `DEFAULT_REDACTED_KEYS` is a credential-shaped list that deliberately shares
 * no member with `FORBIDDEN_FIELD_KEYS`, so through this adapter BOTH layers
 * missed.
 *
 * The compile-time guard cannot be restored here, and it is worth being precise
 * about why rather than appearing to have chosen the weaker fix. The callers
 * that matter — `fromOpenApi`'s discovery, the compiler passes — hold a
 * `LegacyLogger`, whose `meta` is `Record<string, unknown>` by definition. They
 * never see this adapter's types. Narrowing the parameter here would change
 * nothing at any real call site while making the returned object no longer a
 * `LegacyLogger`.
 *
 * So the guard is enforced where it CAN be: at runtime, at the boundary. A
 * forbidden key's value is dropped rather than forwarded, and the key's name is
 * reported under `DROPPED_FIELDS_KEY` so the bypass is loud in the record
 * itself. Silence was the actual defect; a value that vanishes without trace
 * would only be a quieter version of it.
 *
 * Non-forbidden `meta` is still cast, because the legacy type permits `unknown`
 * values that `JsonSerializable` does not. The JSON sink is what would fail on
 * a non-serializable value, and it fails loudly.
 */
export function asLegacyLogger(logger: StructuredLogger): LegacyLogger {
  const call = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): void => {
    const { safe, dropped } = withoutForbiddenFields(meta);
    logger[level](message, dropped.length === 0 ? safe : { ...safe, [DROPPED_FIELDS_KEY]: dropped });
  };

  return {
    debug: (message, meta) => call('debug', message, meta),
    info: (message, meta) => call('info', message, meta),
    warn: (message, meta) => call('warn', message, meta),
    error: (message, meta) => call('error', message, meta),
  };
}
