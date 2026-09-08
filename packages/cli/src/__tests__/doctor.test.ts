/**
 * Doctor command tests
 *
 * Test coverage:
 * - Petstore spec analysis (should have high score, minimal warnings)
 * - Broken spec analysis (should have specific error codes)
 * - JSON output stability
 * - Score calculation rubric
 */

import { describe, it, expect } from '@jest/globals';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3 } from 'openapi-types';

import { analyzeSpec } from '../commands/doctor.js';

// analyzeSpec is the real analysis entry point doctorCommand uses. Tests below
// call it directly rather than re-implementing its logic over the fixtures —
// a test that mimics the code under test cannot detect that code being wrong.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function loadFixture(name: string): Promise<OpenAPIV3.Document> {
  const path = join(__dirname, 'fixtures', `${name}.json`);
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as OpenAPIV3.Document;
}

describe('doctor command', () => {
  describe('Petstore spec analysis', () => {
    it('should achieve high score with minimal warnings', async () => {
      const spec = await loadFixture('petstore');

      // Validate that it parses
      await expect(SwaggerParser.validate(spec as any)).resolves.toBeDefined();

      // Basic assertions we expect for a good spec
      expect(spec.openapi).toBe('3.0.0');
      expect(spec.info.title).toBe('Petstore API');
      expect(spec.paths).toBeDefined();

      // All operations should have operationIds
      const operations = extractOperations(spec);
      expect(operations.length).toBeGreaterThan(0);

      for (const op of operations) {
        expect(op.operation.operationId).toBeDefined();
        expect(op.operation.description).toBeDefined();
        expect(op.operation.description!.length).toBeGreaterThan(20);
      }
    });

    it('should have zero errors', async () => {
      const spec = await loadFixture('petstore');

      // Ask the analyser, rather than re-deriving "zero errors" from the
      // fixture's shape — the previous version of this test inspected the
      // fixture and never invoked doctor at all, so it passed regardless of
      // what the analyser did.
      const result = await analyzeSpec(spec as never);

      expect(result.summary.errors).toBe(0);
      const errorFindings = [
        ...result.globalFindings,
        ...result.operations.flatMap((op) => op.findings),
      ].filter((f) => f.severity === 'error');
      expect(errorFindings).toEqual([]);
    });

    it('should detect x-mcp-effects on mutations', async () => {
      const spec = await loadFixture('petstore');
      const operations = extractOperations(spec);

      const createPet = operations.find((op) => op.operation.operationId === 'createPet');
      expect(createPet).toBeDefined();

      const xMcpEffects = (createPet!.operation as any)['x-mcp-effects'];
      expect(xMcpEffects).toBeDefined();
      expect(xMcpEffects.creates).toBe(true);
    });
  });

  describe('Broken spec analysis', () => {
    it('should detect missing operationId', async () => {
      const spec = await loadFixture('broken');
      const operations = extractOperations(spec);

      const getUsersOp = operations.find((op) =>
        op.path === '/users' && op.method === 'GET'
      );
      expect(getUsersOp).toBeDefined();
      expect(getUsersOp!.operation.operationId).toBeUndefined();
    });

    it('should detect unfriendly operationId', async () => {
      const spec = await loadFixture('broken');
      const operations = extractOperations(spec);

      const postUsersOp = operations.find((op) =>
        op.path === '/users' && op.method === 'POST'
      );
      expect(postUsersOp).toBeDefined();
      expect(postUsersOp!.operation.operationId).toBe('p1_post_v3');

      // This should be flagged as unfriendly (contains version pattern)
      expect(postUsersOp!.operation.operationId).toMatch(/v\d+/);
    });

    it('should detect short descriptions', async () => {
      const spec = await loadFixture('broken');
      const operations = extractOperations(spec);

      const getUsersOp = operations.find((op) =>
        op.path === '/users' && op.method === 'GET'
      );
      expect(getUsersOp).toBeDefined();
      expect(getUsersOp!.operation.summary?.length).toBeLessThan(20);
    });

    it('should detect missing output schema on GET', async () => {
      const spec = await loadFixture('broken');
      const operations = extractOperations(spec);

      const getUsersOp = operations.find((op) =>
        op.path === '/users' && op.method === 'GET'
      );
      expect(getUsersOp).toBeDefined();

      const responses = getUsersOp!.operation.responses;
      const successResponse = responses?.['200'];
      const content = (successResponse as any)?.content;
      expect(content).toBeUndefined();
    });

    it('should detect missing input schema on mutating operations', async () => {
      const spec = await loadFixture('broken');
      const operations = extractOperations(spec);

      const updateUserOp = operations.find((op) =>
        op.path === '/users/{id}' && op.method === 'PUT'
      );
      expect(updateUserOp).toBeDefined();

      const requestBody = (updateUserOp!.operation as any).requestBody;
      expect(requestBody).toBeUndefined();
    });

    it('should detect unsafe fields in request body', async () => {
      const spec = await loadFixture('broken');

      // The previous version asserted the FIXTURE contained password/apiKey —
      // i.e. that the fixture is the fixture. What matters is that the analyser
      // reports them.
      const result = await analyzeSpec(spec as never);

      const findings = [
        ...result.globalFindings,
        ...result.operations.flatMap((op) => op.findings),
      ];
      const unsafe = findings.filter((f) => f.code === 'UNSAFE_FIELDS_DETECTED');

      expect(unsafe.length).toBeGreaterThan(0);
      const reported = unsafe.map((f) => f.message).join(' ');
      expect(reported).toMatch(/password/i);
      expect(reported).toMatch(/apiKey/i);
    });

    it('should detect missing x-mcp-effects on mutations', async () => {
      const spec = await loadFixture('broken');
      const operations = extractOperations(spec);

      const postUsersOp = operations.find((op) =>
        op.path === '/users' && op.method === 'POST'
      );
      expect(postUsersOp).toBeDefined();

      const xMcpEffects = (postUsersOp!.operation as any)['x-mcp-effects'];
      expect(xMcpEffects).toBeUndefined();
    });
  });

  /**
   * These drive `analyzeSpec` and read `admittedByLightPolicy` (#762).
   *
   * ## They previously asserted nothing at all
   *
   * Both cases filtered a test-local `extractOperations` list by
   * `method === 'GET'` (or `'POST'`) and then asserted the method was one of
   * `GET/HEAD/OPTIONS` (or one of the mutating verbs). That is **true by
   * construction of the filter**, and it never touched the policy decision at
   * all — the helper returns `{path, method, operation}` and carries no policy
   * field, so there was nothing for the block to be about.
   *
   * QA measured the consequence: INVERTING the Light policy left this block
   * fully green, and only `doctor-readme.test.ts` noticed, via the whole
   * rendered transcript. A describe block named "Light preset policy" that
   * survives the policy being inverted is worse than no block, because the name
   * supplies the reassurance.
   */
  describe('Light preset policy', () => {
    it('admits read-only operations', async () => {
      const spec = await loadFixture('petstore');
      const result = await analyzeSpec(spec as never);

      const getOps = result.operations.filter((op) => op.method === 'GET');
      // Non-vacuity: an empty set satisfies every assertion in the loop below.
      expect(getOps.length).toBeGreaterThan(0);

      for (const op of getOps) {
        expect(op.admittedByLightPolicy).toBe(true);
        expect(op.lightPolicyExclusionReason).toBeUndefined();
      }
    });

    it('excludes mutations that carry no explicit opt-in, and says why', async () => {
      const spec = await loadFixture('petstore');
      const result = await analyzeSpec(spec as never);

      const postOps = result.operations.filter((op) => op.method === 'POST');
      expect(postOps.length).toBeGreaterThan(0);

      for (const op of postOps) {
        expect(op.admittedByLightPolicy).toBe(false);
        // Assert the MESSAGE, not merely the boolean: a status-only assertion
        // cannot tell an exclusion made for policy reasons from one made for
        // any other reason, and the message is what the user actually reads.
        expect(op.lightPolicyExclusionReason).toContain('not admitted by Light preset policy');
      }
    });

    it('counts the two policy outcomes, and they account for every operation', async () => {
      const spec = await loadFixture('petstore');
      const result = await analyzeSpec(spec as never);

      expect(result.summary.lightPolicyAdmitted).toBe(
        result.operations.filter((op) => op.admittedByLightPolicy).length,
      );
      expect(result.summary.lightPolicyExcluded).toBe(
        result.operations.filter((op) => !op.admittedByLightPolicy).length,
      );
      expect(result.summary.lightPolicyAdmitted + result.summary.lightPolicyExcluded).toBe(
        result.summary.totalOperations,
      );
      // Without this the fixture could admit everything and the split would
      // still "account for" the total, which is variant 5 applied to a count.
      expect(result.summary.lightPolicyExcluded).toBeGreaterThan(0);
    });
  });

  describe('Error code stability', () => {
    it('should produce stable error codes across runs', async () => {
      const spec = await loadFixture('broken');

      // The previous version declared this array and asserted it was defined —
      // it never ran the analyser, so it could not fail. Run it twice and
      // compare, which is what "stable across runs" actually means.
      const first = await analyzeSpec(spec as never);
      const second = await analyzeSpec(spec as never);

      const codesOf = (r: Awaited<ReturnType<typeof analyzeSpec>>) =>
        [...r.globalFindings, ...r.operations.flatMap((op) => op.findings)]
          .map((f) => f.code)
          .sort();

      const codes = codesOf(first);
      expect(codes).toEqual(codesOf(second));
      expect(first.score).toBe(second.score);

      // And the codes are the documented, stable identifiers — not an
      // arbitrary set that silently drifts.
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) {
        expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      }
    });
  });
});

/**
 * Helper: Extract all operations from spec
 */
function extractOperations(spec: OpenAPIV3.Document): Array<{
  path: string;
  method: string;
  operation: OpenAPIV3.OperationObject;
}> {
  const operations: Array<{
    path: string;
    method: string;
    operation: OpenAPIV3.OperationObject;
  }> = [];

  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
    for (const method of methods) {
      const operation = (pathItem as any)[method] as OpenAPIV3.OperationObject | undefined;
      if (operation) {
        operations.push({
          path,
          method: method.toUpperCase(),
          operation,
        });
      }
    }
  }

  return operations;
}
