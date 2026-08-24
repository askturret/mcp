// SPDX-License-Identifier: Apache-2.0
/**
 * Doctor command - Offline API readiness analysis
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';
import { resolve } from 'path';
import { describePreset, omitUndefined } from '@askturret/mcp-core';
import type {
  Finding,
  OperationAnalysis,
  AnalysisResult,
} from './doctor-types.js';
import { formatHumanReadable, formatJson } from './doctor-output.js';

/**
 * Presets that expand to configuration today.
 *
 * `PresetName` also admits 'light' and 'regulated', but neither is a
 * composition yet — Light is hardcoded inside the Express adapter, and
 * Regulated ships in Epic #3. Typing this narrowly means `--preset light`
 * cannot silently produce a Production expansion, and widening it later is a
 * one-word change at the point the other two become real.
 */
type ExpandablePreset = 'production';

type OpenAPIDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;
type OpenAPIOperation = OpenAPIV3.OperationObject | OpenAPIV3_1.OperationObject;
type OpenAPISchema = OpenAPIV3.SchemaObject | OpenAPIV3_1.SchemaObject;

/**
 * Doctor command entry point
 */
export async function doctorCommand(args: string[]): Promise<void> {
  const flags = parseArgs(args);

  if (!flags.input) {
    console.error('Error: Missing required argument');
    console.error('Usage: npx @askturret/mcp doctor <path-to-spec>');
    console.error('       npx @askturret/mcp doctor --url <endpoint>');
    process.exit(1);
  }

  try {
    const spec = await loadSpec(flags.input, flags.url);
    const analysis = await analyzeSpec(spec);

    // ADR-007: the expansion is attached to the result rather than printed
    // separately, so `--json` carries it for free and an operator can pipe the
    // whole thing into whatever reads their config.
    const result =
      flags.preset === undefined
        ? analysis
        : { ...analysis, preset: describePreset(flags.preset) };

    if (flags.json) {
      console.log(formatJson(result));
    } else {
      console.log(formatHumanReadable(result));
    }

    // Exit with non-zero if there are errors
    process.exit(result.summary.errors > 0 ? 1 : 0);
  } catch (err) {
    console.error('Analysis failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/**
 * Parse command-line arguments
 */
function parseArgs(args: string[]): {
  input?: string;
  url: boolean;
  json: boolean;
  preset?: ExpandablePreset;
} {
  const flags: {
    input?: string;
    url: boolean;
    json: boolean;
    preset?: ExpandablePreset;
  } = {
    url: false,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--url') {
      flags.url = true;
      const urlValue = args[++i];
      if (urlValue !== undefined) {
        flags.input = urlValue;
      }
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--preset') {
      // Only 'production' expands today. An unknown value is left unset rather
      // than guessed at, so the caller sees no preset section instead of a
      // confidently wrong one.
      const value = args[++i];
      if (value === 'production') {
        flags.preset = value;
      }
    } else if (!arg.startsWith('--')) {
      flags.input = arg;
    }
  }

  return flags;
}

/**
 * Load OpenAPI spec from file or URL
 */
/**
 * Exported for `diagnostics --spec` (#50), which needs the same loader.
 *
 * Reused rather than reimplemented: a second spec loader would be a second
 * set of parse and validation behaviours, and the bundle's doctor section is
 * only meaningful if it reports what `doctor` itself would report.
 */
export async function loadSpec(
  input: string,
  isUrl: boolean,
): Promise<OpenAPIDocument> {
  if (isUrl) {
    // For URL input, fetch the MCP endpoint and extract OpenAPI spec
    // This is simplified - in production would use the MCP protocol
    const response = await fetch(input);
    if (!response.ok) {
      throw new Error(`Failed to fetch from ${input}: ${response.statusText}`);
    }
    const spec = await response.json();
    return spec as OpenAPIDocument;
  }

  // Load from file path
  const resolvedPath = resolve(process.cwd(), input);
  const parsed = await SwaggerParser.validate(resolvedPath);
  return parsed as OpenAPIDocument;
}

/**
 * Analyze OpenAPI spec for MCP readiness
 */
export async function analyzeSpec(spec: OpenAPIDocument): Promise<AnalysisResult> {
  const globalFindings: Finding[] = [];
  const operations: OperationAnalysis[] = [];

  // Check 1: OpenAPI validity (already done by SwaggerParser.validate)
  // If we got here, the spec is valid

  // Check OpenAPI version
  const openApiVersion = (spec as any).openapi || '3.0.0';
  if (!openApiVersion.startsWith('3.0') && !openApiVersion.startsWith('3.1')) {
    globalFindings.push({
      severity: 'error',
      code: 'OPENAPI_VERSION_UNSUPPORTED',
      message: `Unsupported OpenAPI version: ${openApiVersion}. Only 3.0.x and 3.1.x are supported.`,
    });
  }

  // Iterate through all operations
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
    for (const method of methods) {
      const operation = (pathItem as any)[method] as OpenAPIOperation | undefined;
      if (!operation) continue;

      const opAnalysis = analyzeOperation(
        operation,
        path,
        method.toUpperCase(),
        spec,
      );
      operations.push(opAnalysis);
    }
  }

  // Check for overlapping tools
  const overlaps = findOverlappingTools(operations);
  globalFindings.push(...overlaps);

  // Calculate score
  const score = calculateScore(operations, globalFindings);

  // Build summary
  const summary = {
    totalOperations: operations.length,
    errors: globalFindings.filter((f) => f.severity === 'error').length +
      operations.reduce((sum, op) => sum + op.findings.filter((f) => f.severity === 'error').length, 0),
    warnings: globalFindings.filter((f) => f.severity === 'warning').length +
      operations.reduce((sum, op) => sum + op.findings.filter((f) => f.severity === 'warning').length, 0),
    info: globalFindings.filter((f) => f.severity === 'info').length +
      operations.reduce((sum, op) => sum + op.findings.filter((f) => f.severity === 'info').length, 0),
    lightExposed: operations.filter((op) => op.wouldBeExposedInLight).length,
    lightDropped: operations.filter((op) => !op.wouldBeExposedInLight).length,
  };

  return {
    score,
    operations,
    globalFindings,
    summary,
    spec: {
      title: spec.info?.title,
      version: spec.info?.version,
      openApiVersion,
    },
  };
}

/**
 * Analyze a single operation
 */
function analyzeOperation(
  operation: OpenAPIOperation,
  path: string,
  method: string,
  _spec: OpenAPIDocument,
): OperationAnalysis {
  const findings: Finding[] = [];
  const operationId = operation.operationId;

  // Check 3: Naming - operationId present and agent-friendly
  if (!operationId) {
    findings.push(omitUndefined<Finding>({
      severity: 'error',
      code: 'MISSING_OPERATION_ID',
      message: 'Operation must have an operationId',
      path,
      method,
      operationId: undefined,
    }));
  } else if (!isAgentFriendlyName(operationId)) {
    findings.push(omitUndefined<Finding>({
      severity: 'warning',
      code: 'UNFRIENDLY_OPERATION_ID',
      message: `Operation ID "${operationId}" is not agent-friendly. Consider using camelCase or snake_case descriptive names.`,
      operationId,
      path,
      method,
      context: { suggestion: generateFriendlyName(path, method) },
    }));
  }

  // Check 4: Descriptions - non-empty, longer than N chars
  const MIN_DESCRIPTION_LENGTH = 20;
  if (!operation.description || operation.description.trim().length === 0) {
    findings.push(omitUndefined<Finding>({
      severity: 'warning',
      code: 'MISSING_DESCRIPTION',
      message: 'Operation should have a description',
      operationId,
      path,
      method,
    }));
  } else if (operation.description.trim().length < MIN_DESCRIPTION_LENGTH) {
    findings.push(omitUndefined<Finding>({
      severity: 'info',
      code: 'SHORT_DESCRIPTION',
      message: `Description is very short (${operation.description.length} chars). Consider adding more detail for better agent understanding.`,
      operationId,
      path,
      method,
    }));
  }

  // Check 2: Schema quality
  const hasInputSchema = hasValidInputSchema(operation);
  const hasOutputSchema = hasValidOutputSchema(operation, method);

  if (!hasInputSchema && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    findings.push(omitUndefined<Finding>({
      severity: 'warning',
      code: 'MISSING_INPUT_SCHEMA',
      message: 'Mutating operation should define request body schema',
      operationId,
      path,
      method,
    }));
  }

  if (!hasOutputSchema && method === 'GET') {
    findings.push(omitUndefined<Finding>({
      severity: 'error',
      code: 'MISSING_OUTPUT_SCHEMA',
      message: 'GET operation must have a non-empty output schema',
      operationId,
      path,
      method,
    }));
  }

  // Check 6: Missing effects for mutating operations
  const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const hasEffects = hasEffectClassification(operation);

  if (isMutating && !hasEffects) {
    findings.push(omitUndefined<Finding>({
      severity: 'warning',
      code: 'MISSING_EFFECTS',
      message: 'Mutating operation should have x-mcp-effects classification',
      operationId,
      path,
      method,
      context: {
        suggestion: 'Add x-mcp-effects to operation object with appropriate effect types',
      },
    }));
  }

  // Check 7: Unsafe fields in request body
  const unsafeFields = findUnsafeFields(operation);
  if (unsafeFields.length > 0) {
    findings.push(omitUndefined<Finding>({
      severity: 'warning',
      code: 'UNSAFE_FIELDS_DETECTED',
      message: `Request body contains potentially sensitive fields: ${unsafeFields.join(', ')}. Consider adding redaction hints.`,
      operationId,
      path,
      method,
      context: { unsafeFields },
    }));
  }

  // Check 8: Light preset exposure policy
  const { exposed, reason } = wouldBeExposedInLight(operation, method);

  return {
    ...(operationId !== undefined && { operationId }),
    path,
    method,
    findings,
    wouldBeExposedInLight: exposed,
    ...(reason !== undefined && { wouldBeDroppedReason: reason }),
  };
}

/**
 * Check if operation ID is agent-friendly
 */
function isAgentFriendlyName(operationId: string): boolean {
  // Avoid patterns like: p1_get_v3_v4, operation123, etc.
  // Good patterns: getUserById, get_user_by_id, listPets

  // Too short
  if (operationId.length < 5) return false;

  // Contains version-like patterns
  if (/v\d+|_v\d+/.test(operationId)) return false;

  // Just numbers or mostly numbers
  if (/^\d+$/.test(operationId) || /\d{3,}/.test(operationId)) return false;

  // Generic names like "operation1", "endpoint2"
  if (/^(operation|endpoint|api)\d*$/i.test(operationId)) return false;

  return true;
}

/**
 * Generate a friendly operation name suggestion
 */
function generateFriendlyName(path: string, method: string): string {
  // Convert /users/{id} GET -> getUserById
  // Convert /pets POST -> createPet
  const parts = path.split('/').filter(Boolean);
  const resource = parts[0] || 'resource';

  const verbMap: Record<string, string> = {
    GET: parts.some((p) => p.includes('{')) ? 'get' : 'list',
    POST: 'create',
    PUT: 'update',
    PATCH: 'update',
    DELETE: 'delete',
  };

  const verb = verbMap[method] || method.toLowerCase();
  const resourceSingular = resource.endsWith('s') ? resource.slice(0, -1) : resource;

  return `${verb}${resourceSingular.charAt(0).toUpperCase()}${resourceSingular.slice(1)}`;
}

/**
 * Check if operation has valid input schema
 */
function hasValidInputSchema(operation: OpenAPIOperation): boolean {
  const requestBody = (operation as any).requestBody;
  if (!requestBody) return false;

  const content = requestBody.content;
  if (!content) return false;

  // Check for JSON content
  const jsonContent = content['application/json'];
  return jsonContent?.schema != null;
}

/**
 * Check if operation has valid output schema
 */
function hasValidOutputSchema(operation: OpenAPIOperation, method: string): boolean {
  const responses = operation.responses;
  if (!responses) return false;

  // Check for success responses (2xx)
  const successResponse = responses['200'] || responses['201'] || responses['204'];
  if (!successResponse || typeof successResponse !== 'object') return false;

  const content = (successResponse as any).content;
  if (!content) return method === 'DELETE'; // DELETE may have no content

  const jsonContent = content['application/json'];
  if (!jsonContent?.schema) return false;

  // Check that schema is not empty
  const schema = jsonContent.schema;
  // Schema can be either a SchemaObject or a ReferenceObject
  return (
    (schema as OpenAPISchema).type != null ||
    (schema as OpenAPISchema).properties != null ||
    (schema as OpenAPIV3.ReferenceObject).$ref != null
  );
}

/**
 * Check if operation has effect classification
 */
function hasEffectClassification(operation: OpenAPIOperation): boolean {
  const xMcp = (operation as any)['x-mcp-effects'];
  return xMcp != null && typeof xMcp === 'object';
}

/**
 * Find potentially unsafe fields in request body
 */
function findUnsafeFields(operation: OpenAPIOperation): string[] {
  const unsafePatterns = [
    /password/i,
    /secret/i,
    /apikey/i,
    /api[_-]key/i,
    /token/i,
    /ssn/i,
    /social[_-]?security/i,
    /credit[_-]?card/i,
    /cvv/i,
  ];

  const requestBody = (operation as any).requestBody;
  if (!requestBody?.content) return [];

  const jsonContent = requestBody.content['application/json'];
  if (!jsonContent?.schema) return [];

  const schema = jsonContent.schema as OpenAPISchema;
  const unsafeFields: string[] = [];

  function checkProperties(props: Record<string, any> | undefined, prefix = '') {
    if (!props) return;

    for (const [key, value] of Object.entries(props)) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;

      // Check field name
      if (unsafePatterns.some((pattern) => pattern.test(key))) {
        unsafeFields.push(fieldPath);
      }

      // Recurse into nested objects
      if (value && typeof value === 'object' && value.properties) {
        checkProperties(value.properties, fieldPath);
      }
    }
  }

  checkProperties(schema.properties);
  return unsafeFields;
}

/**
 * Determine if operation would be exposed in Light preset
 */
function wouldBeExposedInLight(
  operation: OpenAPIOperation,
  method: string,
): { exposed: boolean; reason?: string } {
  // Light preset: read-only auto-exposed, mutations require explicit inclusion

  const isReadOnly = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

  if (isReadOnly) {
    return { exposed: true };
  }

  // Check if explicitly included via x-mcp extension
  const xMcp = (operation as any)['x-mcp'];
  if (xMcp?.expose === true || xMcp?.['light-preset'] === true) {
    return { exposed: true };
  }

  return {
    exposed: false,
    reason: `${method} operation not auto-exposed in Light preset (mutations require explicit inclusion)`,
  };
}

/**
 * Find overlapping tools (near-identical names or schemas)
 */
function findOverlappingTools(operations: OperationAnalysis[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, OperationAnalysis>();

  for (const op of operations) {
    if (!op.operationId) continue;

    // Check for exact duplicates
    if (seen.has(op.operationId)) {
      const duplicate = seen.get(op.operationId)!;
      findings.push(omitUndefined<Finding>({
        severity: 'error',
        code: 'DUPLICATE_OPERATION_ID',
        message: `Duplicate operationId "${op.operationId}" found`,
        operationId: op.operationId,
        context: {
          locations: [
            `${duplicate.method} ${duplicate.path}`,
            `${op.method} ${op.path}`,
          ],
        },
      }));
      continue;
    }

    // Check for similar names (potential confusion)
    for (const [existingId] of seen.entries()) {
      if (areNamesSimilar(op.operationId, existingId)) {
        findings.push(omitUndefined<Finding>({
          severity: 'warning',
          code: 'SIMILAR_OPERATION_NAMES',
          message: `Operation names "${op.operationId}" and "${existingId}" are very similar and may cause confusion`,
          context: {
            operations: [op.operationId, existingId],
          },
        }));
      }
    }

    seen.set(op.operationId, op);
  }

  return findings;
}

/**
 * Check if two operation names are confusingly similar
 */
function areNamesSimilar(name1: string, name2: string): boolean {
  // Convert to lowercase for comparison
  const n1 = name1.toLowerCase();
  const n2 = name2.toLowerCase();

  // Calculate Levenshtein distance
  const distance = levenshteinDistance(n1, n2);
  const maxLen = Math.max(n1.length, n2.length);

  // Consider similar if distance is less than 20% of max length
  return distance < maxLen * 0.2 && distance > 0;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1,
        );
      }
    }
  }

  return matrix[str2.length]![str1.length]!;
}

/**
 * Calculate MCP readiness score.
 *
 * Rubric (documented and stable — mirrored in the package README):
 * - Base score: 50
 * - No errors: +10
 * - All operations have operationId: +10
 * - All operations have descriptions: +10
 * - All schemas present: +5
 * - <3 warnings: +5, ELSE <5 warnings: +3   (exclusive — see below)
 * - Penalties: each error -5, each warning -1
 *
 * ## Two things this rubric is easy to misread (#107)
 *
 * 1. **The warning bonuses are mutually exclusive**, not cumulative: the
 *    `else if` below means 0 warnings earns +5, never +5 and +3. Read as
 *    additive, the ceiling looks like 93.
 * 2. **The reachable range is 0-90, not 0-100.** Every bonus applied to the
 *    base is 50+10+10+10+5+5 = 90. The clamp's upper bound of 100 is a guard,
 *    not an attainable score — a flawless spec scores 90.
 *
 * Both were previously wrong in the README, which documented a 95/100 example
 * and a "100 = perfect spec" band for scores this function cannot return.
 * `__tests__/doctor-readme.test.ts` now pins the README's worked examples to
 * real output so the two cannot drift apart again silently.
 *
 * Missing `operationId` and a missing GET output schema are NOT separate
 * penalties, despite an earlier version of this comment listing them as -5
 * each. They are already `error`-severity findings, so they are charged once
 * via `errorCount * 5` — listing them again described a double deduction the
 * code has never applied.
 */
function calculateScore(
  operations: OperationAnalysis[],
  globalFindings: Finding[],
): number {
  let score = 50; // Base score

  const allFindings = [
    ...globalFindings,
    ...operations.flatMap((op) => op.findings),
  ];

  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;

  // Bonuses
  if (errorCount === 0) {
    score += 10; // No errors
  }

  if (operations.every((op) => op.operationId)) {
    score += 10; // All operations have IDs
  }

  if (operations.every((op) =>
    !op.findings.some((f) => f.code === 'MISSING_DESCRIPTION')
  )) {
    score += 10; // All operations have descriptions
  }

  if (warningCount < 3) {
    score += 5;
  } else if (warningCount < 5) {
    score += 3;
  }

  if (operations.every((op) =>
    !op.findings.some((f) =>
      f.code === 'MISSING_INPUT_SCHEMA' || f.code === 'MISSING_OUTPUT_SCHEMA'
    )
  )) {
    score += 5; // All required schemas present
  }

  // Penalties
  score -= errorCount * 5;
  score -= warningCount * 1;

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}
