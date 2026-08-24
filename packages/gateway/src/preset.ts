// SPDX-License-Identifier: Apache-2.0
/**
 * Preset selection for the gateway (#57, §10.2).
 *
 * ## The whole point of this file is that it decides nothing
 *
 * §57 requires the gateway to use "the same preset system as the library", and
 * the only way to make that true rather than approximately true is to CALL the
 * library's expanders and let their refusals propagate. Every rule — a durable
 * audit sink, the redaction-review signature, the evidence verifier — lives in
 * `@askturret/mcp-core`'s `regulatedPreset`, and this module's job is to hand
 * it the operator's configuration and get out of the way.
 *
 * A gateway that re-checked "is this sink stdout?" itself would be a second
 * implementation of §10.2, free to drift from the library's the moment either
 * changed. It would also pass a test asserting the refusal while proving
 * nothing about the library, which is the failure mode worth naming: the test
 * would be measuring the copy.
 *
 * So there is no refusal logic below. There is a mapping from gateway config to
 * `RegulatedPresetOptions`, and a call.
 */

import { productionPreset, regulatedPreset } from '@askturret/mcp-core';
import type {
  AuditSinkDurabilityClaim,
  PresetConfiguration,
  RegulatedPresetOptions,
} from '@askturret/mcp-core';

import type { GatewayConfig } from './config.js';

/**
 * How each sink the gateway offers declares its durability.
 *
 * This is a DECLARATION table, matching what §10.2's check actually is — the
 * preset cannot inspect a sink, it reads the claim. `jsonl` claims `durable`
 * because it writes to a file that survives the process; whether that file is
 * on durable storage is the operator's deployment decision, and the preset
 * documents that it cannot verify it either way.
 *
 * `none` claims `memory` rather than being special-cased: under Regulated,
 * running with no audit sink at all must refuse for the same reason stdout
 * does, and giving it its own branch would be a second rule to keep in step.
 */
const SINK_DURABILITY: Readonly<Record<GatewayConfig['audit']['sink'], AuditSinkDurabilityClaim>> = {
  stdout: 'stdout',
  jsonl: 'durable',
  none: 'memory',
};

/** What a resolved preset gives the server. `undefined` for Light. */
export interface ResolvedPreset {
  readonly name: GatewayConfig['preset'];
  /** Absent for Light, which is the facade's own defaults rather than an expansion. */
  readonly configuration?: PresetConfiguration;
}

/**
 * Load the operator's `verifyEvidence` implementation.
 *
 * ## Why this is a module path and not a config value
 *
 * `RegulatedPresetOptions.verifyEvidence` is a FUNCTION. No YAML file can hold
 * one, and that is not an oversight in the config format — the signature scheme
 * is adopter-specific by design, and core refuses at boot rather than shipping a
 * default, because one that accepted every proof would make the evidence policy
 * decorative and one that rejected every proof would fail each guarded call at
 * runtime instead of at startup.
 *
 * A standalone gateway can still supply it, because it can `import()`. That is
 * the ONE capability the embedded library has that a config file lacks, and
 * bridging it with a module path is the smallest bridge that does not weaken
 * the rule.
 *
 * **The gateway supplies no fallback.** If the module is absent, nothing is
 * passed, and `regulatedPreset` refuses — which is the correct outcome and,
 * importantly, the LIBRARY's outcome rather than one this file invented.
 */
async function loadVerifyEvidence(
  specifier: string,
): Promise<RegulatedPresetOptions['verifyEvidence']> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Could not load --verify-evidence module '${specifier}': ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Named export first, then default — an operator writing a one-function
  // module reaches for either and both are unambiguous here.
  const candidate = loaded['verifyEvidence'] ?? loaded['default'];
  if (typeof candidate !== 'function') {
    throw new Error(
      `Module '${specifier}' does not export a 'verifyEvidence' function (a default export is ` +
        `also accepted). The Regulated preset needs one; see §10.2.`,
    );
  }

  return candidate as RegulatedPresetOptions['verifyEvidence'];
}

/**
 * Expand the configured preset.
 *
 * Throws whatever the library throws. In particular a `RegulatedPresetRefusal`
 * propagates untouched — it is not wrapped, re-messaged or re-classified,
 * because its `control` field is the stable thing an operator's tooling reads
 * and its message already explains the fix better than a gateway-flavoured
 * paraphrase would.
 */
export async function resolvePreset(config: GatewayConfig): Promise<ResolvedPreset> {
  if (config.preset === 'light') {
    // Light is the absence of an expansion, not an expansion with permissive
    // values — the same thing `expressMcp()` gives you with no preset named.
    return { name: 'light' };
  }

  if (config.preset === 'production') {
    return {
      name: 'production',
      configuration: productionPreset({ permissions: config.permissions }),
    };
  }

  const verifyEvidence =
    config.verifyEvidenceModule === undefined
      ? undefined
      : await loadVerifyEvidence(config.verifyEvidenceModule);

  return {
    name: 'regulated',
    configuration: regulatedPreset({
      permissions: config.permissions,
      auditSink: {
        id: config.audit.sink,
        durability: SINK_DURABILITY[config.audit.sink],
      },
      customReviewAcknowledged: config.customReviewAcknowledged,
      // Passed through AS-IS, including `undefined`, and the cast is what makes
      // that possible: `verifyEvidence` is a required field, so omitting the key
      // would not compile. Supplying `undefined` is the point — core's own
      // `typeof !== 'function'` check is then what refuses, with the message
      // that explains why there can be no default. A pre-check here would
      // produce a gateway-flavoured error for a library rule (see the file
      // header), and a stub verifier would be far worse: it would make the
      // evidence policy decorative while appearing to satisfy it.
      verifyEvidence: verifyEvidence as RegulatedPresetOptions['verifyEvidence'],
    }),
  };
}
