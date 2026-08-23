// SPDX-License-Identifier: Apache-2.0
/**
 * Preset configuration types.
 *
 * ADR-007: a preset is a configuration COMPOSITION, not a mode. It expands to
 * ordinary configuration that an operator can read, copy, and edit one field
 * of — there is no code path that behaves differently because a preset is
 * "on". That property is only real if the expansion is inspectable, which is
 * what `describePreset` is for.
 *
 * Everything here is plain data with one exception, `authorization.policy`,
 * which is a composed `Policy` object because a policy is behaviour and cannot
 * be reduced to JSON. `PresetDescription` carries a `policySummary` alongside
 * it so the inspectable half stays inspectable.
 */

import type { EffectClassification } from '../types.js';
import type { PresetName } from '../compiler/types.js';
import type { Policy } from '../policy/types.js';

/** Which operations are visible at discovery. */
export type ReadDiscoveryMode = 'all' | 'tagged-only';
export type WriteDiscoveryMode = 'all' | 'explicit-only';

export type OutputValidationMode = 'off' | 'lenient' | 'strict';
export type RedactionMode = 'off' | 'required';

/**
 * What happens when a reload produces an invalid snapshot.
 *
 * `degraded` retains the last-good snapshot and marks readiness degraded — the
 * server keeps serving what it already had rather than going dark or, worse,
 * publishing a snapshot that failed validation.
 */
export type ReloadMode = 'fail-fast' | 'degraded';

export type SessionMode = 'stateless' | 'stateful';

export interface PresetDiscoveryConfig {
  readonly readInclude: ReadDiscoveryMode;
  readonly writeInclude: WriteDiscoveryMode;
}

export interface PresetAuthenticationConfig {
  readonly required: boolean;
}

export interface PresetAuthorizationConfig {
  readonly callTime: boolean;
  /** The composed policy. Behaviour, not data — see `policySummary`. */
  readonly policy: Policy;
}

export interface PresetAuditConfig {
  readonly enabled: boolean;
  /**
   * Mandatory-delivery sink, from Epic #3 (#48).
   *
   * `null` in v0.2 and deliberately so: the preset DECLARES that audit is
   * enabled, and the sink slot exists so wiring one later is an assignment
   * rather than a redesign. See `PresetDescription.pending`.
   */
  readonly sink: null;
}

export interface PresetBounds {
  readonly requestMaxBytes: number;
  readonly responseMaxBytes: number;
  readonly deadlineMs: number;
}

export interface PresetTransportConfig {
  readonly session: SessionMode;
}

/**
 * A fully-expanded preset.
 *
 * All three presets (Light, Production, Regulated) produce this same shape —
 * that is the ADR-007 "no divergent code paths" requirement expressed in the
 * type system rather than in a comment.
 */
export interface PresetConfiguration {
  readonly discovery: PresetDiscoveryConfig;
  readonly authentication: PresetAuthenticationConfig;
  readonly authorization: PresetAuthorizationConfig;
  readonly audit: PresetAuditConfig;
  readonly outputValidation: OutputValidationMode;
  readonly redaction: RedactionMode;
  readonly reloadMode: ReloadMode;
  readonly transport: PresetTransportConfig;
  readonly bounds: PresetBounds;
}

/**
 * A control the preset promises that v0.2 does not yet enforce.
 *
 * Listed explicitly rather than left to a changelog. An operator reading
 * `describePreset` output needs to know which guarantees are live and which
 * are declared, and the honest way to say that is in the same object.
 */
export interface PendingControl {
  readonly control: string;
  /** Issue where the behaviour lands. */
  readonly trackedBy: number;
  readonly detail: string;
}

/**
 * The authorization section as DATA rather than behaviour.
 *
 * `PresetConfiguration.authorization.policy` is a closure, and `JSON.stringify`
 * of one yields `{"id":"..."}` — the functions vanish silently, which is the
 * worst kind of serialisation: it looks like it worked. So the describe path
 * carries the structural id explicitly instead of pretending an object with an
 * `evaluate` method survived the trip.
 */
export interface PresetAuthorizationSummary {
  readonly callTime: boolean;
  /**
   * The policy tree named as text, e.g.
   * `allOf(authenticated, permissionPolicy, confirmationForEffects(financial, destructive))`.
   *
   * Structural, because the combinators derive their ids from their children —
   * so this names the tree an operator is actually running.
   */
  readonly policy: string;
}

/**
 * `PresetConfiguration` with every field reduced to plain data.
 *
 * This is what `describePreset` returns and what Doctor prints. It must stay
 * JSON-safe and DETERMINISTIC: Doctor's `--json` path stringifies its whole
 * result, and there is a test pinning that two runs produce identical output.
 */
export interface PresetConfigurationSummary
  extends Omit<PresetConfiguration, 'authorization'> {
  readonly authorization: PresetAuthorizationSummary;
}

/**
 * The inspectable form of a preset — ADR-007's requirement as a return type.
 *
 * An operator should be able to read this, copy it, change one field, and pass
 * the result as ordinary configuration. If that round trip is not possible,
 * the preset has become a mode.
 */
export interface PresetDescription {
  readonly preset: PresetName;
  readonly configuration: PresetConfigurationSummary;
  readonly pending: readonly PendingControl[];
}

export interface ProductionPresetOptions {
  /**
   * Operation-id → required permissions, for the preset's `permissionPolicy`.
   *
   * **Defaults to `{}`, which denies every operation.** That is not an
   * oversight and not a placeholder: `permissionPolicy` denies unlisted
   * operations, so a production preset with no grants declared authorises
   * nothing until an operator says what is permitted. A preset that guessed a
   * permissive default would be a security preset that ships open.
   */
  readonly permissions?: Readonly<Record<string, readonly string[]>>;

  /**
   * Effect classifications requiring confirmation.
   *
   * Defaults to the §10.2 pair. Overridable because an adopter's risk model is
   * theirs, but widening is the expected direction.
   */
  readonly confirmFor?: readonly EffectClassification[];
}
