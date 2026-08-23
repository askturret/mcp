// SPDX-License-Identifier: Apache-2.0
/**
 * The Regulated preset — §10.2's Regulated column, composed (#52).
 *
 * Same ADR-007 discipline as Production: no behaviour lives here. This file
 * assembles primitives that already exist into one named configuration and
 * hands it back as data an operator can read and edit. Nothing downstream
 * branches on "is this the regulated preset"; it branches on the configuration
 * values, exactly as it would if an operator had written them out by hand.
 *
 * ## Why the refusals are thrown here and nowhere else
 *
 * §52's acceptance is that "all refusals are boot-time, not runtime — an
 * adopter running `preset: 'regulated'` cannot accidentally weaken it after
 * start." Expansion is the only moment that property can be established: after
 * this function returns, the result is ordinary configuration, and ordinary
 * configuration is editable by construction. A check placed downstream — in the
 * dispatcher, in the transport — would run per call, which is precisely the
 * runtime enforcement the issue rules out, and would let a process start in a
 * state it should never have reached.
 *
 * So every refusal below throws from `regulatedPreset()`. The cost is that a
 * misconfigured deployment does not start; that is the intended cost. A
 * regulated deployment that boots with a non-durable audit sink and discovers
 * it during an incident is worse off than one that refused to boot at all.
 *
 * ## What these refusals do NOT do
 *
 * The durability check reads a DECLARATION. Nothing here can prove a sink
 * writes to durable storage, and a check that implied otherwise would be worse
 * than no check — it would let an adopter believe an inspection happened. What
 * it buys is that the two sinks §52 names as non-durable cannot be selected by
 * accident, and that anything else has to state its case in configuration where
 * a reviewer can see it.
 *
 * The same is true, more sharply, of `customReviewAcknowledged`: §52 says
 * outright that it "is a signature, not a security control". Setting it to
 * `true` protects nothing. Being made to set it is the entire mechanism.
 */

import { allOf } from '../policy/combinators.js';
import { authenticated, permissionPolicy, requireEvidence } from '../policy/builtins.js';
import type {
  PendingControl,
  PresetConfiguration,
  RegulatedAuditSinkDescriptor,
  RegulatedPresetOptions,
} from './types.js';

/** §52's default evidence kind. */
export const REGULATED_EVIDENCE_KIND = 'signed-approval';

/**
 * §10.2 Regulated bounds.
 *
 * Every one is TIGHTER than Production's, which is the column's whole point:
 * the request cap halves to 512 KiB, the response cap drops back to the
 * transport's 1 MiB default (Production raises it to 4 MiB for legitimate
 * large tool output; a regulated deployment takes the stricter bound and asks
 * for an explicit override if it genuinely needs more), and the deadline
 * shortens to 20s.
 */
export const REGULATED_BOUNDS = {
  requestMaxBytes: 512 << 10, // 512 KiB — half Production's
  responseMaxBytes: 1 << 20, // 1 MiB — the transport default, not Production's raised cap
  deadlineMs: 20_000, // 20s — shorter than the 30s default
} as const;

/**
 * Thrown when a Regulated expansion is refused at boot.
 *
 * A named class rather than a bare `Error` so an adopter's bootstrap can
 * distinguish "this configuration is not admissible under Regulated" from any
 * other startup failure, and so a test can assert the reason without matching
 * on message text.
 */
export class RegulatedPresetRefusal extends Error {
  /** Which control refused. Stable; the message is not. */
  readonly control: string;

  constructor(control: string, message: string) {
    super(message);
    this.name = 'RegulatedPresetRefusal';
    this.control = control;
  }
}

/**
 * Controls the Regulated preset declares that v0.2 does not yet enforce.
 *
 * Inherited honestly from Production rather than quietly omitted: selecting a
 * stricter preset does not make an unenforced control enforced, and an operator
 * reading `describePreset('regulated')` needs the same warning an operator
 * reading the Production one gets.
 */
const REGULATED_PENDING: readonly PendingControl[] = [
  {
    control: 'audit.durability',
    trackedBy: 48,
    detail:
      'The REFUSAL is live: a sink declaring stdout or memory durability cannot expand this ' +
      'preset. What is not live is verification — the check reads the descriptor an adopter ' +
      'supplies and cannot confirm that a sink claiming durability actually persists. The ' +
      'mandatory-delivery sink from Epic #3 is what would make the claim checkable.',
  },
  {
    control: 'redaction',
    trackedBy: 49,
    detail:
      'Declared required, and the customReviewAcknowledged refusal is live. The central ' +
      'redaction pipeline itself ships in Epic #3; until it is wired, acknowledging review ' +
      'attests to rules that nothing in the dispatcher yet applies.',
  },
  {
    control: 'discovery.readInclude',
    trackedBy: 34,
    detail:
      'Regulated narrows read discovery to explicit-only, which is stricter than the ' +
      'tagged-only mode #34 implements. The visibility engine has no explicit-only branch ' +
      'yet, so this value is declared and carried but not yet honoured at list time.',
  },
  {
    control: 'reloadMode',
    trackedBy: 37,
    detail:
      'fail-readiness is a new mode introduced by this preset. createReloadController ' +
      'understands fail-fast and degraded; it has no fail-readiness branch, so an adopter ' +
      'selecting Regulated today gets degraded behaviour from the controller unless they ' +
      'wire readiness themselves. Declared rather than silently mapped onto degraded, ' +
      'because the difference — pulled from the load balancer versus still serving while ' +
      'flagged — is the entire reason §10.2 lists it separately.',
  },
  {
    control: 'outputValidation',
    trackedBy: 36,
    detail:
      'Declared strict, exactly as Production declares it. The dispatcher stage-9 check is ' +
      'still a null/undefined test rather than full JSON Schema validation.',
  },
];

function refuseNonDurableSink(sink: RegulatedAuditSinkDescriptor): void {
  if (sink.durability === 'durable') return;

  throw new RegulatedPresetRefusal(
    'audit.durability',
    `The Regulated preset requires a durable audit sink (§10.2), but the configured sink ` +
      `'${sink.id}' declares durability '${sink.durability}'. A stdout or in-memory sink does ` +
      `not survive process loss, so an audit trail kept there cannot be evidence. Configure a ` +
      `sink that persists, or select the Production preset if this deployment does not need ` +
      `mandatory-delivery audit.`,
  );
}

/**
 * Expand the Regulated preset (§10.2 Regulated column).
 *
 * Throws `RegulatedPresetRefusal` — at boot, never at call time — when the
 * configuration is not admissible. See the file header for why that is the only
 * place the check can live.
 */
export function regulatedPreset(options: RegulatedPresetOptions): PresetConfiguration {
  // Ordered most-structural first, so an adopter fixing several problems is
  // told about the audit sink before the acknowledgement checkbox rather than
  // the other way round.
  refuseNonDurableSink(options.auditSink);

  if (options.customReviewAcknowledged !== true) {
    throw new RegulatedPresetRefusal(
      'redaction.customReviewAcknowledged',
      `The Regulated preset requires customReviewAcknowledged: true (§10.2). This is a ` +
        `signature, not a security control: setting it protects nothing by itself, and it is ` +
        `here to record that a human reviewed the redaction rules for this environment. ` +
        `Review them, then set it explicitly.`,
    );
  }

  // Not one of §52's two named refusals — see the DEVIATION note in the tests
  // and the PR. A missing verifier has no safe default: accepting everything
  // makes the evidence policy decorative, and rejecting everything turns every
  // guarded call into a runtime denial an operator has to debug from behaviour.
  // Refusing at boot is the only option consistent with "cannot accidentally
  // weaken it after start".
  if (typeof options.verifyEvidence !== 'function') {
    throw new RegulatedPresetRefusal(
      'authorization.verifyEvidence',
      `The Regulated preset requires a verifyEvidence function (§10.2 explicit evidence ` +
        `policy). The signature scheme is adopter-configurable and has no default: one that ` +
        `accepted any proof would make the evidence requirement decorative, and one that ` +
        `rejected every proof would fail each guarded call at runtime instead of here.`,
    );
  }

  const permissions = options.permissions ?? {};
  const evidenceKind = options.evidenceKind ?? REGULATED_EVIDENCE_KIND;

  return {
    // §10.2: explicit-only on BOTH axes. Production narrows only writes.
    discovery: { readInclude: 'explicit-only', writeInclude: 'explicit-only' },
    authentication: { required: true },
    authorization: {
      callTime: true,
      // §52's composition exactly: allOf([authenticated, permissionPolicy,
      // requireEvidence]). Note requireEvidence REPLACES confirmationForEffects
      // rather than joining it — Regulated's confirmation requirement is not
      // conditional on an operation's classifications, which is what makes it
      // an "explicit evidence policy (not just effect-based)".
      policy: allOf([
        authenticated(),
        permissionPolicy(permissions),
        requireEvidence(evidenceKind, options.verifyEvidence),
      ]),
    },
    audit: { enabled: true, sink: null, durability: 'required' },
    outputValidation: 'strict',
    redaction: { mode: 'required', customReviewAcknowledged: true },
    reloadMode: 'fail-readiness',
    transport: { session: 'stateless' },
    bounds: { ...REGULATED_BOUNDS },
  };
}

/** The pending-control list for the Regulated preset. */
export function regulatedPending(): readonly PendingControl[] {
  return REGULATED_PENDING;
}
