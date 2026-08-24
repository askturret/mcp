// SPDX-License-Identifier: Apache-2.0
/**
 * Structured logging with a redaction seam (#38, §9.3 / §9.4).
 */

export {
  createLogger,
  jsonStdoutSink,
  silentSink,
  asLegacyLogger,
  DROPPED_FIELDS_KEY,
} from './logger.js';

export {
  defaultRedaction,
  redactWithGaps,
  shannonEntropy,
  DEFAULT_REDACTED_KEYS,
  REDACTED,
  type RedactionGap,
  type RedactionResult,
} from './redaction.js';

export { pinoSink, type PinoLike } from './pino.js';

export {
  FORBIDDEN_FIELD_KEYS,
  LOG_LEVEL_SEVERITY,
  type CanonicalLogFields,
  type ForbiddenFieldKey,
  type JsonPrimitive,
  type JsonSerializable,
  type LogFields,
  type LogLevel,
  type LogRecord,
  type LoggerOptions,
  type LogSink,
  type RedactionFn,
  type SafeLogFields,
  type StructuredLogger,
} from './types.js';
