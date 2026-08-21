/**
 * HTTP transport tests
 *
 * Coverage:
 * 1. Wire-fixture golden JSON-RPC request/response pairs (initialize, tools/list, tools/call, ping)
 * 2. Host-header validation (rejection test)
 * 3. Session-store restart/resume
 * 4. Request/response size limits
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { randomUUID } from 'crypto';
import { createHttpTransport } from './index.js';
import { createInMemorySessionStore } from './session-store.js';
import type { HttpTransport, SessionStore } from './types.js';
import {
  AtomicRegistryReference,
  type RegistrySnapshot,
  type OperationDefinition,
} from '@askturret/mcp-core';

/**
 * Mock request/response objects for testing
 */
class MockRequest {
  headers: Record<string, string> = {};
  method = 'POST';
  url = '/mcp';
  private chunks: Buffer[] = [];
  private ended = false;
  private closeHandler?: () => void;

  setBody(body: string) {
    this.chunks = [Buffer.from(body, 'utf-8')];
  }

  on(event: string, handler: (data?: any) => void) {
    if (event === 'data') {
      this.chunks.forEach((chunk) => handler(chunk));
    } else if (event === 'end') {
      handler();
    } else if (event === 'close') {
      this.closeHandler = handler;
    }
  }

  // Simulate connection close (call this in tests to trigger cleanup)
  simulateClose() {
    if (this.closeHandler) {
      this.closeHandler();
    }
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(body: string) {
    this.body = body;
  }

  write(data: string) {
    this.body += data;
  }
}

/**
 * Create a mock registry with test operations
 */
function createMockRegistry(): AtomicRegistryReference {
  const echoOp: OperationDefinition = {
    name: 'echo',
    description: 'Echo the input',
    input: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
    },
    output: {
      type: 'object',
      properties: {
        echo: { type: 'string' },
      },
    },
    effects: {
      mutatesState: false,
      requiresConfirmation: false,
      idempotencyKeyRequired: false,
    },
    executor: {
      strategy: 'handler',
      handler: async (input: any) => ({
        echo: input.message || 'empty',
      }),
    },
  };

  const snapshot: RegistrySnapshot = {
    hash: 'test-hash-123',
    operations: new Map([['echo', echoOp]]),
    sources: new Map(),
    timestamp: new Date(),
  };

  return new AtomicRegistryReference(snapshot);
}

describe('HTTP Transport', () => {
  let transport: HttpTransport;
  let registry: AtomicRegistryReference;

  beforeEach(() => {
    registry = createMockRegistry();
    transport = createHttpTransport({
      registry,
      basePath: '/mcp',
    });
  });

  describe('Wire-fixture golden JSON-RPC tests', () => {
    it('should handle initialize request', async () => {
      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost';
      req.method = 'POST';
      req.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            clientInfo: {
              name: 'test-client',
              version: '1.0.0',
            },
          },
        }),
      );

      const handler = transport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      expect(response.jsonrpc).toBe('2.0');
      expect(response.result.protocolVersion).toBe('2024-11-05');
      expect(response.result.serverInfo.name).toBe('@askturret/mcp');
      expect(response.result.capabilities.tools).toBeDefined();
    });

    it('should handle tools/list request', async () => {
      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost';
      req.method = 'POST';
      req.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '2',
          method: 'tools/list',
          params: {},
        }),
      );

      const handler = transport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      expect(response.jsonrpc).toBe('2.0');
      expect(response.result.tools).toBeInstanceOf(Array);
      expect(response.result.tools.length).toBe(1);
      expect(response.result.tools[0].name).toBe('echo');
      expect(response.result.tools[0].description).toBe('Echo the input');
    });

    // Skipped: dispatcher doesn't invoke real executors until #83/PR #87 merges — echo-stub behavior expected until then
    it.skip('should handle tools/call request', async () => {
      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost';
      req.method = 'POST';
      req.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '3',
          method: 'tools/call',
          params: {
            name: 'echo',
            arguments: {
              message: 'hello world',
            },
          },
        }),
      );

      const handler = transport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      expect(response.jsonrpc).toBe('2.0');
      expect(response.result.content).toBeInstanceOf(Array);
      expect(response.result.content[0].type).toBe('text');

      const result = JSON.parse(response.result.content[0].text);
      expect(result.echo).toBe('hello world');
    });

    it('should handle ping request', async () => {
      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost';
      req.method = 'POST';
      req.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '4',
          method: 'ping',
          params: {},
        }),
      );

      const handler = transport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      expect(response.jsonrpc).toBe('2.0');
      expect(response.result.status).toBe('ok');
    });

    it('should reject unknown method', async () => {
      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost';
      req.method = 'POST';
      req.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '5',
          method: 'unknown/method',
          params: {},
        }),
      );

      const handler = transport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('not found');
    });
  });

  describe('Host-header validation', () => {
    it('should reject request with unauthorized Host header', async () => {
      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'evil.com';
      req.method = 'POST';
      req.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'ping',
          params: {},
        }),
      );

      const handler = transport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(403);
      const response = JSON.parse(res.body);
      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toBe('Invalid Host header');
    });

    it('should accept request with localhost Host header', async () => {
      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost:3000';
      req.method = 'POST';
      req.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'ping',
          params: {},
        }),
      );

      const handler = transport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it('should accept request with custom allowed host', async () => {
      const customTransport = createHttpTransport({
        registry,
        allowedHosts: ['api.example.com', 'localhost'],
      });

      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'api.example.com';
      req.method = 'POST';
      req.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'ping',
          params: {},
        }),
      );

      const handler = customTransport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });
  });

  describe('Session store restart/resume', () => {
    it('should persist session data across requests', async () => {
      const sessionStore = createInMemorySessionStore();
      const sessionTransport = createHttpTransport({
        registry,
        session: sessionStore,
      });

      const sessionId = randomUUID();

      // First request: initialize with session
      const req1 = new MockRequest();
      const res1 = new MockResponse();

      req1.headers.host = 'localhost';
      req1.headers['x-session-id'] = sessionId;
      req1.method = 'POST';
      req1.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'initialize',
          params: {
            clientInfo: {
              name: 'persistent-client',
              version: '2.0.0',
            },
          },
        }),
      );

      const handler = sessionTransport.handler();
      await handler(req1, res1);

      expect(res1.statusCode).toBe(200);

      // Second request: verify session persisted
      const session = await sessionStore.get(sessionId);
      expect(session).toBeDefined();
      expect(session?.clientInfo?.name).toBe('persistent-client');
      expect(session?.clientInfo?.version).toBe('2.0.0');

      // Third request: tools/list with same session should update lastActivityAt
      const req2 = new MockRequest();
      const res2 = new MockResponse();

      req2.headers.host = 'localhost';
      req2.headers['x-session-id'] = sessionId;
      req2.method = 'POST';
      req2.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '2',
          method: 'tools/list',
          params: {},
        }),
      );

      await handler(req2, res2);

      const updatedSession = await sessionStore.get(sessionId);
      expect(updatedSession).toBeDefined();
      expect(updatedSession!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
        session!.lastActivityAt.getTime(),
      );
    });

    it('should support session termination via DELETE', async () => {
      const sessionStore = createInMemorySessionStore();
      const sessionTransport = createHttpTransport({
        registry,
        session: sessionStore,
      });

      const sessionId = randomUUID();

      // Initialize session
      const req1 = new MockRequest();
      const res1 = new MockResponse();

      req1.headers.host = 'localhost';
      req1.headers['x-session-id'] = sessionId;
      req1.method = 'POST';
      req1.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'initialize',
          params: { clientInfo: { name: 'test', version: '1.0' } },
        }),
      );

      const handler = sessionTransport.handler();
      await handler(req1, res1);

      // Verify session exists
      let session = await sessionStore.get(sessionId);
      expect(session).toBeDefined();

      // Terminate session via DELETE
      const req2 = new MockRequest();
      const res2 = new MockResponse();

      req2.headers.host = 'localhost';
      req2.headers['x-session-id'] = sessionId;
      req2.method = 'DELETE';
      req2.url = '/mcp';

      await handler(req2, res2);

      expect(res2.statusCode).toBe(200);

      // Verify session deleted
      session = await sessionStore.get(sessionId);
      expect(session).toBeNull();
    });
  });

  describe('Request/response size limits', () => {
    it('should reject request body exceeding size limit', async () => {
      const smallLimitTransport = createHttpTransport({
        registry,
        maxRequestBodySize: 100, // 100 bytes
      });

      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost';
      req.method = 'POST';

      // Create a body larger than 100 bytes
      const largeBody = JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'ping',
        params: {
          data: 'x'.repeat(200),
        },
      });

      req.setBody(largeBody);

      const handler = smallLimitTransport.handler();

      // The handler catches the error and returns 500
      await handler(req, res);

      expect(res.statusCode).toBe(500);
      const response = JSON.parse(res.body);
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toBe('Internal server error');
    });

    it('should reject response exceeding size limit with OUTPUT_TOO_LARGE', async () => {
      const smallResponseTransport = createHttpTransport({
        registry,
        maxResponseSize: 200, // 200 bytes
      });

      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost';
      req.method = 'POST';
      req.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'tools/call',
          params: {
            name: 'echo',
            arguments: {
              message: 'x'.repeat(300), // Large response
            },
          },
        }),
      );

      const handler = smallResponseTransport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(413);
      const response = JSON.parse(res.body);
      expect(response.error.code).toBe('OUTPUT_TOO_LARGE');
    });
  });

  describe('SSE heartbeat endpoint', () => {
    it('should handle GET request for SSE stream', async () => {
      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost';
      req.method = 'GET';
      req.url = '/mcp';

      const handler = transport.handler();
      await handler(req, res);

      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.headers['Cache-Control']).toBe('no-cache');
      expect(res.headers.Connection).toBe('keep-alive');

      // Simulate connection close to trigger cleanup and prevent test hang
      req.simulateClose();
    });
  });

  describe('Error handling', () => {
    it('should handle malformed JSON with parse error', async () => {
      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost';
      req.method = 'POST';
      req.setBody('{ invalid json ');

      const handler = transport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(400);
      const response = JSON.parse(res.body);
      expect(response.error.code).toBe(-32700);
      expect(response.error.message).toBe('Parse error');
    });

    it('should return 404 for invalid path', async () => {
      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost';
      req.method = 'POST';
      req.url = '/invalid';

      const handler = transport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(404);
    });

    it('should return 405 for unsupported method', async () => {
      const req = new MockRequest();
      const res = new MockResponse();

      req.headers.host = 'localhost';
      req.method = 'PUT';
      req.url = '/mcp';

      const handler = transport.handler();
      await handler(req, res);

      expect(res.statusCode).toBe(405);
    });
  });
});
