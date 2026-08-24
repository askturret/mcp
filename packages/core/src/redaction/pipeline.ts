// SPDX-License-Identifier: Apache-2.0
/**
 * The single point every observable value passes through (§9.4).
 */

import { METRIC, type MetricRecorder } from '../telemetry/types.js';
import { BUILTIN_RULES } from './rules.js';
import type {
  RedactionContext,
  RedactionPipeline,
  RedactionRule,
  RedactionSurface,
} from './types.js';

export interface RedactionPipelineOptions {
  /** Replaces the built-ins entirely. Omit to keep them. */
  readonly rules?: readonly RedactionRule[];

  /** Where `mcp_redaction_hits_total` goes. */
  readonly metrics?: MetricRecorder;

  /**
   * Depth cap for the walk. Default 12.
   *
   * A cycle-free but pathologically deep structure would otherwise be walked
   * to exhaustion on a request path. Beyond the cap the value is replaced
   * wholesale rather than passed through — failing CLOSED, because the one
   * thing worse than losing a deep field is emitting an unredacted one.
   */
  readonly maxDepth?: number;
}

export const DEFAULT_MAX_DEPTH = 12;

/** Marker for a subtree that exceeded the depth cap. */
export const TRUNCATED = '[REDACTED:depth]';

/**
 * A local no-op recorder, NOT `telemetry/metrics.js`'s export.
 *
 * Importing that one creates a cycle: `telemetry/metrics` wires surface 3 of
 * §9.4, so it imports the redaction surfaces, which import this module. Under
 * ESM that cycle resolves to `Cannot access 'noopMetricRecorder' before
 * initialization` — which it did, and took out eight test suites at load time
 * rather than failing an assertion.
 *
 * Three no-op functions are not worth a dependency edge that makes the module
 * graph acyclic-or-not depending on import order.
 */
const noMetrics: MetricRecorder = {
  add: () => undefined,
  record: () => undefined,
  set: () => undefined,
};

export function createRedactionPipeline(
  options: RedactionPipelineOptions = {},
): RedactionPipeline {
  const rules: RedactionRule[] = [...(options.rules ?? BUILTIN_RULES)];
  const metrics = options.metrics ?? noMetrics;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const firstMatch = (context: RedactionContext, value: unknown): RedactionRule | undefined => {
    for (const rule of rules) {
      // A rule that throws must not take down the surface it was protecting —
      // but it must also not be treated as "no match", which would emit the
      // value it might have redacted. Failing CLOSED here is the only safe
      // reading, so a throwing rule is treated as a match.
      try {
        if (rule.matches(context, value)) return rule;
      } catch {
        return rule;
      }
    }
    return undefined;
  };

  const walk = (
    value: unknown,
    context: RedactionContext,
    depth: number,
    seen: WeakSet<object>,
  ): unknown => {
    const matched = firstMatch(context, value);
    if (matched !== undefined) {
      metrics.add(METRIC.redactionHitsTotal, 1, {
        rule: matched.id,
        surface: context.surface,
      });
      try {
        return matched.transform(value);
      } catch {
        // Same reasoning as above: a transform that throws must not leak the
        // original.
        return '[REDACTED]';
      }
    }

    if (value === null || typeof value !== 'object') return value;

    if (depth >= maxDepth) return TRUNCATED;

    // Cycles are possible in anything an adopter hands us — a log field object
    // holding a back-reference is ordinary. Without this the walk recurses
    // until the stack dies, taking the request with it.
    if (seen.has(value as object)) return '[REDACTED:cycle]';
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item, index) =>
        walk(item, { ...context, path: [...context.path, String(index)] }, depth + 1, seen),
      );
    }

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walk(nested, { ...context, path: [...context.path, key] }, depth + 1, seen);
    }
    return out;
  };

  return {
    redact(value: unknown, context: RedactionContext): unknown {
      return walk(value, context, 0, new WeakSet<object>());
    },

    add(rule: RedactionRule): void {
      // Appended, so built-ins keep priority under first-match-wins FOR ANY
      // NODE A BUILT-IN ALSO MATCHES. That is a tie-break, not containment.
      //
      // A rule matching a container claims it and `walk` returns without
      // descending, so the built-ins never reach the leaves inside it — and
      // since no built-in matches a container, there is no tie for the built-in
      // to win. An adopter rule may do this deliberately (own trust boundary);
      // plugin rules are wrapped by constrainPluginRedactionRule instead.
      rules.push(rule);
    },

    rules(): readonly RedactionRule[] {
      return [...rules];
    },
  };
}

/**
 * A pipeline that does nothing, for callers that have not configured one.
 *
 * Deliberately NOT the default anywhere a secret could flow: the surfaces
 * wire the real pipeline. This exists so a test or an embedding that wants
 * raw values can say so explicitly rather than by omission.
 */
export const noopRedactionPipeline: RedactionPipeline = {
  redact: (value) => value,
  add: () => undefined,
  rules: () => [],
};

/** Convenience for surfaces that always redact at one surface id. */
export function redactFor(
  pipeline: RedactionPipeline,
  surface: RedactionSurface,
  value: unknown,
  operationId?: string,
): unknown {
  return pipeline.redact(value, {
    surface,
    path: [],
    ...(operationId === undefined ? {} : { operationId }),
  });
}
