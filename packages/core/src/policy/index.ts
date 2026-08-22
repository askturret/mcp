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

export {
  createVisibilityEngine,
  DEFAULT_VISIBILITY_CACHE_MAX_ENTRIES,
  DEFAULT_VISIBILITY_TTL_MS,
  type PolicyMetrics,
  type VisibilityEngine,
  type VisibilityEngineOptions,
  type VisibleOperationsRequest,
} from './visibility.js';

export {
  createAuthorizationEngine,
  inputHash,
  type AuthorizationEngine,
  type AuthorizationEngineOptions,
  type AuthorizationOutcome,
  type AuthorizationRequest,
  type AuthorizationTimings,
} from './authorization.js';

export {
  createConfirmationRegistry,
  DEFAULT_CONFIRMATION_TTL_MS,
  DEFAULT_MAX_OUTSTANDING_CONFIRMATIONS,
  type ConfirmationBinding,
  type ConfirmationOutcome,
  type ConfirmationRegistry,
  type ConfirmationRegistryOptions,
  type ConfirmationRejection,
} from './confirmation.js';
