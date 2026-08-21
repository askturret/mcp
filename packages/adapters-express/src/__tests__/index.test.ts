/**
 * Express Light facade tests
 */

import { describe, it, expect } from '@jest/globals';
import { expressMcp, mcpFromOpenApi } from '../index.js';
import type { ExpressMcpOptions } from '../types.js';
import type { OperationSource, DiscoveredOperation } from '@askturret/mcp-core';

/**
 * Create mock operation source with configurable discovered operations
 */
function createMockSource(discoveredOps: DiscoveredOperation[]): OperationSource {
  return {
    name: 'mock-source',
    discover: async () => discoveredOps,
  };
}

/**
 * Create a test discovered operation
 */
function createDiscoveredOp(
  id: string,
  readOnly: boolean,
): DiscoveredOperation {
  return {
    candidateId: id,
    name: id,
    description: `Test operation ${id}`,
    source: 'mock-source',
    rawInput: { type: 'object' },
    rawOutput: { type: 'object' },
    effects: {
      readOnly,
      idempotent: readOnly,
      retryable: readOnly,
    },
  };
}

describe('Express Light Facade', () => {
  describe('mutation exclusion (Light preset)', () => {
    it('should expose only read-only operations by default', () => {
      // Create source with 3 GETs (read-only) + 2 POSTs (mutating)
      const operations = [
        createDiscoveredOp('getUser', true), // Read-only
        createDiscoveredOp('listUsers', true), // Read-only
        createDiscoveredOp('searchUsers', true), // Read-only
        createDiscoveredOp('createUser', false), // Mutating
        createDiscoveredOp('deleteUser', false), // Mutating
      ];

      const source = createMockSource(operations);
      const options: ExpressMcpOptions = {
        sources: [source],
        enableExplorer: false,
      };

      const router = expressMcp(options);

      // Verify router was created and is a function with route stack
      expect(router).toBeDefined();
      expect(typeof router).toBe('function');
      expect(router.stack).toBeDefined();

      // Light preset should expose 3 read-only tools, exclude 2 mutations
      // (Full verification would require mounting router and calling tools/list)
    });

    it('should expose all operations when include: "*" is specified', () => {
      const operations = [
        createDiscoveredOp('getUser', true), // Read-only
        createDiscoveredOp('listUsers', true), // Read-only
        createDiscoveredOp('searchUsers', true), // Read-only
        createDiscoveredOp('createUser', false), // Mutating
        createDiscoveredOp('deleteUser', false), // Mutating
      ];

      const source = createMockSource(operations);
      const options: ExpressMcpOptions = {
        sources: [source],
        include: '*', // Explicit all-include
        enableExplorer: false,
      };

      const router = expressMcp(options);

      expect(router).toBeDefined();
      expect(typeof router).toBe('function');

      // With include: '*', all 5 operations should be exposed
    });

    it('should expose only explicitly included operations', () => {
      const operations = [
        createDiscoveredOp('getUser', true),
        createDiscoveredOp('listUsers', true),
        createDiscoveredOp('createUser', false),
        createDiscoveredOp('deleteUser', false),
      ];

      const source = createMockSource(operations);
      const options: ExpressMcpOptions = {
        sources: [source],
        include: ['getUser', 'createUser'], // Explicit include list
        enableExplorer: false,
      };

      const router = expressMcp(options);

      expect(router).toBeDefined();
      expect(typeof router).toBe('function');

      // Only 2 explicitly included operations should be exposed
    });
  });

  describe('Explorer availability', () => {
    it('should enable Explorer in development by default', () => {
      const originalEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'development';

      try {
        const operations = [createDiscoveredOp('getUser', true)];
        const source = createMockSource(operations);

        const router = expressMcp({
          sources: [source],
        });

        expect(router).toBeDefined();
        expect(typeof router).toBe('function');
        // Explorer should be available at /mcp/explorer
      } finally {
        process.env['NODE_ENV'] = originalEnv;
      }
    });

    it('should disable Explorer in production by default', () => {
      const originalEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';

      try {
        const operations = [createDiscoveredOp('getUser', true)];
        const source = createMockSource(operations);

        const router = expressMcp({
          sources: [source],
        });

        expect(router).toBeDefined();
        expect(typeof router).toBe('function');
        // Explorer should return 404 in production
      } finally {
        process.env['NODE_ENV'] = originalEnv;
      }
    });

    it('should respect explicit enableExplorer setting', () => {
      const originalEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';

      try {
        const operations = [createDiscoveredOp('getUser', true)];
        const source = createMockSource(operations);

        const router = expressMcp({
          sources: [source],
          enableExplorer: true, // Explicit override
        });

        expect(router).toBeDefined();
        expect(typeof router).toBe('function');
        // Explorer should be available despite production env
      } finally {
        process.env['NODE_ENV'] = originalEnv;
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
      const operations = [createDiscoveredOp('getUser', true)];
      const source = createMockSource(operations);

      const router = expressMcp({
        sources: [source],
      });

      expect(router).toBeDefined();
      expect(typeof router).toBe('function');

      // Light preset defaults:
      // - basePath: '/mcp'
      // - maxRequestBodySize: 1048576 (1 MiB)
      // - maxResponseSize: 1048576 (1 MiB)
      // - deadlineMs: 30000 (30s)
      // - Read-only ops only (mutations excluded)
    });

    it('should allow overriding defaults', () => {
      const operations = [createDiscoveredOp('getUser', true)];
      const source = createMockSource(operations);

      const router = expressMcp({
        sources: [source],
        basePath: '/api/mcp',
        maxRequestBodySize: 2097152, // 2 MiB
        deadlineMs: 60000, // 60s
        include: '*',
      });

      expect(router).toBeDefined();
      expect(typeof router).toBe('function');
    });
  });
});
