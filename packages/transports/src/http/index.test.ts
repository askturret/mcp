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
  viaHandler,
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
  private failure?: Error;

  setBody(body: string) {
    this.chunks = [Buffer.from(body, 'utf-8')];
  }

  /**
   * Make the stream fail instead of delivering a body (#125).
   *
   * Needed to distinguish "the client sent too much" from "the socket broke",
   * which the transport must report differently. Before this the mock had no
   * way to reach `req.on('error')` at all, so the non-size branch of the body
   * read was untestable.
   */
  failWith(error: Error) {
    this.failure = error;
  }

  on(event: string, handler: (data?: any) => void) {
    if (event === 'data') {
      // A failing stream delivers no data and never ends — emitting either
      // would settle the read before the error handler is even registered,
      // and the test would silently exercise the success path.
      if (!this.failure) this.chunks.forEach((chunk) => handler(chunk));
    } else if (event === 'end') {
      if (!this.failure) handler();
    } else if (event === 'error') {
      if (this.failure) handler(this.failure);
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
 * Echo handler for tests
 */
const echoHandler = async (input: any) => ({
  echo: input.message || 'empty',
});

/**
 * Create a mock registry with test operations
 */
function createMockRegistry(): AtomicRegistryReference {
  const echoOp: OperationDefinition = {
    id: 'echo',
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
      readOnly: true,
      idempotent: true,
    },
    executor: {
      type: 'handler',
    },
  };

  const snapshot: RegistrySnapshot = {
    hash: 'test-hash-123',
    operations: new Map([['echo', echoOp]]),
    version: 1,
    createdAt: new Date(),
  };

  return new AtomicRegistryReference(snapshot);
}

describe('HTTP Transport', () => {
  let transport: HttpTransport;
  let registry: AtomicRegistryReference;
  let executors: Map<string, any>;

  beforeEach(() => {
    registry = createMockRegistry();

    // Register handler executor for tests
    executors = new Map();
    executors.set('handler', viaHandler(echoHandler));

    transport = createHttpTransport({
      registry,
      basePath: '/mcp',
      executors,
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

    it('should handle tools/call request', async () => {
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

  /**
   * Every row of #247's table, in one place.
   *
   * `split(':')[0]` assumed at most one colon, so every IPv6 literal reduced to
   * `'['` and the shipped `[::1]` default could never match — an allowlist row
   * that read as coverage and routed nothing. It failed CLOSED, so this was a
   * false-deny rather than a hole, but an operator on IPv6 localhost got a 403
   * no configuration could fix.
   *
   * Table-driven ON PURPOSE, and the negative rows are the load-bearing ones. A
   * test asserting only that `localhost` passes goes green over the bug AND the
   * fix, and would not notice a "fix" that made IPv6 work by loosening the
   * mitigation — the one trade this must not make.
   */
  describe('Host-header allowlist (#247)', () => {
    const send = async (host: string | undefined) => {
      const req = new MockRequest();
      const res = new MockResponse();

      if (host !== undefined) req.headers.host = host;
      req.method = 'POST';
      req.setBody(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'ping', params: {} }));

      await transport.handler()(req, res);
      return res;
    };

    it.each([
      // Rows that already worked — kept so a regression here is visible.
      ['localhost', true],
      ['localhost:3000', true],
      ['127.0.0.1:8080', true],
      // The defect: both reduced to '[' before the lookup.
      ['[::1]', true],
      ['[::1]:8080', true],
      // Canonicalised to the same address, so the default entry covers it.
      ['[::0001]', true],
      // Host names are case-insensitive; the old code compared raw bytes.
      ['LOCALHOST', true],
      // The negatives. Without these the suite would accept a fix that made
      // IPv6 work by widening the allowlist.
      ['evil.com', false],
      ['evil.com:3000', false],
      // `URL` reads these as userinfo / path / fragment / query and returns
      // 'localhost' for all four. Accepting them would trade a false-deny for
      // a real loosening.
      ['evil.com@localhost', false],
      ['localhost/../evil.com', false],
      ['localhost#evil.com', false],
      ['localhost?x=evil.com', false],
      // Unparseable authorities: deny, exactly as before.
      ['[::1', false],
      ['local host', false],
      ['', false],
    ])('Host: %p -> allowed: %p', async (host, allowed) => {
      const res = await send(host as string);

      if (allowed) {
        expect(res.statusCode).not.toBe(403);
      } else {
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error.message).toBe('Invalid Host header');
      }
    });

    it('denies a request with no Host header at all', async () => {
      const res = await send(undefined);

      expect(res.statusCode).toBe(403);
    });

    it('accepts the unbracketed ::1 spelling in CONFIGURATION', async () => {
      // `::1` is not valid in a Host header, but it is what an operator writes
      // in a config file — and #247 was filed partly because neither spelling
      // worked. Both sides canonicalise, so the two agree.
      const ipv6Transport = createHttpTransport({
        registry,
        basePath: '/mcp',
        executors,
        allowedHosts: ['::1'],
      });

      const req = new MockRequest();
      const res = new MockResponse();
      req.headers.host = '[::1]:8080';
      req.method = 'POST';
      req.setBody(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'ping', params: {} }));

      await ipv6Transport.handler()(req, res);

      expect(res.statusCode).not.toBe(403);
    });

    it('still denies a host outside a custom allowlist', async () => {
      // The control for the row above: a custom allowlist must still exclude.
      const ipv6Transport = createHttpTransport({
        registry,
        basePath: '/mcp',
        executors,
        allowedHosts: ['::1'],
      });

      const req = new MockRequest();
      const res = new MockResponse();
      req.headers.host = 'localhost';
      req.method = 'POST';
      req.setBody(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'ping', params: {} }));

      await ipv6Transport.handler()(req, res);

      expect(res.statusCode).toBe(403);
    });

    it('refuses an allowlist entry that could never match, rather than dropping it', () => {
      // An unparseable entry can match nothing — which IS the #247 defect. So
      // it fails at construction rather than being silently discarded, which
      // would rebuild the same "reads as coverage, routes nothing" shape by
      // another route.
      expect(() =>
        createHttpTransport({
          registry,
          basePath: '/mcp',
          executors,
          allowedHosts: ['evil.com/x'],
        }),
      ).toThrow(/not a valid host/);
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
        executors,
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

      await handler(req, res);

      // Asserted 500 / -32603 / "Internal server error" until #125. That was
      // the defect, not the contract: an oversized payload is a normal,
      // client-correctable condition, and reporting it as a server fault told
      // the client to look in the wrong place — or to retry, since -32603 reads
      // as transient.
      //
      // Now symmetric with the OUTPUT_TOO_LARGE case below: same 413, same
      // shape, opposite direction.
      expect(res.statusCode).toBe(413);
      const response = JSON.parse(res.body);
      expect(response.error.code).toBe('REQUEST_TOO_LARGE');
      expect(response.error.message).toBe('Request exceeds size limit');
      // `id` is null rather than absent: the body never parsed, so there is no
      // id to echo, and JSON-RPC says to use null when it cannot be determined.
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBeNull();
    });

    it('still returns 500 when the body read fails for a reason other than size', async () => {
      // The narrowing that makes the above safe. `readRequestBody` rejects for
      // socket errors too, and turning EVERY body-read failure into 413 would
      // trade one misreported condition for another — telling a client its
      // payload was too big when the connection actually broke.
      const transport = createHttpTransport({ registry, executors });

      const req = new MockRequest();
      const res = new MockResponse();
      req.headers.host = 'localhost';
      req.method = 'POST';
      req.failWith(new Error('ECONNRESET'));

      await transport.handler()(req, res);

      expect(res.statusCode).toBe(500);
      const response = JSON.parse(res.body);
      expect(response.error.code).toBe(-32603);
    });

    it('should reject response exceeding size limit with OUTPUT_TOO_LARGE', async () => {
      const smallResponseTransport = createHttpTransport({
        registry,
        executors,
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
