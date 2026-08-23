// SPDX-License-Identifier: Apache-2.0
/**
 * A bounded in-process span buffer for the Explorer's trace panel (§13, #56).
 *
 * ## This did not exist, and #56 assumed it did
 *
 * #56 names the trace panel's data source as "an in-process ring buffer
 * populated by the OTel exporter (Epic #2 #39)". No such buffer existed. #39
 * shipped `openTelemetry()`, which FORWARDS spans to an adopter's OTel SDK — it
 * retains nothing, by design, because a forwarder that also buffered would be
 * holding request data nobody asked it to hold.
 *
 * So the panel had no source. Built here rather than assumed, and flagged in
 * the PR rather than quietly filled in.
 *
 * ## It is opt-in, and that is not a formality
 *
 * Retaining recent request metadata in process memory is a decision an operator
 * should make deliberately, not inherit from installing a package. `openTelemetry()`
 * is unchanged and still retains nothing; a caller who wants the panel wraps it
 * with `recordingObservability()` explicitly.
 *
 * ## Everything stored is redacted FIRST
 *
 * §56's acceptance says no panel may bypass the redaction pipeline, and #56's
 * own text says redaction "already ensures no sensitive data reaches this
 * panel". That was true of the span EXPORT path and says nothing about a buffer
 * that did not exist — so this applies `redactSpanAttributes` on the way IN,
 * not on the way out to the page.
 *
 * On the way in is the stronger placement: a buffer holding raw attributes is a
 * heap-dump risk and a second thing to remember to redact at every future read
 * site. Redacted once at the boundary, the buffer cannot leak what it never
 * held.
 */

import { redactSpanAttributes, type SpanAttributes, type SpanName, type Tracer } from '@askturret/mcp-core';

/** Default number of spans retained. Small: this is a debugging tail. */
export const DEFAULT_SPAN_BUFFER_SIZE = 50;

export interface RecordedSpan {
  readonly name: string;
  /** Attributes, ALREADY redacted. */
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly outcome?: string;
  readonly startedAt: number;
  readonly durationMs?: number;
}

export interface SpanBuffer {
  /** Most recent first. */
  recent(limit?: number): readonly RecordedSpan[];
  readonly size: number;
  clear(): void;
}

interface MutableSpanBuffer extends SpanBuffer {
  push(span: RecordedSpan): void;
}

export function createSpanBuffer(capacity = DEFAULT_SPAN_BUFFER_SIZE): SpanBuffer & {
  push(span: RecordedSpan): void;
} {
  const spans: RecordedSpan[] = [];

  const buffer: MutableSpanBuffer = {
    push(span) {
      spans.push(span);
      // Bounded, because an unbounded debugging tail is a memory leak that
      // only shows up on the servers that stay up longest.
      if (spans.length > capacity) spans.splice(0, spans.length - capacity);
    },
    recent(limit) {
      const newestFirst = [...spans].reverse();
      return limit === undefined ? newestFirst : newestFirst.slice(0, limit);
    },
    get size() {
      return spans.length;
    },
    clear() {
      spans.length = 0;
    },
  };

  return buffer;
}

/**
 * Wrap a tracer so every span it starts is also recorded, redacted, in a
 * bounded buffer.
 *
 * The wrapped tracer still forwards to the delegate unchanged — the panel is
 * additive, and an adopter's real exporter must not lose a span because the
 * Explorer was switched on.
 */
export function recordingTracer(delegate: Tracer, buffer: ReturnType<typeof createSpanBuffer>, now: () => number = Date.now): Tracer {
  return {
    startSpan(name: SpanName, options?: { attributes?: SpanAttributes }) {
      const span = delegate.startSpan(name, options);
      const startedAt = now();

      // Redacted HERE, on the way in — see the header. The buffer never holds
      // an unredacted attribute, so no future read site can leak one.
      const attributes = redactSpanAttributes({ ...(options?.attributes ?? {}) }) as Readonly<
        Record<string, unknown>
      >;

      let outcome: string | undefined;
      const recorded = { name: String(name), attributes, startedAt };

      return {
        ...span,
        setAttribute(key: string, value: unknown) {
          return (span as { setAttribute?: (k: string, v: unknown) => unknown }).setAttribute?.(
            key,
            value,
          );
        },
        setOutcome(result: string, code?: string) {
          outcome = code === undefined ? result : `${result}:${code}`;
          return (span as { setOutcome?: (r: string, c?: string) => unknown }).setOutcome?.(
            result,
            code,
          );
        },
        end() {
          buffer.push({
            ...recorded,
            ...(outcome === undefined ? {} : { outcome }),
            durationMs: now() - startedAt,
          });
          return (span as { end?: () => unknown }).end?.();
        },
      } as ReturnType<Tracer['startSpan']>;
    },
  };
}
