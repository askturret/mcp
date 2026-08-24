// SPDX-License-Identifier: Apache-2.0
/**
 * AskTurret MCP - Core Runtime
 *
 * Canonical model, compiler, registry, policies, and execution lifecycle.
 */

/**
 * Placeholder for createMcpServer - the main entry point for the Light API
 */
export function createMcpServer(_options?: unknown): unknown {
  // Stub implementation for v0.1
  return {
    start: async () => {
      throw new Error('Not yet implemented');
    },
    stop: async () => {
      throw new Error('Not yet implemented');
    },
  };
}

/**
 * Version information
 */
export const VERSION = '0.1.0';

/**
 * Re-export all core types and utilities
 */
export * from './types.js';
export * from './sources/index.js';
export * from './compiler/index.js';
export type { CompilerContext, CompilerPass, CompilerWarning } from './compiler/types.js';
export { omitUndefined } from './utils.js';
export { AtomicRegistryReference, type RegistryReference } from './registry-reference.js';
export { createDispatcher, type CommandDispatcher, type DispatcherHooks, type DispatchContext, type MCPResult } from './dispatcher/index.js';
export { viaHandler, viaHttp, type OperationExecutor, type OperationHandler, type HttpExecutorOptions, type HttpClient } from './executor/index.js';
export {
  allOf,
  anyOf,
  not,
  authenticated,
  confirmationForEffects,
  permissionPolicy,
  readOnly,
  type ClientInfo,
  type ConfirmationChallenge,
  type ConfirmationForEffectsOptions,
  type PermissionPolicyOptions,
  type Policy,
  type PolicyContext,
  type PolicyDecision,
  type PolicyEvidence,
  type PolicyPhase,
  type UnlistedOperationBehaviour,
  createVisibilityEngine,
  DEFAULT_VISIBILITY_CACHE_MAX_ENTRIES,
  DEFAULT_VISIBILITY_TTL_MS,
  type PolicyMetrics,
  type VisibilityEngine,
  type VisibilityEngineOptions,
  type VisibleOperationsRequest,
  createAuthorizationEngine,
  createConfirmationRegistry,
  fingerprintInput,
  DEFAULT_CONFIRMATION_TTL_MS,
  DEFAULT_MAX_OUTSTANDING_CONFIRMATIONS,
  type AuthorizationEngine,
  type AuthorizationEngineOptions,
  type AuthorizationOutcome,
  type AuthorizationRequest,
  type AuthorizationTimings,
  type InputFingerprint,
  type ConfirmationBinding,
  type ConfirmationOutcome,
  type ConfirmationRegistry,
  type ConfirmationRegistryOptions,
  type ConfirmationRejection,
} from './policy/index.js';
export type { DispatcherOptions } from './dispatcher/index.js';
export * from './protocol/index.js';
export * from './preset/index.js';
export * from './plugin/index.js';
export * from './overlay/index.js';
export * from './reload/index.js';
export * from './logging/index.js';
export * from './telemetry/index.js';
export * from './diff/index.js';
export * from './facade/index.js';
export * from './bulkhead/index.js';
export * from './retry/index.js';
export * from './breaker/index.js';
export * from './lifecycle/index.js';
export * from './health/index.js';
export * from './audit/index.js';
export * from './redaction/index.js';
export {
  SNAPSHOT_FORMAT_VERSION,
  SnapshotFormatError,
  deserializeSnapshot,
  serializeSnapshot,
  type SerializedSnapshot,
} from './snapshot-io.js';
