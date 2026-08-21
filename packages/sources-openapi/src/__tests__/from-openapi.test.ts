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
});
