// SPDX-License-Identifier: Apache-2.0
/**
 * Structured logging types (§9.3 logs-versus-audit, §9.4 redaction boundary).
 *
 * Operational logs answer "why is the service unhealthy?". They are NOT audit
 * records - those live in a separate channel with different delivery
 * guarantees (Epic #3, #48). Mixing the two is a security defect, so nothing
 * in this module writes audit events and nothing here should grow a
 * delivery guarantee.
 */

export type JsonPrimitive = string | number | boolean | null;

/**
 * A value that survives `JSON.stringify` without loss or cycles.
 *
 * Deliberately excludes `undefined`: a field whose value is `undefined`
 * vanishes during serialization, so a log line would silently lose a key the
 * caller believed they had emitted.
 */
export type JsonSerializable =
  | JsonPrimitive
  | readonly JsonSerializable[]
  | { readonly [key: string]: JsonSerializable };

export type LogFields = Readonly<Record<string, JsonSerializable>>;

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * Numeric severities, for level-threshold comparisons.
 *
 * Ordered, not arbitrary: a sink configured at `info` emits `info` and above.
 */
export const LOG_LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

/**
 * Field names that must NEVER reach a log line, enforced at COMPILE time.
 *
 * This is the §9.4 "never include" list: raw input, raw output, principal
 * identifier, credentials. It is deliberately distinct from the RUNTIME
 * redaction key list (see `DEFAULT_REDACTED_KEYS`), because the two solve
 * different problems:
 *
 * - This list catches names a developer writes literally in source. A compile
 *   error is the right tool: the mistake is visible before it ever runs.
 * - The runtime list catches credential-shaped keys arriving from data whose
 *   shape is not known until execution. A compile error is impossible there.
 *
 * Neither subsumes the other, which is why both exist.
 */
export type ForbiddenFieldKey =
  | 'input'
  | 'rawInput'
  | 'output'
  | 'rawOutput'
  | 'principal'
  | 'principalId'
  | 'credential'
  | 'credentials';

/**
 * Maps any forbidden key in `T` to `never`, so passing a real value for it is
 * a compile error while every other key passes through untouched.
 *
 * ## Why the Logger methods are generic (#38 spec note)
 *
 * The issue specifies `info(msg: string, fields?: LogFields): void` AND a type
 * test where `logger.info('foo', { rawInput: bigObj })` is a compile error.
 * Those two cannot both hold: `LogFields` is `Record<string, JsonSerializable>`,
 * an index signature that accepts every string key, so nothing about a
 * particular key is expressible in that signature.
 *
 * Making the methods generic over `T extends LogFields` is what makes the
 * required compile error possible. Ordinary calls are unaffected - `T` is
 * inferred - so the ergonomics the issue asked for are preserved even though
 * the literal signature is not.
 */
export type SafeLogFields<T> = {
  [K in keyof T]: K extends ForbiddenFieldKey ? never : T[K];
};

/**
 * Transforms fields immediately before emit.
 *
 * This is the SEAM the central redaction pipeline (Epic #3, #49) will fill.
 * v0.2 ships `defaultRedaction` as a placeholder; it is not, and does not
 * claim to be, a redaction implementation.
 *
 * Returning fields unchanged is a valid (if unsafe) implementation, which is
 * why the Production preset still lists `redaction` as a pending control.
 */
export type RedactionFn = (fields: LogFields) => LogFields;

/**
 * One emitted log event, after redaction.
 */
export interface LogRecord {
  readonly level: LogLevel;
  readonly time: string;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * Where records go. Injectable so tests and adapters do not fight over stdout.
 *
 * The default writes one JSON line to stdout. There is deliberately NO
 * `console.log` fallback on a production path: a sink that silently degrades
 * to console is how unstructured lines end up in a structured pipeline.
 */
export type LogSink = (record: LogRecord) => void;

/**
 * Structured logger (§9.3).
 *
 * Superset of the legacy discovery-time `Logger` in `sources/types.ts`: adds
 * `trace` and `child`. The two are NOT unified here - see `asLegacyLogger` -
 * because collapsing them would touch the compiler and every source adapter,
 * which is a larger change than this issue asked for.
 */
export interface StructuredLogger {
  trace<T extends LogFields>(message: string, fields?: T & SafeLogFields<T>): void;
  debug<T extends LogFields>(message: string, fields?: T & SafeLogFields<T>): void;
  info<T extends LogFields>(message: string, fields?: T & SafeLogFields<T>): void;
  warn<T extends LogFields>(message: string, fields?: T & SafeLogFields<T>): void;
  error<T extends LogFields>(message: string, fields?: T & SafeLogFields<T>): void;

  /**
   * A logger with `bindings` pre-attached to every subsequent record.
   *
   * Child bindings are merged UNDER call-site fields, so a per-call value wins
   * over an inherited one. The alternative - bindings winning - would let a
   * request-scoped logger silently overwrite the very field a caller was
   * trying to report.
   */
  child<T extends LogFields>(bindings: T & SafeLogFields<T>): StructuredLogger;
}

/**
 * The canonical field set (§ Output format).
 *
 * "Always include when available" - so these are optional, and absent rather
 * than null when unknown. A null `traceId` is a claim that there is no trace;
 * an absent one is an admission we do not know, and those are different.
 */
export interface CanonicalLogFields {
  readonly traceId?: string;
  readonly requestId?: string;
  readonly operationId?: string;
  readonly registryHash?: string;
  readonly outcome?: string;
}

export interface LoggerOptions {
  /** Minimum severity to emit. Defaults to `info`. */
  readonly level?: LogLevel;

  /** Defaults to one JSON line per record on stdout. */
  readonly sink?: LogSink;

  /** Defaults to `defaultRedaction`. */
  readonly redact?: RedactionFn;

  /** Fields bound to every record from this logger. */
  readonly bindings?: LogFields;

  /**
   * Clock, injectable so golden-log fixtures are stable.
   *
   * A golden test that could not pin the timestamp would either be flaky or
   * would have to strip the field - and stripping it means the fixture stops
   * testing that the field is present at all.
   */
  readonly now?: () => Date;
}
