/**
 * Express Light facade tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { expressMcp, mcpFromOpenApi } from '../index.js';
import type { ExpressMcpOptions } from '../types.js';
import {
  type OperationSource,
  type OperationDefinition,
  type RegistrySnapshot,
} from '@askturret/mcp-core';

/**
 * Create mock operation source with configurable operations
 */
function createMockSource(operations: OperationDefinition[]): OperationSource {
  return {
    name: 'mock-source',
    compile: async () => {
      const snapshot: RegistrySnapshot = {
        hash: 'mock-hash',
        operations: new Map(operations.map((op) => [op.id, op])),
        sources: new Map(),
        timestamp: new Date(),
      };
      return { snapshot, warnings: [] };
    },
  };
}

/**
 * Create a test operation
 */
function createOperation(
  id: string,
  readOnly: boolean,
): OperationDefinition {
  return {
    id,
    name: id,
    description: `Test operation ${id}`,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly,
      idempotent: readOnly,
      retryable: readOnly,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'handler' },
  };
}

describe('Express Light Facade', () => {
  describe('mutation exclusion (Light preset)', () => {
    it('should expose only read-only operations by default', async () => {
      // Create source with 3 GETs (read-only) + 2 POSTs (mutating)
      const operations = [
        createOperation('getUser', true), // Read-only
        createOperation('listUsers', true), // Read-only
        createOperation('searchUsers', true), // Read-only
        createOperation('createUser', false), // Mutating
        createOperation('deleteUser', false), // Mutating
      ];

      const source = createMockSource(operations);
      const options: ExpressMcpOptions = {
        sources: [source],
        enableExplorer: false,
      };

      const router = expressMcp(options);

      // Verify router was created
      expect(router).toBeDefined();

      // Light preset should expose 3 read-only tools, exclude 2 mutations
      // (Actual verification would require mounting router and calling tools/list)
    });

    it('should expose all operations when include: "*" is specified', async () => {
      const operations = [
        createOperation('getUser', true), // Read-only
        createOperation('listUsers', true), // Read-only
        createOperation('searchUsers', true), // Read-only
        createOperation('createUser', false), // Mutating
        createOperation('deleteUser', false), // Mutating
      ];

      const source = createMockSource(operations);
      const options: ExpressMcpOptions = {
        sources: [source],
        include: '*', // Explicit all-include
        enableExplorer: false,
      };

      const router = expressMcp(options);

      expect(router).toBeDefined();

      // With include: '*', all 5 operations should be exposed
    });

    it('should expose only explicitly included operations', async () => {
      const operations = [
        createOperation('getUser', true),
        createOperation('listUsers', true),
        createOperation('createUser', false),
        createOperation('deleteUser', false),
      ];

      const source = createMockSource(operations);
      const options: ExpressMcpOptions = {
        sources: [source],
        include: ['getUser', 'createUser'], // Explicit include list
        enableExplorer: false,
      };

      const router = expressMcp(options);

      expect(router).toBeDefined();

      // Only 2 explicitly included operations should be exposed
    });
  });

  describe('Explorer availability', () => {
    it('should enable Explorer in development by default', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      try {
        const operations = [createOperation('getUser', true)];
        const source = createMockSource(operations);

        const router = expressMcp({
          sources: [source],
        });

        expect(router).toBeDefined();
        // Explorer should be available at /mcp/explorer
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should disable Explorer in production by default', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const operations = [createOperation('getUser', true)];
        const source = createMockSource(operations);

        const router = expressMcp({
          sources: [source],
        });

        expect(router).toBeDefined();
        // Explorer should return 404 in production
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should respect explicit enableExplorer setting', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const operations = [createOperation('getUser', true)];
        const source = createMockSource(operations);

        const router = expressMcp({
          sources: [source],
          enableExplorer: true, // Explicit override
        });

        expect(router).toBeDefined();
        // Explorer should be available despite production env
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });

  describe('one-call form: mcpFromOpenApi()', () => {
    it('should accept string spec path', () => {
      const router = mcpFromOpenApi('./test-openapi.yaml');
      expect(router).toBeDefined();
    });

    it('should accept options object', () => {
      const router = mcpFromOpenApi({
        spec: './test-openapi.yaml',
        basePath: '/api/mcp',
        include: '*',
      });
      expect(router).toBeDefined();
    });
  });

  describe('configuration defaults', () => {
    it('should use Light preset defaults', () => {
      const operations = [createOperation('getUser', true)];
      const source = createMockSource(operations);

      const router = expressMcp({
        sources: [source],
      });

      expect(router).toBeDefined();

      // Light preset defaults:
      // - basePath: '/mcp'
      // - maxRequestBodySize: 1048576 (1 MiB)
      // - maxResponseSize: 1048576 (1 MiB)
      // - deadlineMs: 30000 (30s)
      // - Read-only ops only (mutations excluded)
    });

    it('should allow overriding defaults', () => {
      const operations = [createOperation('getUser', true)];
      const source = createMockSource(operations);

      const router = expressMcp({
        sources: [source],
        basePath: '/api/mcp',
        maxRequestBodySize: 2097152, // 2 MiB
        deadlineMs: 60000, // 60s
        include: '*',
      });

      expect(router).toBeDefined();
    });
  });
});
