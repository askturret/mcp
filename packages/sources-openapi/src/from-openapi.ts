// SPDX-License-Identifier: Apache-2.0
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
import { resolveServerUrl, type OpenApiServer } from './resolve-server-url.js';
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
 * OpenAPI parameter object, after the `$ref` guard has narrowed it (#718).
 */
type OpenAPIParameter = OpenAPIV3.ParameterObject | OpenAPIV3_1.ParameterObject;

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
   * Explicit upstream base URL for calling the described API.
   *
   * Overrides whatever the spec's `servers` array resolves to. Supply this when
   * the spec declares no absolute server, declares several and you want a
   * specific one, or points at an environment you are not targeting.
   */
  baseUrl?: string;

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

        // Validate OpenAPI version.
        //
        // A REFUSAL RETURNS; IT DOES NOT THROW (#628). An unsupported version is
        // an EXPECTED outcome — the system working, correctly declining a
        // document it does not support. Throwing routed it into the catch below,
        // where it logged 'OpenAPI discovery failed' and became indistinguishable
        // from a genuine internal fault: two outcomes with opposite operational
        // meanings, separable only by parsing `error.message`, which
        // compatibility-policy.md forbids. A raw Error whose only distinguishing
        // feature is its message is a sentinel string wearing an exception.
        //
        // So the refusal is logged under its OWN event carrying a stable
        // `reason` code, and returns `[]` directly. That is the ADR-011 shape
        // available here: `discover()` yields operations rather than a result
        // envelope, so the typed outcome is carried by a distinct event plus
        // structured details instead of by a changed return type — the same
        // move ADR-011 cites in `policy/authorization.ts`, which returns a
        // result object rather than a sentinel string.
        //
        // The #625 reasons for `[]` over `throw` are unchanged and recorded at
        // the catch below; this does not revisit them. What changed is only that
        // the expected case no longer borrows the unexpected one's path, which
        // leaves that catch meaning "something went wrong" — what a catch should
        // mean.
        //
        // PUBLISHED CONTRACT, deliberately not altered: docs/compatibility.
        // {md,json} promise refusal surfaces as "zero operations and a logged
        // error, not a thrown exception". Still zero operations, still a logged
        // error, still no exception — only now a distinct one.
        // WHICH DOCUMENTS ACTUALLY REACH HERE — measured, not assumed (#628).
        // `SwaggerParser.dereference` above rejects most unsupported versions
        // itself, throwing before this check ever runs: `openapi: "2.0.0"`,
        // a bare `"3.0"` or `"3.1"`, `"3.2.0"`, `"4.0.0"` and a document with no
        // `openapi` field all fail inside the parser and land in the catch.
        //
        // The case that DOES arrive here is a genuine Swagger 2.0 document in
        // its native form — `swagger: "2.0"` and no `openapi` field. The parser
        // supports Swagger 2.0 and accepts it happily; we are the ones declining
        // it. That is exactly the "2.0 (Swagger)" row in docs/compatibility.json,
        // and it is why this check is not dead code.
        const version = getOpenAPIVersion(api);
        if (!version) {
          const declaredOpenApi = declaredOpenApiVersion(api);
          const declaredSwagger = declaredSwaggerVersion(api);
          logger.error('OpenAPI version not supported', {
            reason: UNSUPPORTED_OPENAPI_VERSION,
            declaredVersion: declaredOpenApi ?? null,
            // Reported only when present, and it is the whole actionable payload
            // for the reachable case: `declaredVersion: null` alone would tell
            // the spec's author nothing, while "you sent Swagger 2.0" tells them
            // precisely what to convert.
            ...(declaredSwagger !== undefined && { declaredSwaggerVersion: declaredSwagger }),
            supportedVersions: SUPPORTED_OPENAPI_VERSION_PREFIXES,
            sourceId,
            location,
          });
          return [];
        }

        logger.debug('Parsed OpenAPI document', { version, title: api.info?.title });

        // Resolve the upstream base URL once per spec, so every operation this
        // source emits can carry it in its executor binding.
        const resolution = resolveServerUrl(
          (api as { servers?: OpenApiServer[] }).servers,
          typeof spec === 'string' ? spec : undefined,
          logger,
        );
        const upstreamBaseUrl = options.baseUrl ?? resolution.baseUrl;

        if (!upstreamBaseUrl) {
          // Not fatal: discovery still works and tools/list stays useful. The
          // call path fails with an actionable message instead of a wrong host.
          logger.warn(
            'Could not resolve an upstream base URL for this spec; tools will be listed but ' +
              'calls will fail until one is supplied via the baseUrl option',
            { sourceId, location, reason: resolution.reason },
          );
        } else {
          logger.info('Resolved upstream base URL', { sourceId, upstreamBaseUrl });
        }

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
                upstreamBaseUrl,
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

        // DON'T THROW — return an empty array. The compiler handles missing
        // operations gracefully.
        //
        // THE ARGUMENT, not just the decision (#625). This comment used to state
        // only the rule, which is the shape a future reader "cleans up" because
        // discovery functions ought to throw. Three reasons it must not:
        //
        //   1. `[]` is already this source's established "nothing from me"
        //      signal on non-error paths — an aborted discovery returns `[]`
        //      above, and that is not a special case invented for refusals.
        //   2. The same judgement is already made and documented one case over,
        //      where a missing upstream base URL is explicitly non-fatal so
        //      "discovery still works and tools/list stays useful".
        //   3. `discover()` is reached on a MULTI-SOURCE path. Throwing lets one
        //      bad source take down a server that is serving others, and the
        //      caller has no way to opt out — the throw would happen inside a
        //      function whose whole job is to survey sources.
        //
        // The breadth of the catch above is LOAD-BEARING for the same reason.
        // Narrowing it reintroduces exactly the failure this prevents.
        //
        // This is public contract, not an implementation detail: an unsupported
        // version is refused by yielding zero operations and a logged error, and
        // docs/compatibility.{md,json} now say so. A competent reader previously
        // inferred a throw and wrote `rejects.toThrow()`, which failed — the
        // cheap version of the same mistake.
        //
        // THAT GAP IS NOW CLOSED, and note WHERE it was closed (#628). A version
        // refusal used to arrive here and log 'OpenAPI discovery failed',
        // differing from a genuine fault only in error.message — which
        // compatibility-policy.md forbids parsing. The fix was not made in this
        // catch: the refusal now returns above under its own event, so it never
        // reaches here at all.
        //
        // The consequence is what this catch MEANS. Everything arriving here is
        // now genuinely unexpected, so 'OpenAPI discovery failed' says exactly
        // that and nothing else. Do not route an expected outcome back through
        // it — handle it where it is known, as the version check does.
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
 * The `openapi` field prefixes this source accepts.
 *
 * ONE definition rather than two (#628). `getOpenAPIVersion` tests against
 * these and the refusal log reports them, so the set we accept and the set we
 * TELL a caller about cannot drift apart. Prefixes, not versions: a document
 * declaring exactly "3.0" with no patch segment is rejected, which
 * docs/compatibility.md records as a known sharp edge rather than an intended
 * restriction.
 */
const SUPPORTED_OPENAPI_VERSION_PREFIXES = ['3.0.', '3.1.'] as const;

/**
 * Stable code for the version refusal (#628).
 *
 * The discriminator a caller branches on, so telling a refusal from an internal
 * fault never requires parsing a human-readable message — compatibility-policy.md
 * forbids that, and ADR-011 asks for a closed code precisely so a caller can
 * branch exhaustively.
 */
const UNSUPPORTED_OPENAPI_VERSION = 'unsupported-openapi-version';

/**
 * The version string the document DECLARES, whatever it is.
 *
 * Distinct from `getOpenAPIVersion`, which answers "is it one we accept?".
 * Kept separate because the refusal needs to report what was actually found —
 * the actionable part for whoever wrote the spec is WHICH version we declined,
 * and `getOpenAPIVersion` has thrown that away by the time it returns null.
 */
function declaredOpenApiVersion(api: OpenAPIDocument): string | undefined {
  return 'openapi' in api && typeof api.openapi === 'string' ? api.openapi : undefined;
}

/**
 * The `swagger` field of a Swagger 2.0 document, if this is one.
 *
 * Not part of the OpenAPI 3 types, hence the cast. It is read only to make the
 * refusal actionable: a Swagger 2.0 document is the one unsupported shape that
 * reaches our version check rather than being rejected by the parser, and it
 * carries its version under `swagger` rather than `openapi`.
 */
function declaredSwaggerVersion(api: OpenAPIDocument): string | undefined {
  const doc = api as { swagger?: unknown };
  return typeof doc.swagger === 'string' ? doc.swagger : undefined;
}

/**
 * Get OpenAPI version from document, or null if it is not one we support.
 */
function getOpenAPIVersion(api: OpenAPIDocument): string | null {
  const version = declaredOpenApiVersion(api);
  if (version && SUPPORTED_OPENAPI_VERSION_PREFIXES.some((prefix) => version.startsWith(prefix))) {
    return version;
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
  upstreamBaseUrl: string | undefined,
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

  // CARRY THE DROP REASON FORWARD (#768).
  //
  // Only attached when the input was ACTUALLY dropped: with a schema present the
  // operation is servable and there is nothing to explain. `hints` is the
  // declared source-to-compiler channel and is dropped at freeze-and-hash, so
  // this is a compile-time diagnostic rather than a change to the published IR.
  //
  // NOTE the case this deliberately does NOT cover: parameters partially
  // dropped, where some yielded properties and an unencodable one did not. That
  // operation still compiles, so no warning fires and the missing parameter is
  // silent. It is a real gap and a different one — #768 is about a drop
  // reporting the wrong CAUSE, not about a drop reporting nothing.
  const unencodable = rawInput === undefined ? unencodableParameters(operation) : [];

  // Build hints for compiler
  const hints = {
    httpMethod: method.toUpperCase(),
    pathPattern,
    operationId: operation.operationId,
    tags: operation.tags,
    ...(unencodable.length > 0 && { unencodableParameterMediaTypes: unencodable }),
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
    // Bind the operation to its HTTP shape. `hints` are dropped at
    // freeze-and-hash, so method/path have to live in the executor config to
    // survive into the registry snapshot the dispatcher reads.
    executor: {
      type: 'http',
      config: {
        method: method.toUpperCase(),
        path: pathPattern,
        ...(upstreamBaseUrl !== undefined && { baseUrl: upstreamBaseUrl }),
      },
    },
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
 * The input schema for an operation that takes no arguments.
 *
 * Built fresh per call rather than shared as a module constant: the returned
 * object is embedded in a compiled operation and frozen downstream, so a shared
 * instance would alias every argumentless operation to one object.
 */
function emptyInputSchema(): Record<string, unknown> {
  return { type: 'object', properties: {} };
}

/**
 * The one media type a `content`-form parameter can be SERVED under (#718).
 *
 * OpenAPI 3 lets a parameter carry either `schema` or `content`, and `content`
 * is the documented form for a parameter needing complex serialization — a
 * JSON-valued query parameter is the common case. The spec says that map MUST
 * hold exactly one entry, so this is a support decision, not a preference
 * between candidates.
 *
 * WHY ONLY JSON, rather than "first entry with a schema" as the requestBody
 * path above does. The two are not the same question. A requestBody's media
 * type is carried on the wire in `Content-Type`, so honouring an arbitrary one
 * is coherent. A query parameter's is not: `buildQuery` in
 * `packages/core/src/executor/http-request.ts` serialises an object-valued
 * parameter with `JSON.stringify` and has no other encoder. So for
 * `application/json` the existing executor is already exactly right, and for
 * any other media type we would advertise a tool whose upstream request is
 * malformed — JSON sent where the spec declared XML.
 *
 * Dropping those is therefore the correct outcome, and the point of naming it
 * here is that it now drops for THAT reason rather than by falling into the
 * unreadable branch below by accident.
 */
const SERVABLE_PARAMETER_MEDIA_TYPE = 'application/json';

/**
 * The JSON Schema for a parameter, from either place OpenAPI 3 allows it.
 *
 * Returning `undefined` means "no schema we can serve", which is the input the
 * unreadable branch in `extractInputSchema` acts on.
 */
function parameterSchema(param: OpenAPIParameter): Record<string, unknown> | undefined {
  const direct = param.schema;
  if (direct && typeof direct === 'object') {
    return direct as Record<string, unknown>;
  }

  const content = param.content;
  if (!content || typeof content !== 'object') {
    return undefined;
  }

  const media = content[SERVABLE_PARAMETER_MEDIA_TYPE];
  if (!media || typeof media !== 'object') {
    return undefined;
  }

  const schema = media.schema;
  return schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : undefined;
}

/**
 * The media types a `content`-form parameter declares that we cannot encode.
 *
 * THE DROP SITE IS WHERE THE CAUSE IS KNOWN, AND IT USED TO THROW IT AWAY
 * (#768). `parameterSchema` returns `undefined` for three distinct reasons — an
 * unresolved `$ref`, a missing name, or a media type we have no encoder for —
 * and a downstream pass observing only the ABSENCE reported the wrong one:
 * `MISSING_INPUT_SCHEMA`, on a spec that plainly contains a schema. True in
 * effect, false in fact, and actively misleading to someone debugging a spec.
 *
 * This names the third cause so it can be carried forward. It returns the
 * DECLARED media types rather than a boolean, because the actionable part for
 * whoever wrote the spec is WHICH type we could not encode.
 *
 * Empty means "not this cause" — either the parameter is servable, or it failed
 * for one of the other two reasons, which this function deliberately does not
 * speak for.
 */
function unencodableParameterMediaTypes(param: OpenAPIParameter): readonly string[] {
  // A direct `schema` is servable, so nothing was dropped for a media type.
  if (param.schema && typeof param.schema === 'object') return [];

  const content = param.content;
  if (!content || typeof content !== 'object') return [];

  const declared = Object.keys(content);
  if (declared.length === 0) return [];

  // The servable type IS offered. If the parameter still yielded nothing, the
  // cause is a missing or unreadable schema under it — not the media type — and
  // claiming otherwise would replace one wrong cause with another.
  if (Object.prototype.hasOwnProperty.call(content, SERVABLE_PARAMETER_MEDIA_TYPE)) return [];

  return declared;
}

/**
 * Every parameter dropped because its media type cannot be encoded.
 *
 * Walks the parameters a second time rather than restructuring
 * `extractInputSchema`'s return type: that function has three early exits and
 * one caller, and threading a second channel through it would touch far more
 * than the defect needs. The walk is over an array that is already in memory.
 */
function unencodableParameters(
  operation: OpenAPIOperation,
): readonly { readonly parameter: string; readonly mediaTypes: readonly string[] }[] {
  const parameters = operation.parameters;
  if (!parameters || !Array.isArray(parameters)) return [];

  const dropped: { parameter: string; mediaTypes: readonly string[] }[] = [];
  for (const param of parameters) {
    if (!param || typeof param !== 'object' || '$ref' in param) continue;
    const mediaTypes = unencodableParameterMediaTypes(param);
    if (mediaTypes.length > 0) {
      dropped.push({ parameter: param.name ?? '(unnamed)', mediaTypes });
    }
  }
  return dropped;
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
    // An operation declaring NO parameters and NO request body takes no
    // arguments. That is a legitimate — and extremely common — tool shape
    // ("list all the things"), not an incomplete one, and MCP requires
    // `inputSchema` on every tool. So the honest encoding is the empty object
    // schema.
    //
    // Returning `undefined` unconditionally here modelled "takes no arguments"
    // as "has no schema", and `validate-invariants` (pass 8) treats a missing
    // `input` as a missing REQUIRED FIELD and drops the operation from the
    // registry outright (#717). The invariant is correct; this was the wrong
    // input to it.
    //
    // Deliberately conditioned on there being no request body either. A
    // requestBody that yielded no usable schema above is a DIFFERENT condition
    // — something WAS declared and could not be read — and presenting such an
    // operation as argumentless would be worse than dropping it.
    return requestBody === undefined ? emptyInputSchema() : undefined;
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
    const paramSchema = parameterSchema(param);

    if (name && paramSchema) {
      properties[name] = paramSchema;
      if (param.required === true) {
        required.push(name);
      }
    }
  }

  // Parameters WERE declared, but none yielded a property — every entry was an
  // unresolved `$ref`, lacked a name, or carried no schema we can serve. Unlike
  // the no-parameters case above this is NOT "takes no arguments": something was
  // declared and could not be read, so presenting the tool as argumentless would
  // invite a caller to invoke it with nothing when it in fact needs input. That
  // reasoning is #717's and it is unchanged.
  //
  // #718 NARROWED THIS BRANCH RATHER THAN WEAKENING IT. The condition used to be
  // `!param.schema`, which is BROADER than the rationale above: a `content`-form
  // parameter is standard OpenAPI 3 and perfectly readable, just located
  // elsewhere, so "lacks `schema`" and "could not be read" came apart for it and
  // valid specs were silently dropped. `parameterSchema` closes that gap, and
  // everything still reaching here is genuinely unservable — an unresolved
  // `$ref`, a missing name, or a media type we cannot encode.
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
