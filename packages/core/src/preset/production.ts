// SPDX-License-Identifier: Apache-2.0
/**
 * The Production preset — §10.2's Production column, composed.
 *
 * ADR-007 again, because it is the whole design here: this file contains no
 * behaviour. It assembles primitives that already exist — the policy
 * combinators from #33, discovery visibility from #34, call-time authorization
 * from #35 — into one named configuration, and hands it back as data an
 * operator can read and edit. Nothing downstream branches on "is this the
 * production preset"; it branches on the configuration values, exactly as it
 * would if the operator had written them out by hand.
 *
 * The test of that claim is `describePreset`: if the expansion could not be
 * printed and pasted back as ordinary config, the preset would be a mode.
 */

import type { EffectClassification } from '../types.js';
import { allOf } from '../policy/combinators.js';
import { authenticated, confirmationForEffects, permissionPolicy } from '../policy/builtins.js';
import { regulatedPending, regulatedPreset } from './regulated.js';
import type {
  PendingControl,
  PresetConfiguration,
  PresetDescription,
  ProductionPresetOptions,
  RegulatedPresetOptions,
} from './types.js';

/** §10.2: confirmation applies to the write-risk classifications. */
export const PRODUCTION_CONFIRM_FOR: readonly EffectClassification[] = ['financial', 'destructive'];

/**
 * §10.2 bounds.
 *
 * Two of the three match the transport's existing defaults. The exception is
 * `responseMaxBytes`, which the preset RAISES from 1 MiB to 4 MiB — and a
 * security preset loosening a safety bound deserves its reason stated rather
 * than absorbed: a production deployment serving real tool output hits a 1 MiB
 * response cap on legitimate traffic, and an operator who meets `OUTPUT_TOO_LARGE`
 * on a valid response will raise the limit anyway, less carefully and under
 * time pressure. The request cap, which is the one an attacker controls, is
 * unchanged.
 */
export const PRODUCTION_BOUNDS = {
  requestMaxBytes: 1 << 20, // 1 MiB — same as the transport default
  responseMaxBytes: 4 << 20, // 4 MiB — raised from the 1 MiB default, see above
  deadlineMs: 30_000, // same as the transport default
} as const;

/**
 * Controls the Production preset promises that v0.2 does not yet enforce.
 *
 * Kept as data on the description rather than as a comment, because the person
 * who most needs it is an operator reading `describePreset` output at 3am, not
 * a developer reading this file. "Declared but not yet enforced" is exactly the
 * kind of thing that is unfair to discover from behaviour.
 */
const PRODUCTION_PENDING: readonly PendingControl[] = [
  {
    control: 'audit.sink',
    trackedBy: 48,
    detail:
      'Audit is declared enabled and the dispatcher calls its audit hook, but the ' +
      'mandatory-delivery sink ships in Epic #3. Until then, audit events go wherever ' +
      'the adopter-supplied hook sends them, with no delivery guarantee.',
  },
  {
    control: 'redaction',
    trackedBy: 49,
    detail:
      'Redaction is declared required, but the central pipeline ships in Epic #3. The ' +
      'dispatcher redact hook is a pass-through by default, so nothing is redacted ' +
      'unless the adopter supplies a hook.',
  },
  {
    control: 'authentication.required',
    trackedBy: 35,
    detail:
      'Enforced at CALL time by the authorization policy, which denies without a ' +
      'principal. It is NOT enforced at discovery time: no principal reaches the ' +
      'discovery path in v0.2, so tools/list would hide every tool if this policy were ' +
      'used there. The preset therefore uses a separate discovery policy.',
  },
  {
    control: 'outputValidation',
    trackedBy: 36,
    detail:
      'Declared strict, but the dispatcher stage-9 check is a null/undefined test — full ' +
      'JSON Schema validation is deferred. The value is carried so the setting is stable ' +
      'before the behaviour fills in.',
  },
  {
    control: 'reloadMode',
    trackedBy: 37,
    detail:
      'Partially live as of #37. The mechanism exists and honours this value: ' +
      'createReloadController retains the last-good snapshot on a rejected candidate, ' +
      'marks readiness degraded, and never publishes a snapshot that failed validation. ' +
      'What is NOT yet wired is preset -> controller: createMcpServer is still a v0.1 ' +
      'stub, so nothing reads this field off the preset and constructs a controller from ' +
      'it. An adopter selecting the Production preset must build the controller itself ' +
      'and pass mode: preset.reloadMode. Downgraded from "nothing consumes this value" ' +
      'rather than removed, because removing it would claim an end-to-end guarantee that ' +
      'server assembly has not yet made true.',
  },
];

/**
 * Expand the Production preset.
 *
 * ## On `permissionPolicy()`
 *
 * §10.2's composition is written `permissionPolicy()` with no arguments. The
 * merged signature requires a grants map, and there is no sensible default for
 * one — a preset cannot know which operations an adopter means to permit.
 *
 * So the map comes from options and defaults to `{}`. Because
 * `permissionPolicy` denies unlisted operations, **the Production preset with
 * no grants configured authorises nothing.** That is the intended reading of a
 * security preset: it fails closed and makes you say what is allowed, rather
 * than shipping open and making you remember to close it.
 */
export function productionPreset(options?: ProductionPresetOptions): PresetConfiguration {
  const permissions = options?.permissions ?? {};
  const confirmFor = options?.confirmFor ?? PRODUCTION_CONFIRM_FOR;

  return {
    discovery: { readInclude: 'tagged-only', writeInclude: 'explicit-only' },
    authentication: { required: true },
    authorization: {
      callTime: true,
      policy: allOf([
        authenticated(),
        permissionPolicy(permissions),
        confirmationForEffects(confirmFor),
      ]),
    },
    audit: { enabled: true, sink: null, durability: 'optional' },
    outputValidation: 'strict',
    // `customReviewAcknowledged` is false here and that is not a refusal:
    // §10.2 asks for the acknowledgement under Regulated only. Production
    // carries the field so all three presets share one shape (ADR-007), with
    // the value that is true of it — nobody has been asked to attest anything.
    redaction: { mode: 'required', customReviewAcknowledged: false },
    reloadMode: 'degraded',
    transport: { session: 'stateless' },
    bounds: { ...PRODUCTION_BOUNDS },
  };
}

/**
 * The inspectable expansion — ADR-007's requirement in one function.
 *
 * An operator should be able to read this, copy it, change one field, and pass
 * the result as ordinary configuration. If that is not possible, the preset has
 * become a mode.
 */
export function describePreset(
  preset: 'production',
  options?: ProductionPresetOptions,
): PresetDescription;
export function describePreset(
  preset: 'regulated',
  options: RegulatedPresetOptions,
): PresetDescription;
export function describePreset(
  preset: 'production' | 'regulated',
  options?: ProductionPresetOptions | RegulatedPresetOptions,
): PresetDescription {
  // Regulated's options are REQUIRED — the overloads above enforce that at the
  // type level, and this cast is where the two signatures meet. Passing them
  // straight through means `describePreset('regulated', ...)` refuses exactly
  // as `regulatedPreset(...)` does: describing a configuration that could never
  // boot would be a strictly worse answer than the refusal.
  const expanded =
    preset === 'regulated'
      ? regulatedPreset(options as RegulatedPresetOptions)
      : productionPreset(options as ProductionPresetOptions | undefined);

  const { authorization, ...rest } = expanded;

  return {
    preset,
    configuration: {
      ...rest,
      authorization: { callTime: authorization.callTime, policy: authorization.policy.id },
    },
    pending: preset === 'regulated' ? regulatedPending() : PRODUCTION_PENDING,
  };
}

/**
 * The preset's bounds, under the names the HTTP transport actually uses.
 *
 * §10.2 names them `requestMaxBytes` / `responseMaxBytes`;
 * `HttpTransportOptions` calls them `maxRequestBodySize` / `maxResponseSize`.
 * Rather than rename either — the spec's names belong to the spec, the
 * transport's to its own API — the translation lives in one function, so a
 * caller wiring a preset cannot silently pass a field the transport ignores.
 *
 * That failure mode is worth guarding against specifically: an unknown extra
 * property on an options object is not a type error when the object is built
 * elsewhere, so `requestMaxBytes: 1<<20` would have been accepted and quietly
 * dropped, leaving the default in place and the operator believing otherwise.
 */
export function presetTransportBounds(configuration: PresetConfiguration): {
  readonly maxRequestBodySize: number;
  readonly maxResponseSize: number;
  readonly deadlineMs: number;
} {
  return {
    maxRequestBodySize: configuration.bounds.requestMaxBytes,
    maxResponseSize: configuration.bounds.responseMaxBytes,
    deadlineMs: configuration.bounds.deadlineMs,
  };
}
