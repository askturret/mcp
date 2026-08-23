// SPDX-License-Identifier: Apache-2.0
/**
 * Audit sinks with mandatory-delivery semantics (§9.3, §8.6, ADR-014).
 */

export { DEFAULT_MAX_BUFFER_SIZE, bufferedSink } from './buffer.js';
export { auditEventId, canonicalize, digestInput, principalRef } from './digest.js';
export { buildAuditEvent } from './event.js';

export { stdoutAuditSink } from './sinks/stdout.js';
export type { AuditWritable, StdoutSinkOptions } from './sinks/stdout.js';

export { DEFAULT_MAX_FILE_BYTES, jsonlAuditSink } from './sinks/jsonl.js';
export type { JsonlSinkOptions } from './sinks/jsonl.js';

export { httpAuditSink } from './sinks/http.js';
export type { HttpAuditSinkOptions } from './sinks/http.js';

export type {
  AuditEvent,
  AuditEventInput,
  AuditSink,
  BufferedSinkOptions,
  OverflowPolicy,
} from './types.js';
