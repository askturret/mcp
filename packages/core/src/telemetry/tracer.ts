// SPDX-License-Identifier: Apache-2.0
/**
 * Tracer implementations: no-op (the default) and recording (for tests and
 * for the OTel adapter to build on).
 */

import { sanitizeAttributes } from './attributes.js';
import {
  SPAN_ATTR,
  type Span,
  type SpanAttributeValue,
  type SpanAttributes,
  type SpanName,
  type SpanOptions,
  type SpanOutcome,
  type Tracer,
} from './types.js';

/**
 * A finished span, as captured by the recording tracer.
 */
export interface RecordedSpan {
  readonly name: SpanName;
  readonly attributes: SpanAttributes;
  readonly parent: RecordedSpan | null;
  readonly children: readonly RecordedSpan[];
  readonly ended: boolean;
}

/**
 * The default tracer: does nothing, allocates nothing meaningful.
 *
 * Telemetry is opt-in (§ Delivery: "Default: no exporter configured"). The
 * dispatcher therefore always has a tracer to call and never needs a
 * null-check on a request path.
 */
export const noopTracer: Tracer = {
  startSpan(name: SpanName): Span {
    return noopSpan(name);
  },
};

function noopSpan(name: SpanName): Span {
  const span: Span = {
    name,
    setAttribute: () => undefined,
    setAttributes: () => undefined,
    setOutcome: () => undefined,
    startChild: (childName: SpanName) => noopSpan(childName),
    end: () => undefined,
  };
  return span;
}

/**
 * A tracer that retains the span tree in memory.
 *
 * Backs the golden-trace test, and is the reference implementation the OTel
 * adapter mirrors. Not intended for production use — it retains every span.
 */
export interface RecordingTracer extends Tracer {
  /** Root spans, in start order. */
  roots(): readonly RecordedSpan[];

  /** Every span, flattened, in start order. */
  all(): readonly RecordedSpan[];

  reset(): void;
}

export function createRecordingTracer(): RecordingTracer {
  const roots: MutableSpan[] = [];
  const all: MutableSpan[] = [];

  const make = (name: SpanName, parent: MutableSpan | null, options?: SpanOptions): MutableSpan => {
    const span = new MutableSpan(name, parent, make);
    if (options?.attributes) {
      span.setAttributes(options.attributes);
    }
    all.push(span);
    if (parent === null) {
      roots.push(span);
    } else {
      parent.addChild(span);
    }
    return span;
  };

  return {
    startSpan: (name, options) => make(name, null, options),
    roots: () => roots.map((s) => s.snapshot()),
    all: () => all.map((s) => s.snapshot()),
    reset: () => {
      roots.length = 0;
      all.length = 0;
    },
  };
}

type SpanFactory = (
  name: SpanName,
  parent: MutableSpan | null,
  options?: SpanOptions,
) => MutableSpan;

class MutableSpan implements Span {
  private readonly attributes: Record<string, SpanAttributeValue> = {};
  private readonly childSpans: MutableSpan[] = [];
  private isEnded = false;

  constructor(
    readonly name: SpanName,
    private readonly parentSpan: MutableSpan | null,
    private readonly factory: SpanFactory,
  ) {}

  setAttribute(key: string, value: SpanAttributeValue): void {
    // Sanitised one key at a time so a single-key set cannot bypass the rule
    // that a bulk set enforces.
    const cleaned = sanitizeAttributes({ [key]: value });
    for (const [k, v] of Object.entries(cleaned)) {
      this.attributes[k] = v;
    }
  }

  setAttributes(attributes: SpanAttributes): void {
    for (const [key, value] of Object.entries(sanitizeAttributes(attributes))) {
      this.attributes[key] = value;
    }
  }

  setOutcome(outcome: SpanOutcome, errorCode?: string): void {
    this.attributes[SPAN_ATTR.outcome] = outcome;
    if (errorCode !== undefined) {
      this.attributes[SPAN_ATTR.errorCode] = errorCode;
    }
  }

  startChild(name: SpanName, options?: SpanOptions): Span {
    return this.factory(name, this, options);
  }

  addChild(child: MutableSpan): void {
    this.childSpans.push(child);
  }

  end(): void {
    // Idempotent: double-ending is a bookkeeping bug, not a reason to throw
    // inside a request path.
    this.isEnded = true;
  }

  snapshot(): RecordedSpan {
    return {
      name: this.name,
      attributes: { ...this.attributes },
      parent: this.parentSpan === null ? null : this.parentSpan.shallow(),
      children: this.childSpans.map((c) => c.shallow()),
      ended: this.isEnded,
    };
  }

  /** Parent/child links without recursing, so snapshots cannot cycle. */
  private shallow(): RecordedSpan {
    return {
      name: this.name,
      attributes: { ...this.attributes },
      parent: null,
      children: [],
      ended: this.isEnded,
    };
  }
}
