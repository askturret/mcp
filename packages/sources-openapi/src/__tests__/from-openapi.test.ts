/**
 * fromOpenApi() tests
 *
 * Test coverage:
 * - Petstore 3.0 and 3.1 fixtures
 * - Malformed spec handling
 * - $ref resolution
 * - x-mcp extension extraction
 * - Effect inference from HTTP methods
 * - Name generation (operationId + fallback)
 * - Provenance tracking
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiscoveryContext } from '@askturret/mcp-core';
import { fromOpenApi } from '../from-openapi.js';

/**
 * Create a minimal discovery context for testing
 */
function createTestContext(): DiscoveryContext {
  return {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    abortSignal: new AbortController().signal,
  };
}

/**
 * A discovery context whose logger RECORDS its error events (#628).
 *
 * The tests above assert only what `discover` RETURNED, and return value is
 * exactly what a refusal and an internal fault have in common — both yield `[]`.
 * Telling them apart is the whole point of #628, so asserting it needs a logger
 * that keeps what it was told.
 */
function createRecordingContext(): {
  context: DiscoveryContext;
  errors: { message: string; meta?: Record<string, unknown> }[];
} {
  const errors: { message: string; meta?: Record<string, unknown> }[] = [];
  return {
    context: {
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message: string, meta?: Record<string, unknown>) => {
          errors.push({ message, meta });
        },
      },
      abortSignal: new AbortController().signal,
    },
    errors,
  };
}

describe('fromOpenApi()', () => {
  describe('OpenAPI 3.0 support', () => {
    it('should discover operations from Petstore 3.0', async () => {
      const spec = {
        openapi: '3.0.3',
        info: {
          title: 'Petstore',
          version: '1.0.0',
        },
        paths: {
          '/pets': {
            get: {
              operationId: 'listPets',
              summary: 'List all pets',
              description: 'Returns a list of pets',
              responses: {
                '200': {
                  description: 'Success',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer' },
                            name: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            post: {
              operationId: 'createPet',
              summary: 'Create a pet',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                      },
                      required: ['name'],
                    },
                  },
                },
              },
              responses: {
                '201': {
                  description: 'Created',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          id: { type: 'integer' },
                          name: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };

      const source = fromOpenApi(spec, { location: 'petstore-3.0.yaml' });
      const context = createTestContext();
      const operations = await source.discover(context);

      expect(operations).toHaveLength(2);

      // Verify GET /pets
      const listPets = operations.find(op => op.candidateId === 'listPets');
      expect(listPets).toBeDefined();
      expect(listPets?.name).toBe('listPets');
      expect(listPets?.description).toContain('Returns a list of pets');
      expect(listPets?.effects?.readOnly).toBe(true);
      expect(listPets?.effects?.idempotent).toBe(true);
      expect(listPets?.effects?.retryable).toBe(true);
      expect(listPets?.source.kind).toBe('openapi');

      // Verify POST /pets
      const createPet = operations.find(op => op.candidateId === 'createPet');
      expect(createPet).toBeDefined();
      expect(createPet?.name).toBe('createPet');
      expect(createPet?.effects?.readOnly).toBe(false);
      expect(createPet?.effects?.idempotent).toBe(false);
      expect(createPet?.effects?.idempotencyKeyRequired).toBe(true);
    });
  });

  describe('OpenAPI 3.1 support', () => {
    it('should discover operations from OpenAPI 3.1', async () => {
      const spec = {
        openapi: '3.1.0',
        info: {
          title: 'Modern API',
          version: '2.0.0',
        },
        paths: {
          '/users/{id}': {
            get: {
              operationId: 'getUser',
              parameters: [
                {
                  name: 'id',
                  in: 'path',
                  required: true,
                  schema: { type: 'string' },
                },
              ],
              responses: {
                '200': {
                  description: 'User found',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          email: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const context = createTestContext();
      const operations = await source.discover(context);

      expect(operations).toHaveLength(1);
      expect(operations[0].candidateId).toBe('getUser');
      expect(operations[0].name).toBe('getUser');
    });
  });

  describe('HTTP method effect inference', () => {
    it('should infer GET as read-only, idempotent, retryable', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/data': {
            get: {
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      expect(operations[0].effects).toEqual({
        readOnly: true,
        idempotent: true,
        retryable: true,
        idempotencyKeyRequired: false,
        classifications: [],
      });
    });

    it('should infer PUT as idempotent but not retryable', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/resource': {
            put: {
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      expect(operations[0].effects).toEqual({
        readOnly: false,
        idempotent: true,
        retryable: false,
        idempotencyKeyRequired: false,
        classifications: [],
      });
    });

    it('should infer POST as non-idempotent with key required', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/items': {
            post: {
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      expect(operations[0].effects).toEqual({
        readOnly: false,
        idempotent: false,
        retryable: false,
        idempotencyKeyRequired: true,
        classifications: [],
      });
    });

    it('should infer DELETE as idempotent but not retryable', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/resource': {
            delete: {
              responses: { '204': { description: 'Deleted' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      expect(operations[0].effects).toEqual({
        readOnly: false,
        idempotent: true,
        retryable: false,
        idempotencyKeyRequired: false,
        classifications: [],
      });
    });
  });

  describe('x-mcp extension support', () => {
    it('should extract x-mcp effects', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/safe-action': {
            post: {
              'x-mcp': {
                effects: {
                  readOnly: false,
                  idempotent: true,
                  retryable: true,
                  idempotencyKeyRequired: false,
                },
              },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      // x-mcp effects override HTTP method inference
      expect(operations[0].effects?.idempotent).toBe(true);
      expect(operations[0].effects?.retryable).toBe(true);
      expect(operations[0].effects?.idempotencyKeyRequired).toBe(false);
    });

    it('should extract x-mcp annotations', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/annotated': {
            get: {
              'x-mcp': {
                annotations: {
                  rateLimit: { requests: 100, window: '1m' },
                  cache: { ttl: 300 },
                },
              },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      expect(operations[0].annotations).toEqual({
        rateLimit: { requests: 100, window: '1m' },
        cache: { ttl: 300 },
      });
    });
  });

  describe('Name generation', () => {
    it('should use operationId when present and agent-friendly', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'listUsers',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      expect(operations[0].name).toBe('listUsers');
      expect(operations[0].candidateId).toBe('listUsers');
    });

    it('should generate name from path when operationId missing', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users/{id}/posts': {
            get: {
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      // Should generate: getUsersPosts (verb + capitalized path segments)
      expect(operations[0].name).toBe('getUsersPosts');
      expect(operations[0].candidateId).toBe('get-users-id-posts');
    });
  });

  describe('Provenance tracking', () => {
    it('should build provenance chain for all fields', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'testOp',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec, { location: 'test.yaml' });
      const operations = await source.discover(createTestContext());

      const provenance = operations[0].provenance;
      expect(provenance).toBeDefined();
      expect(provenance).toHaveLength(3); // name, description, effects

      // Check name provenance
      const nameProvenance = provenance?.find(p => p.field === 'name');
      expect(nameProvenance?.kind).toBe('openapi');
      expect(nameProvenance?.location).toContain('test.yaml#/paths//test/get');

      // Check effects provenance (should be inference)
      const effectsProvenance = provenance?.find(p => p.field === 'effects');
      expect(effectsProvenance?.kind).toBe('inference');
    });

    it('should mark x-mcp effects as overlay provenance', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/test': {
            get: {
              'x-mcp': {
                effects: { readOnly: true },
              },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec, { location: 'test.yaml' });
      const operations = await source.discover(createTestContext());

      const effectsProvenance = operations[0].provenance?.find(p => p.field === 'effects');
      expect(effectsProvenance?.kind).toBe('overlay'); // x-mcp is overlay
    });
  });

  describe('Schema extraction', () => {
    it('should extract input schema from requestBody', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/items': {
            post: {
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        price: { type: 'number' },
                      },
                      required: ['name'],
                    },
                  },
                },
              },
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      expect(operations[0].rawInput).toBeDefined();
      expect(operations[0].rawInput).toHaveProperty('type', 'object');
      expect(operations[0].rawInput).toHaveProperty('properties');
    });

    it('should extract output schema from 200 response', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/data': {
            get: {
              responses: {
                '200': {
                  description: 'Success',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          value: { type: 'number' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      expect(operations[0].rawOutput).toBeDefined();
      expect(operations[0].rawOutput).toHaveProperty('type', 'object');
    });
  });

  describe('Malformed spec handling', () => {
    it('should handle missing paths gracefully', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Empty', version: '1.0.0' },
        // No paths
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      expect(operations).toHaveLength(0);
    });

    it('should handle invalid OpenAPI version', async () => {
      const spec = {
        openapi: '2.0.0', // Swagger 2.0, not OpenAPI 3.x
        info: { title: 'Old', version: '1.0.0' },
        paths: {},
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      // Should return empty array, not throw
      expect(operations).toHaveLength(0);
    });

    it('should skip operations without valid responses', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/broken': {
            get: {
              // No responses - invalid
            },
          },
          '/valid': {
            get: {
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      // Should discover only the valid operation
      expect(operations).toHaveLength(1);
      expect(operations[0].hints?.pathPattern).toBe('/valid');
    });
  });

  describe('Hints preservation', () => {
    it('should preserve HTTP method, path pattern, and tags as hints', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              tags: ['users', 'public'],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const source = fromOpenApi(spec);
      const operations = await source.discover(createTestContext());

      expect(operations[0].hints).toMatchObject({
        httpMethod: 'GET',
        pathPattern: '/users',
        tags: ['users', 'public'],
      });
    });
  });

  describe('Abort signal handling', () => {
    it('should respect abort signal during discovery', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/test': {
            get: {
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const controller = new AbortController();
      const context: DiscoveryContext = {
        ...createTestContext(),
        abortSignal: controller.signal,
      };

      // Abort immediately
      controller.abort();

      const source = fromOpenApi(spec);
      const operations = await source.discover(context);

      // Should return empty array when aborted
      expect(operations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // A VERSION REFUSAL IS AN EXPECTED OUTCOME AND MUST NOT WEAR AN INTERNAL
  // ERROR'S CLOTHES (#628).
  //
  // Both outcomes return `[]` and both log at ERROR, which is the published
  // contract and is not what changed. What changed is that they no longer share
  // an EVENT: a refusal logs 'OpenAPI version not supported' with a stable
  // `reason` code, an internal fault logs 'OpenAPI discovery failed'. Before
  // this, separating them required parsing `error.message` — which
  // compatibility-policy.md forbids.
  //
  // The conflation was TWO-WAY, so both directions are asserted below. A test
  // for the refusal alone would still pass if the failure path were widened to
  // swallow it again.
  // -------------------------------------------------------------------------
  describe('version refusal is a typed outcome, not an internal error (#628)', () => {
    // THE INPUT HERE IS `swagger: "2.0"`, AND THE CHOICE IS LOAD-BEARING.
    //
    // Measured while writing these tests: `SwaggerParser.dereference` rejects
    // `openapi: "2.0.0"` itself, throwing before our version check is reached —
    // so the older 'should handle invalid OpenAPI version' case above, and the
    // contract row probe below, both exercise the PARSER's rejection and never
    // touch the check they appear to be about. They pass, for a reason other
    // than the one their names suggest.
    //
    // Also rejected inside the parser: a bare `"3.0"` or `"3.1"`, `"3.2.0"`,
    // `"4.0.0"`, and a document with no `openapi` field.
    //
    // A genuine Swagger 2.0 document is the case that survives the parser —
    // swagger-parser supports Swagger 2.0 and returns it — and is therefore the
    // ONLY input that reaches our version check to be refused there. Using
    // anything else here would make these tests green without exercising the
    // code path #628 is about.
    const unsupportedSpec = {
      swagger: '2.0',
      info: { title: 'Old', version: '1.0.0' },
      paths: { '/probe': { get: { responses: { '200': { description: 'OK' } } } } },
    };

    it('logs its own event with a stable reason code', async () => {
      const { context, errors } = createRecordingContext();

      const source = fromOpenApi(unsupportedSpec, { location: 'old.yaml' });
      const operations = await source.discover(context);

      expect(operations).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('OpenAPI version not supported');
      expect(errors[0].meta).toMatchObject({
        reason: 'unsupported-openapi-version',
        // No `openapi` field on a Swagger 2.0 document, so the actionable value
        // is the `swagger` one. Asserting both pins that the refusal reports
        // what it actually found rather than a bare null.
        declaredVersion: null,
        declaredSwaggerVersion: '2.0',
        location: 'old.yaml',
      });
    });

    it('never reaches the internal-failure event', async () => {
      const { context, errors } = createRecordingContext();

      await fromOpenApi(unsupportedSpec).discover(context);

      // The assertion that goes RED if the refusal is routed back through the
      // catch — which is precisely what reverting the fix does.
      expect(errors.map((e) => e.message)).not.toContain('OpenAPI discovery failed');
    });

    it('leaves a genuine internal fault on the failure event, so the two are distinguishable', async () => {
      const { context, errors } = createRecordingContext();

      // A path the parser cannot read at all: unexpected, and therefore the one
      // case that SHOULD reach the catch.
      const source = fromOpenApi('./definitely-not-a-real-spec-628.yaml');
      const operations = await source.discover(context);

      expect(operations).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('OpenAPI discovery failed');
      expect(errors.map((e) => e.message)).not.toContain('OpenAPI version not supported');
    });
  });
});

// ---------------------------------------------------------------------------
// THE CONTRACT'S OPENAPI ROWS, CHECKED AGAINST THE IMPLEMENTATION (#618)
//
// docs/compatibility.json publishes which OpenAPI versions are supported. Those
// rows have no manifest field to point at — acceptance is a literal inside a
// conditional in from-openapi.ts — so they carry `verifiedBy` naming THIS file
// instead of a `source`.
//
// check-compatibility-contract.mjs deliberately does NOT read from-openapi.ts to
// extract those literals: matching literals out of source is a pattern matcher
// standing in for a parser, and it would keep passing after someone rewrote the
// predicate as a regex or a Set. So the semantic check lives here, where the
// real code can simply be imported and RUN.
//
// This is what makes the row's status falsifiable: flip "2.0 (Swagger)" to
// supported in the contract and this test fails, because the implementation
// rejects it.
// ---------------------------------------------------------------------------
describe('compatibility contract: OpenAPI rows match what fromOpenApi accepts (#618)', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const contract = JSON.parse(
    readFileSync(join(repoRoot, 'docs', 'compatibility.json'), 'utf-8'),
  ) as { sources: { kind: string; entries: { version: string; status: string }[] }[] };

  const rows = contract.sources.find((s) => s.kind === 'openapi')?.entries ?? [];

  it('finds the contract rows it is meant to be checking', () => {
    // Guards the guard: an empty list would make every case below vacuous.
    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(rows.map((r) => [r.version, r.status] as const))(
    'contract row %s (%s) agrees with the implementation',
    async (version, status) => {
      // "3.0.x" -> "3.0.0", "2.0 (Swagger)" -> "2.0". Human notation to a
      // concrete version the parser can actually be handed.
      const token = /\d+(?:\.[0-9x]+)*/.exec(version)?.[0] ?? version;
      const concrete = token.replace(/x/g, '0');

      const spec = {
        openapi: concrete,
        info: { title: 'contract-probe', version: '1.0.0' },
        paths: { '/probe': { get: { responses: { '200': { description: 'OK' } } } } },
      };
      const source = fromOpenApi(spec, { location: `contract-${concrete}.yaml` });
      const operations = await source.discover(createTestContext());

      // NOTE how refusal actually surfaces: by yielding NO OPERATIONS, not by
      // rejecting. The spec above carries exactly one operation, which is what
      // makes the two outcomes distinguishable here.
      //
      // Since #628 an unsupported version returns [] from the version check
      // itself, under its own log event, rather than being thrown and caught.
      // What this test observes is unchanged — zero operations either way — so
      // it needed no edit. No source line is cited any more: the number this
      // comment used to carry had drifted by nine lines.
      if (status === 'supported') {
        expect(operations.length).toBeGreaterThan(0);
      } else {
        // The contract says this version is not supported. The implementation
        // must actually refuse it, or the contract claims a restriction that
        // does not exist.
        expect(operations).toHaveLength(0);
      }
    },
  );
});
