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
import type { EvidenceVerifier } from '../policy/builtins.js';
import type { Policy } from '../policy/types.js';

/** Which operations are visible at discovery. */
export type ReadDiscoveryMode = 'all' | 'tagged-only' | 'explicit-only';
export type WriteDiscoveryMode = 'all' | 'explicit-only';

export type OutputValidationMode = 'off' | 'lenient' | 'strict';
export type RedactionMode = 'off' | 'required';

/**
 * What happens when a reload produces an invalid snapshot.
 *
 * `degraded` retains the last-good snapshot and marks readiness degraded — the
 * server keeps serving what it already had rather than going dark or, worse,
 * publishing a snapshot that failed validation.
 *
 * `fail-readiness` (§10.2 Regulated) also retains the last-good snapshot, and
 * differs in what it tells the outside world: readiness goes hard-negative so
 * the instance is pulled from its load balancer, rather than continuing to
 * serve while flagged degraded. The distinction matters for an environment
 * where serving a stale-but-valid contract without announcing it is itself the
 * compliance failure — "retain evidence, do not degrade silently".
 */
export type ReloadMode = 'fail-fast' | 'degraded' | 'fail-readiness';

/**
 * Whether the audit sink must survive process loss.
 *
 * `required` (§10.2 Regulated) refuses to boot against a sink that cannot make
 * that promise — stdout and in-memory buffers are the named examples.
 */
export type AuditDurability = 'optional' | 'required';

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
  /**
   * Whether a durable sink is mandatory (§10.2).
   *
   * §52 writes this as `sink: { durable: 'required' }`. It is a sibling field
   * here instead, because `sink` is still the `null` placeholder above and
   * collapsing a declared requirement into a slot that is not yet wired would
   * make the requirement unreadable exactly while it is unenforced. Recorded
   * against #156 rather than reshaping the spec's example silently.
   */
  readonly durability: AuditDurability;
}

/**
 * Redaction settings (§10.2).
 *
 * An object rather than the bare `RedactionMode` scalar the earlier presets
 * used, because Regulated needs a second field and ADR-007 requires all three
 * presets to produce the SAME shape — a scalar for two of them and an object
 * for the third is precisely the divergent code path the ADR forbids.
 */
export interface PresetRedactionConfig {
  readonly mode: RedactionMode;
  /**
   * The adopter's attestation that they reviewed their custom redaction rules
   * for this environment.
   *
   * §52 is explicit that this "is a signature, not a security control" — the
   * value proves nothing on its own, and nothing downstream reads it to decide
   * whether to redact. Its only job is to make an adopter state, at boot, that
   * a human looked. The Regulated preset refuses to boot while it is `false`.
   */
  readonly customReviewAcknowledged: boolean;
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
  readonly redaction: PresetRedactionConfig;
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

/**
 * How an audit sink identifies itself for the durability check.
 *
 * The check is a DECLARATION, not an inspection: nothing here can prove a sink
 * writes to durable storage, and pretending otherwise would be worse than not
 * checking. What it does is stop the two sinks §52 names — stdout and an
 * in-memory buffer — from being selected by accident, and force anything else
 * to state its case at boot.
 */
export type AuditSinkDurabilityClaim = 'durable' | 'stdout' | 'memory';

export interface RegulatedAuditSinkDescriptor {
  /** Sink name, used only in the refusal message. */
  readonly id: string;
  readonly durability: AuditSinkDurabilityClaim;
}

export interface RegulatedPresetOptions {
  /**
   * Operation-id → required permissions. Same semantics and same deny-by-
   * default as the Production preset.
   */
  readonly permissions?: Readonly<Record<string, readonly string[]>>;

  /**
   * The audit sink this deployment will use.
   *
   * REQUIRED. §10.2 makes a durable sink mandatory under Regulated, so there is
   * no default that could be correct — omitting it refuses the boot rather than
   * assuming one.
   */
  readonly auditSink: RegulatedAuditSinkDescriptor;

  /**
   * The adopter's acknowledgement that they reviewed their custom redaction
   * rules. Must be `true`; `false` or omitted refuses the boot.
   */
  readonly customReviewAcknowledged?: boolean;

  /**
   * Verifier for the out-of-band signature on a confirmation proof.
   *
   * REQUIRED, for the reason given on `requireEvidence`: there is no default
   * that is not either decorative or a runtime trap.
   */
  readonly verifyEvidence: EvidenceVerifier;

  /**
   * Evidence kind demanded by the composed confirmation policy.
   * Defaults to §52's `'signed-approval'`.
   */
  readonly evidenceKind?: string;
}
