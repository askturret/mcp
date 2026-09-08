// SPDX-License-Identifier: Apache-2.0
/**
 * Pass 8: Validate invariants
 *
 * Checks required fields, no dangling refs, effect coherence, size caps.
 * Throws on critical failures; non-critical issues become warnings.
 */

import type { CompilerPass, CompiledOperation, CompilerContext, CompilerWarning } from '../types.js';
import type { EffectMetadata } from '../../types.js';
import { omitUndefined } from '../../utils.js';

/**
 * Default safe effects (conservative: assume non-idempotent mutation)
 * Belt-and-suspenders: infer-effects (pass 6) should have completed these,
 * but pass 8 validates and completes any gaps before freezing.
 */
const DEFAULT_EFFECTS: EffectMetadata = {
  readOnly: false,
  idempotent: false,
  retryable: false,
  idempotencyKeyRequired: true,
  classifications: [],
};

/**
 * Runtime check: is effects object complete?
 * Type guard narrows Partial<EffectMetadata> to full EffectMetadata.
 */
function isCompleteEffects(effects: Partial<EffectMetadata>): effects is EffectMetadata {
  return (
    typeof effects.readOnly === 'boolean' &&
    typeof effects.idempotent === 'boolean' &&
    typeof effects.retryable === 'boolean' &&
    typeof effects.idempotencyKeyRequired === 'boolean' &&
    Array.isArray(effects.classifications)
  );
}

/**
 * The input-drop reason a source attached to `hints`, rendered for a reader.
 *
 * VALIDATED RATHER THAN TRUSTED. `hints` is `Record<string, unknown>` and any
 * source can populate it, so every field is checked before it reaches a warning
 * message. A malformed hint yields `undefined` — which falls back to the honest
 * `MISSING_INPUT_SCHEMA` rather than emitting a half-built sentence. Reporting
 * "I was told something but cannot read it" as a specific cause would be the
 * same defect #768 fixes, one layer along.
 *
 * Returns a phrase, not a boolean, because the media type is the actionable
 * part for whoever wrote the spec.
 */
function unencodableFromHints(
  hints: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const raw = hints?.['unencodableParameterMediaTypes'];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const parts: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { parameter, mediaTypes } = entry as { parameter?: unknown; mediaTypes?: unknown };
    if (typeof parameter !== 'string' || !Array.isArray(mediaTypes)) continue;
    const types = mediaTypes.filter((t): t is string => typeof t === 'string');
    if (types.length === 0) continue;
    parts.push(`parameter '${parameter}' declares ${types.map((t) => `'${t}'`).join(', ')}`);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/**
 * FOUR OF THE CODES BELOW ALSO EXIST IN `turret doctor`, MEANING SOMETHING ELSE.
 *
 * Two independent vocabularies share four strings, and in every pair doctor's
 * meaning is the NARROWER one — scoped to an HTTP method, phrased as advice —
 * while the code here is an IR invariant that applies to every operation:
 *
 *   MISSING_OPERATION_ID    here: no `id` on the operation
 *                           doctor: the spec has no `operationId`
 *   MISSING_INPUT_SCHEMA    here: no `input` schema, any operation
 *                           doctor: a MUTATING operation should define a body
 *   MISSING_OUTPUT_SCHEMA   here: no `output` schema, any operation
 *                           doctor: a GET must have a non-empty output schema
 *   MISSING_EFFECTS         here: no `effects` metadata
 *                           doctor: a mutating operation should carry x-mcp-effects
 *
 * The severities disagree too: doctor publishes MISSING_OPERATION_ID and
 * MISSING_OUTPUT_SCHEMA as `error`, while everything this pass emits is a
 * warning.
 *
 * NOTHING MERGES THE TWO TODAY. doctor builds its findings from its own walk of
 * the OpenAPI document; these go to the compiler's WarningCollector and are
 * logged. So there is no defect here to fix, and this is not a prediction that
 * anything will change.
 *
 * THE CONDITION UNDER WHICH IT BITES is a single, checkable one: if compiler
 * warnings are ever fed into doctor's finding list, each of those four strings
 * arrives carrying two meanings and two severities, and doctor's PUBLISHED code
 * table (packages/cli/README.md) becomes wrong for exactly those rows. Whoever
 * merges the vocabularies has to reconcile them first.
 *
 * DO NOT RESOLVE THIS BY RENAMING EITHER SIDE without asking. doctor's codes are
 * documented in a published package's README and appear in its `--json` output,
 * so they are a user-facing contract; renaming one is a breaking change, not a
 * tidy-up. The same note is at doctor's emit site, because the collision bites
 * whoever merges the two and they may arrive from either direction.
 */
export const validateInvariants: CompilerPass = {
  name: 'validate-invariants',

  async run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]> {
    context.logger.debug('Running validate-invariants pass', { count: operations.length });

    const validated: CompiledOperation[] = [];

    for (const op of operations) {
      // Required fields check
      if (!op.id) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_OPERATION_ID',
          message: `Operation missing required 'id' field`,
          location: op.source?.location,
        }));
        continue; // Skip invalid operation
      }

      if (!op.name) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_OPERATION_NAME',
          message: `Operation '${op.id}' missing required 'name' field`,
          location: op.source?.location,
        }));
        continue;
      }

      if (!op.description) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_OPERATION_DESCRIPTION',
          message: `Operation '${op.id}' missing required 'description' field`,
          location: op.source?.location,
        }));
        continue;
      }

      if (!op.input) {
        // THIS PASS SEES ONLY THE ABSENCE, so it used to name the wrong cause
        // (#768). An input dropped because its media type has no encoder is not
        // a missing schema: the schema was present and readable, just declared
        // under something we cannot put on the wire. Reporting that as
        // `MISSING_INPUT_SCHEMA` told a reader their spec lacked a schema it
        // plainly contains.
        //
        // The cause is known only at the DROP SITE, and it is handed here
        // through `hints` — the declared source-to-compiler channel. This pass
        // does not parse media types or know anything about OpenAPI; it reports
        // the reason it was given, and falls back to the honest "missing" only
        // when it was given none.
        const unencodable = unencodableFromHints(op.hints);
        context.warnings.warn(omitUndefined<CompilerWarning>(
          unencodable === undefined
            ? {
                code: 'MISSING_INPUT_SCHEMA',
                message: `Operation '${op.id}' missing required 'input' schema`,
                location: op.source?.location,
              }
            : {
                code: 'UNENCODABLE_INPUT_MEDIA_TYPE',
                message:
                  `Operation '${op.id}' has no usable 'input' schema — ${unencodable}, ` +
                  `which this server cannot encode into a request. The schema IS present in the ` +
                  `spec; re-declare the parameter with 'application/json', or as a plain 'schema', ` +
                  `to make it servable.`,
                location: op.source?.location,
              },
        ));
        continue;
      }

      if (!op.output) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_OUTPUT_SCHEMA',
          message: `Operation '${op.id}' missing required 'output' schema`,
          location: op.source?.location,
        }));
        continue;
      }

      if (!op.effects) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_EFFECTS',
          message: `Operation '${op.id}' missing required 'effects' metadata`,
          location: op.source?.location,
        }));
        continue;
      }

      // Belt-and-suspenders: ensure effects is complete before freezing
      // infer-effects (pass 6) should have completed this, but validate defensively
      let completeEffects: EffectMetadata;
      if (isCompleteEffects(op.effects)) {
        completeEffects = op.effects;
      } else {
        // Fill missing fields with safe defaults
        completeEffects = {
          ...DEFAULT_EFFECTS,
          ...op.effects,
        };
        context.logger.debug(`Completed partial effects for operation '${op.id}'`, {
          provided: Object.keys(op.effects),
          completed: Object.keys(completeEffects),
        });
      }

      if (!op.executor) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'MISSING_EXECUTOR',
          message: `Operation '${op.id}' missing required 'executor' binding`,
          location: op.source?.location,
        }));
        continue;
      }

      // Effect coherence check (use completed effects)
      if (completeEffects.readOnly && completeEffects.idempotencyKeyRequired) {
        context.warnings.warn(omitUndefined<CompilerWarning>({
          code: 'INCOHERENT_EFFECTS',
          message: `Operation '${op.id}' is readOnly but requires idempotency key`,
          location: op.source?.location,
        }));
      }

      // Push operation with completed effects
      validated.push({
        ...op,
        effects: completeEffects,
      });
    }

    context.logger.debug('Validation complete', {
      totalOperations: operations.length,
      validOperations: validated.length,
      invalidOperations: operations.length - validated.length,
    });

    return validated;
  },
};
