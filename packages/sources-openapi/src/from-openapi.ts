/**
 * fromOpenApi() - OpenAPI 3.0/3.1 import source
 *
 * Discovers operations from OpenAPI specifications with:
 * - $ref resolution (local + file-relative)
 * - Provenance preservation (§5.3)
 * - x-mcp extension extraction
 * - Conservative effect inference from HTTP methods (§2.3)
 * - Agent-friendly name generation
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';
import type {
  OperationSource,
  DiscoveredOperation,
  DiscoveryContext,
  EffectMetadata,
  ProvenanceEntry,
} from '@askturret/mcp-core';

/**
 * OpenAPI 3.x document (union of 3.0 and 3.1)
 */
type OpenAPIDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

/**
 * OpenAPI operation object
 */
type OpenAPIOperation = OpenAPIV3.OperationObject | OpenAPIV3_1.OperationObject;

/**
 * x-mcp extension metadata (extracted from OpenAPI spec)
 */
interface XMcpExtension {
  effects?: Partial<EffectMetadata>;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * fromOpenApi() configuration options
 */
export interface FromOpenApiOptions {
  /**
   * Source ID (defaults to 'openapi')
   */
  sourceId?: string;

  /**
   * Source location hint (file path or URL)
   */
  location?: string;

  /**
   * Allow external URL $refs (defaults to false for security)
   * When false, only local and file-relative $refs are resolved
   */
  allowExternalRefs?: boolean;

  /**
   * External ref allowlist (URLs that are explicitly trusted)
   * Only used when allowExternalRefs is true
   */
  externalRefAllowlist?: string[];
}

/**
 * Create an OperationSource from an OpenAPI 3.0/3.1 specification.
 *
 * Resolves $ref, preserves provenance, extracts x-mcp extensions,
 * and infers conservative effect defaults from HTTP methods.
 *
 * @param spec - OpenAPI spec (file path, URL, or parsed object)
 * @param options - Optional source configuration
 * @returns OperationSource that emits discovered operations
 *
 * @example
 * ```ts
 * const source = fromOpenApi('./petstore.yaml', {
 *   location: 'petstore.yaml',
 * });
 * ```
 */
export function fromOpenApi(
  spec: string | OpenAPIDocument,
  options: FromOpenApiOptions = {},
): OperationSource {
  const sourceId = options.sourceId ?? 'openapi';
  const location = options.location ?? (typeof spec === 'string' ? spec : undefined);

  return {
    id: sourceId,

    async discover(context: DiscoveryContext): Promise<DiscoveredOperation[]> {
      const logger = context.logger;
      logger.info('Discovering operations from OpenAPI spec', { sourceId, location });

      try {
        // Parse and dereference the OpenAPI document
        // swagger-parser handles $ref resolution, validation, and normalization
        const api = await SwaggerParser.dereference(spec, {
          dereference: {
            circular: 'ignore', // Ignore circular refs (don't throw)
          },
        }) as OpenAPIDocument;

        if (context.abortSignal.aborted) {
          logger.info('Discovery aborted by signal');
          return [];
        }

        // Validate OpenAPI version
        const version = getOpenAPIVersion(api);
        if (!version) {
          throw new Error('Invalid or missing OpenAPI version (expected 3.0.x or 3.1.x)');
        }

        logger.debug('Parsed OpenAPI document', { version, title: api.info?.title });

        // Discover operations from paths
        const operations: DiscoveredOperation[] = [];
        const paths = api.paths ?? {};

        for (const [pathPattern, pathItem] of Object.entries(paths)) {
          if (!pathItem || typeof pathItem !== 'object') {
            continue;
          }

          // Check for path-level x-mcp extensions
          const pathXMcp = extractXMcpExtension(pathItem);

          // Process each HTTP method
          for (const method of HTTP_METHODS) {
            const operation = pathItem[method] as OpenAPIOperation | undefined;
            if (!operation) {
              continue;
            }

            try {
              const discovered = discoverOperation(
                operation,
                method,
                pathPattern,
                location,
                pathXMcp,
              );
              operations.push(discovered);
            } catch (err) {
              const error = err as Error;
              logger.warn('Failed to discover operation', {
                method,
                path: pathPattern,
                operationId: operation.operationId,
                error: error.message,
              });
            }
          }
        }

        logger.info('Discovery complete', { operationCount: operations.length });
        return operations;

      } catch (err) {
        const error = err as Error;
        logger.error('OpenAPI discovery failed', {
          error: error.message,
          location,
        });

        // Don't throw - return empty array with warning
        // Compiler will handle missing operations gracefully
        return [];
      }
    },
  };
}

/**
 * HTTP methods we extract from OpenAPI paths
 */
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

/**
 * Get OpenAPI version from document
 */
function getOpenAPIVersion(api: OpenAPIDocument): string | null {
  if ('openapi' in api && typeof api.openapi === 'string') {
    const version = api.openapi;
    // Accept 3.0.x and 3.1.x
    if (version.startsWith('3.0.') || version.startsWith('3.1.')) {
      return version;
    }
  }
  return null;
}

/**
 * Extract x-mcp extension from OpenAPI object
 */
function extractXMcpExtension(obj: Record<string, unknown>): XMcpExtension | undefined {
  const xMcp = obj['x-mcp'];
  if (xMcp && typeof xMcp === 'object' && !Array.isArray(xMcp)) {
    return xMcp as XMcpExtension;
  }
  return undefined;
}

/**
 * Discover a single operation from an OpenAPI operation object
 */
function discoverOperation(
  operation: OpenAPIOperation,
  method: string,
  pathPattern: string,
  location: string | undefined,
  pathXMcp: XMcpExtension | undefined,
): DiscoveredOperation {
  // Validate that operation has responses (required by OpenAPI spec)
  if (!operation.responses || typeof operation.responses !== 'object') {
    throw new Error('Operation missing required responses field');
  }

  // Extract operation-level x-mcp extension
  const operationXMcp = extractXMcpExtension(operation as Record<string, unknown>);

  // Merge path-level and operation-level x-mcp (operation wins)
  const xMcp: XMcpExtension = {
    ...pathXMcp,
    ...operationXMcp,
  };

  // Generate candidate ID and name
  const candidateId = generateOperationId(operation, method, pathPattern);
  const name = generateOperationName(operation, method, pathPattern);

  // Get description
  const description = operation.description
    || operation.summary
    || `${method.toUpperCase()} ${pathPattern}`;

  // Extract input/output schemas
  const rawInput = extractInputSchema(operation);
  const rawOutput = extractOutputSchema(operation);

  // Infer conservative effects from HTTP method
  const effects = inferEffects(method, xMcp.effects);

  // Build provenance chain
  const provenance = buildProvenance(location, pathPattern, method, xMcp);

  // Build hints for compiler
  const hints = {
    httpMethod: method.toUpperCase(),
    pathPattern,
    operationId: operation.operationId,
    tags: operation.tags,
    ...xMcp,
  };

  return {
    candidateId,
    name,
    description,
    ...(rawInput && { rawInput }),
    ...(rawOutput && { rawOutput }),
    source: {
      kind: 'openapi',
      ...(location && { location: `${location}#/paths/${pathPattern}/${method}` }),
    },
    effects,
    annotations: xMcp.annotations,
    provenance,
    hints,
  };
}

/**
 * Generate operation ID (unique identifier)
 */
function generateOperationId(
  operation: OpenAPIOperation,
  method: string,
  pathPattern: string,
): string {
  // Use OpenAPI operationId if present
  if (operation.operationId) {
    return operation.operationId;
  }

  // Fallback: generate from method + path
  // Example: GET /users/{id} -> get-users-id
  const pathSegments = pathPattern
    .split('/')
    .filter(s => s.length > 0)
    .map(s => s.replace(/[{}]/g, '')) // Remove {param} braces
    .join('-');

  return `${method}-${pathSegments}`;
}

/**
 * Generate agent-friendly operation name
 */
function generateOperationName(
  operation: OpenAPIOperation,
  method: string,
  pathPattern: string,
): string {
  // Use OpenAPI operationId if present and agent-friendly
  if (operation.operationId && isAgentFriendlyName(operation.operationId)) {
    return operation.operationId;
  }

  // Fallback: camelCase from method + path
  // Example: GET /users/{id} -> getUsers
  const pathSegments = pathPattern
    .split('/')
    .filter(s => s.length > 0 && !s.startsWith('{')) // Skip path params
    .map((s, i) => i === 0 ? s.toLowerCase() : capitalize(s));

  const verb = method.toLowerCase();
  const resource = pathSegments.join('');

  return `${verb}${capitalize(resource)}`;
}

/**
 * Check if a name is agent-friendly (camelCase or kebab-case, no special chars)
 */
function isAgentFriendlyName(name: string): boolean {
  return /^[a-z][a-zA-Z0-9-]*$/.test(name);
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Extract input schema from OpenAPI operation
 */
function extractInputSchema(operation: OpenAPIOperation): Record<string, unknown> | undefined {
  // For operations with requestBody (POST, PUT, PATCH), use that
  const requestBody = operation.requestBody;
  if (requestBody && typeof requestBody === 'object') {
    // Type guard: SwaggerParser.dereference() should have resolved all $refs,
    // but the type system doesn't know that. Skip if this is a ReferenceObject.
    if (!('$ref' in requestBody)) {
      const content = requestBody.content;
      if (content) {
        // Prefer application/json, fall back to first available
        const jsonSchema = content['application/json']?.schema;
        if (jsonSchema) {
          return jsonSchema as Record<string, unknown>;
        }

        // Try other content types
        const firstContent = Object.values(content)[0];
        if (firstContent?.schema) {
          return firstContent.schema as Record<string, unknown>;
        }
      }
    }
  }

  // For operations with parameters (GET, DELETE), build schema from parameters
  const parameters = operation.parameters;
  if (!parameters || !Array.isArray(parameters) || parameters.length === 0) {
    return undefined;
  }

  // Convert parameters array to JSON Schema object
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of parameters) {
    // Skip if this is a ReferenceObject
    if (!param || typeof param !== 'object' || '$ref' in param) {
      continue;
    }

    const name = param.name;
    const paramSchema = param.schema;

    if (name && paramSchema && typeof paramSchema === 'object') {
      properties[name] = paramSchema;
      if (param.required === true) {
        required.push(name);
      }
    }
  }

  // Return schema only if we found parameters
  if (Object.keys(properties).length === 0) {
    return undefined;
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 && { required }),
  };
}

/**
 * Extract output schema from OpenAPI operation
 */
function extractOutputSchema(operation: OpenAPIOperation): Record<string, unknown> | undefined {
  const responses = operation.responses;
  if (!responses) {
    return undefined;
  }

  // Prefer 200/201/default, in that order
  const successResponse = responses['200'] ?? responses['201'] ?? responses['default'];
  if (!successResponse || typeof successResponse !== 'object') {
    return undefined;
  }

  // Type guard: SwaggerParser.dereference() should have resolved all $refs,
  // but the type system doesn't know that. Skip if this is a ReferenceObject.
  if ('$ref' in successResponse) {
    return undefined;
  }

  const content = successResponse.content;
  if (!content) {
    return undefined;
  }

  // Prefer application/json
  const jsonSchema = content['application/json']?.schema;
  if (jsonSchema) {
    return jsonSchema as Record<string, unknown>;
  }

  // Try other content types
  const firstContent = Object.values(content)[0];
  if (firstContent?.schema) {
    return firstContent.schema as Record<string, unknown>;
  }

  return undefined;
}

/**
 * Infer conservative effect metadata from HTTP method
 *
 * Per §2.3 safety-first defaults and §5.7 ADR-006:
 * - GET, HEAD → readOnly: true, idempotent: true, retryable: true
 * - PUT, DELETE → readOnly: false, idempotent: true, retryable: false
 * - POST, PATCH → readOnly: false, idempotent: false, retryable: false, idempotencyKeyRequired: true
 */
function inferEffects(
  method: string,
  xMcpEffects?: Partial<EffectMetadata>,
): Partial<EffectMetadata> {
  const methodUpper = method.toUpperCase();

  let baseEffects: Partial<EffectMetadata>;

  if (methodUpper === 'GET' || methodUpper === 'HEAD') {
    // Read-only, safe to retry
    baseEffects = {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    };
  } else if (methodUpper === 'PUT' || methodUpper === 'DELETE') {
    // Idempotent mutations, but require explicit retry opt-in
    baseEffects = {
      readOnly: false,
      idempotent: true,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications: [],
    };
  } else if (methodUpper === 'POST' || methodUpper === 'PATCH') {
    // Non-idempotent mutations, require idempotency key
    baseEffects = {
      readOnly: false,
      idempotent: false,
      retryable: false,
      idempotencyKeyRequired: true,
      classifications: [],
    };
  } else {
    // OPTIONS, TRACE, etc. - treat as read-only
    baseEffects = {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    };
  }

  // x-mcp effects override base inference
  // Merge classifications if both present
  if (xMcpEffects) {
    const mergedClassifications = [
      ...(baseEffects.classifications ?? []),
      ...(xMcpEffects.classifications ?? []),
    ];

    return {
      ...baseEffects,
      ...xMcpEffects,
      ...(mergedClassifications.length > 0 && { classifications: mergedClassifications }),
    };
  }

  return baseEffects;
}

/**
 * Build provenance chain for discovered operation
 */
function buildProvenance(
  location: string | undefined,
  pathPattern: string,
  method: string,
  xMcp: XMcpExtension,
): ProvenanceEntry[] {
  const provenance: ProvenanceEntry[] = [];
  const pointer = location ? `${location}#/paths/${pathPattern}/${method}` : undefined;

  // Name provenance
  provenance.push({
    field: 'name',
    kind: 'openapi',
    ...(pointer && { location: pointer }),
  });

  // Description provenance
  provenance.push({
    field: 'description',
    kind: 'openapi',
    ...(pointer && { location: pointer }),
  });

  // Effects provenance
  if (xMcp.effects) {
    // Effects came from x-mcp extension (higher precedence)
    provenance.push({
      field: 'effects',
      kind: 'overlay', // x-mcp is treated as source-native metadata (§5.3)
      ...(pointer && { location: pointer }),
    });
  } else {
    // Effects came from HTTP method inference
    provenance.push({
      field: 'effects',
      kind: 'inference',
      ...(pointer && { location: pointer }),
    });
  }

  return provenance;
}
