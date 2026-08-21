// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAPI source adapter type definitions
 */

export type { FromOpenApiOptions } from './from-openapi.js';

/**
 * OpenAPI import options (legacy - may be merged into FromOpenApiOptions)
 */
export interface OpenApiImportOptions {
  /**
   * Filter operations by tags
   */
  includeTags?: string[];

  /**
   * Exclude operations by tags
   */
  excludeTags?: string[];

  /**
   * Include deprecated operations
   */
  includeDeprecated?: boolean;
}
