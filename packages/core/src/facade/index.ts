// SPDX-License-Identifier: Apache-2.0
/**
 * Framework-neutral facade wiring shared by every adapter (§4, §12.3).
 */

export {
  FACADE_DEFAULT_BASE_PATH,
  FACADE_DEFAULT_DEADLINE_MS,
  FACADE_DEFAULT_MAX_REQUEST_BODY_SIZE,
  FACADE_DEFAULT_MAX_RESPONSE_SIZE,
  applyIncludeFilter,
  bootstrapRegistry,
  createFacadeLogger,
  emptySnapshot,
  explorerProductionWarning,
  extractUserContext,
  resolveFacadeDefaults,
  type RegistryBootstrap,
} from './bootstrap.js';

export type {
  FacadeRequestContext,
  FacadeTransportOptions,
  IncludeFilter,
  McpFacadeOptions,
  McpFromOpenApiFacadeOptions,
  ResolvedFacadeDefaults,
} from './types.js';
