/**
 * OpenAPI source adapter type definitions
 */

/**
 * OpenAPI import options
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
