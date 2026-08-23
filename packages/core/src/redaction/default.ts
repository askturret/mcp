// SPDX-License-Identifier: Apache-2.0
/**
 * The process-wide pipeline every surface falls back to.
 */

import { createRedactionPipeline } from './pipeline.js';
import type { MetricRecorder } from '../telemetry/types.js';
import type { RedactionPipeline, RedactionSurface } from './types.js';

/**
 * Built on FIRST USE, not at module load.
 *
 * Surface 3 lives in `telemetry/metrics`, which means that module and this
 * one are mutually reachable. Constructing a pipeline at module scope makes
 * the program depend on which side of the cycle initialises first — a
 * property that changes with an unrelated import reordering.
 */
let shared: RedactionPipeline | undefined;

/**
 * The default pipeline.
 *
 * ## Why redaction defaults ON, when telemetry defaults OFF
 *
 * Everywhere else in this codebase an absent option means the feature is off,
 * because emitting something an adopter did not ask for is the harm. Redaction
 * inverts that: it only ever REMOVES from what was already being emitted, so
 * defaulting it on cannot surprise anyone with extra output — while defaulting
 * it off would mean §9.4's "every observable exit passes through this pipeline"
 * held only for adopters who already knew to ask, which is precisely the
 * population that does not need it.
 */
export function defaultRedactionPipeline(): RedactionPipeline {
  shared ??= createRedactionPipeline();
  return shared;
}

/**
 * Point the shared pipeline at a configured one — typically to attach metrics.
 *
 * Deliberately explicit rather than a hidden global mutation on construction:
 * a dispatcher silently rebinding a process-wide pipeline would make two
 * dispatchers in one process fight over it.
 */
export function setDefaultRedactionPipeline(pipeline: RedactionPipeline): void {
  shared = pipeline;
}

/** Reset to a fresh built-in pipeline. For tests. */
export function resetDefaultRedactionPipeline(metrics?: MetricRecorder): void {
  shared = createRedactionPipeline(metrics === undefined ? {} : { metrics });
}

/**
 * Redact a value for one surface using the shared pipeline.
 *
 * The one-liner every surface calls, so no surface has to remember to build a
 * context object correctly.
 */
export function redactValue(
  surface: RedactionSurface,
  value: unknown,
  pipeline?: RedactionPipeline,
  operationId?: string,
): unknown {
  return (pipeline ?? defaultRedactionPipeline()).redact(value, {
    surface,
    path: [],
    ...(operationId === undefined ? {} : { operationId }),
  });
}
