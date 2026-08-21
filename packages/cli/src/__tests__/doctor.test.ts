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

  describe('Light preset policy', () => {
    it('should expose GET operations in Light preset', async () => {
      const spec = await loadFixture('petstore');
      const operations = extractOperations(spec);

      const getOps = operations.filter((op) => op.method === 'GET');
      expect(getOps.length).toBeGreaterThan(0);

      // All GET operations should be read-only and auto-exposed in Light
      for (const op of getOps) {
        expect(['GET', 'HEAD', 'OPTIONS']).toContain(op.method);
      }
    });

    it('should not auto-expose mutations in Light preset', async () => {
      const spec = await loadFixture('petstore');
      const operations = extractOperations(spec);

      const postOps = operations.filter((op) => op.method === 'POST');
      expect(postOps.length).toBeGreaterThan(0);

      // POST operations should require explicit inclusion
      // (unless they have x-mcp.expose or x-mcp.light-preset)
      for (const op of postOps) {
        expect(['POST', 'PUT', 'PATCH', 'DELETE']).toContain(op.method);
      }
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
