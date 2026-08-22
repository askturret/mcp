// SPDX-License-Identifier: Apache-2.0
/**
 * Policy engine — three-valued decisions, boolean composition, and the initial
 * set of built-in rules.
 *
 * ```ts
 * const policy = allOf([
 *   authenticated(),
 *   permissionPolicy({ transferFunds: ['payments:write'] }),
 *   confirmationForEffects(['financial', 'destructive']),
 * ]);
 * ```
 *
 * Wiring this into discovery-time visibility and call-time authorization is
 * deliberately not here — those are separate seams (`AuthorizeHook`,
 * `VerifyConfirmationHook`) and separate issues.
 */

export type {
  ClientInfo,
  ConfirmationChallenge,
  Policy,
  PolicyContext,
  PolicyDecision,
  PolicyEvidence,
  PolicyPhase,
} from './types.js';

export { allOf, anyOf, not } from './combinators.js';

export {
  authenticated,
  confirmationForEffects,
  permissionPolicy,
  readOnly,
  type ConfirmationForEffectsOptions,
  type PermissionPolicyOptions,
  type UnlistedOperationBehaviour,
} from './builtins.js';
