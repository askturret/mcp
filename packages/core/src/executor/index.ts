// SPDX-License-Identifier: Apache-2.0
/**
 * Operation executor strategies
 *
 * Provides viaHandler() and viaHttp() executor factories.
 * Both implement the OperationExecutor interface and produce identical
 * golden output for the same operation definition.
 */

export { viaHandler } from './via-handler.js';
export { viaHttp } from './via-http.js';
export type {
  OperationExecutor,
  OperationHandler,
  HttpExecutorOptions,
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
  CredentialResolver,
} from './types.js';
