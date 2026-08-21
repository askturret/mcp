/**
 * viaHttp executor tests
 */

import { describe, it, expect } from '@jest/globals';
import { viaHttp } from '../via-http.js';
import type { OperationDefinition } from '../../types.js';
import type { DispatchContext } from '../../dispatcher/types.js';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../types.js';

/**
 * Create a minimal test operation definition
 */
function createTestOperation(overrides?: Partial<OperationDefinition>): OperationDefinition {
  return {
    id: 'testOp',
    name: 'testOp',
    description: 'Test operation',
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: false,
      idempotent: false,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'http' },
    ...overrides,
  };
}

/**
 * Create a minimal test context
 */
function createTestContext(overrides?: Partial<DispatchContext>): DispatchContext {
  const abortController = new AbortController();

  return {
    requestId: 'test-request-1',
    operationId: 'testOp',
    registryHash: 'test-hash',
    deadline: new Date(Date.now() + 30000),
    signal: abortController.signal,
    ...overrides,
  };
}

/**
 * Mock HTTP client for testing
 */
function createMockClient(responses: Map<string, HttpResponse>): HttpClient {
  return {
    async request(url: string, _options: HttpRequestOptions): Promise<HttpResponse> {
      const response = responses.get(url);
      if (!response) {
        throw new Error(`No mock response for ${url}`);
      }
      return response;
    },
  };
}

/**
 * Mock HTTP client that throws (for testing connection errors)
 */
function createFailingClient(error: Error): HttpClient {
  return {
    async request(): Promise<HttpResponse> {
      throw error;
    },
  };
}

describe('viaHttp', () => {
  describe('round-trip execution', () => {
    it('should execute HTTP request and return result', async () => {
      const mockClient = createMockClient(
        new Map([
          [
            'https://api.example.com/testOp',
            {
              status: 200,
              headers: {},
              body: JSON.stringify({ result: 'success', value: 42 }),
            },
          ],
        ]),
      );

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation();
      const context = createTestContext();
      const input = { value: 42 };

      const result = await executor.execute(operation, input, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ result: 'success', value: 42 });
      }
    });

    it('should send input as JSON in request body', async () => {
      let capturedBody: string | undefined;

      const mockClient: HttpClient = {
        async request(_url: string, options: HttpRequestOptions): Promise<HttpResponse> {
          capturedBody = options.body;
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ ok: true }),
          };
        },
      };

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation();
      const context = createTestContext();
      const input = { test: 'value' };

      await executor.execute(operation, input, context);

      expect(capturedBody).toBe(JSON.stringify(input));
    });
  });

  describe('SSRF safety', () => {
    it('should only use baseUrl from config, never from user input', async () => {
      let capturedUrl: string | undefined;

      const mockClient: HttpClient = {
        async request(url: string): Promise<HttpResponse> {
          capturedUrl = url;
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ ok: true }),
          };
        },
      };

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation({ id: 'testOp' });
      const context = createTestContext();

      // Try to inject malicious URL in input
      const input = {
        url: 'https://malicious.com',
        host: 'evil.com',
      };

      await executor.execute(operation, input, context);

      // Verify URL is constructed from config baseUrl + operation.id only
      expect(capturedUrl).toBe('https://api.example.com/testOp');
      expect(capturedUrl).not.toContain('malicious');
      expect(capturedUrl).not.toContain('evil');
    });
  });

  describe('credential resolution', () => {
    it('should resolve credentials at execution time', async () => {
      let capturedHeaders: Record<string, string> | undefined;

      const mockClient: HttpClient = {
        async request(_url: string, options: HttpRequestOptions): Promise<HttpResponse> {
          capturedHeaders = options.headers;
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ ok: true }),
          };
        },
      };

      const credentials = async () => ({
        Authorization: 'Bearer secret-token',
        'X-API-Key': 'api-key-123',
      });

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
        credentials,
      });

      const operation = createTestOperation();
      const context = createTestContext();

      await executor.execute(operation, {}, context);

      expect(capturedHeaders?.Authorization).toBe('Bearer secret-token');
      expect(capturedHeaders?.['X-API-Key']).toBe('api-key-123');
    });
  });

  describe('HTTP status code mapping', () => {
    it('should map 401 to UNAUTHENTICATED', async () => {
      const mockClient = createMockClient(
        new Map([
          [
            'https://api.example.com/testOp',
            {
              status: 401,
              headers: {},
              body: '',
            },
          ],
        ]),
      );

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation();
      const context = createTestContext();

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('should map 403 to FORBIDDEN', async () => {
      const mockClient = createMockClient(
        new Map([
          [
            'https://api.example.com/testOp',
            {
              status: 403,
              headers: {},
              body: '',
            },
          ],
        ]),
      );

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation();
      const context = createTestContext();

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('FORBIDDEN');
      }
    });

    it('should map 429 to RATE_LIMITED with retry-after', async () => {
      const mockClient = createMockClient(
        new Map([
          [
            'https://api.example.com/testOp',
            {
              status: 429,
              headers: { 'retry-after': '30' },
              body: '',
            },
          ],
        ]),
      );

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation();
      const context = createTestContext();

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('RATE_LIMITED');
        expect(result.error.retryAfter).toBe(30);
      }
    });

    it('should map 500 to INTERNAL_ERROR', async () => {
      const mockClient = createMockClient(
        new Map([
          [
            'https://api.example.com/testOp',
            {
              status: 500,
              headers: {},
              body: '',
            },
          ],
        ]),
      );

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation();
      const context = createTestContext();

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INTERNAL_ERROR');
      }
    });
  });

  describe('socket reset and OUTCOME_UNKNOWN', () => {
    it('should return OUTCOME_UNKNOWN on socket reset for non-idempotent ops', async () => {
      const mockClient = createFailingClient(new Error('Socket reset'));

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation({
        effects: {
          readOnly: false,
          idempotent: false, // Non-idempotent
          retryable: false,
          idempotencyKeyRequired: false,
          classifications: [],
        },
      });

      const context = createTestContext();

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('OUTCOME_UNKNOWN');
        expect(result.error.message).toContain('outcome uncertain');
      }
    });

    it('should return UPSTREAM_UNAVAILABLE on socket reset for idempotent ops', async () => {
      const mockClient = createFailingClient(new Error('Connection refused'));

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation({
        effects: {
          readOnly: true,
          idempotent: true, // Idempotent
          retryable: true,
          idempotencyKeyRequired: false,
          classifications: [],
        },
      });

      const context = createTestContext();

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UPSTREAM_UNAVAILABLE');
      }
    });
  });

  describe('deadline enforcement', () => {
    it('should return TIMEOUT if deadline is already exceeded', async () => {
      const mockClient = createMockClient(new Map());

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation();
      const deadline = new Date(Date.now() - 1000); // Already passed
      const context = createTestContext({ deadline });

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TIMEOUT');
      }
    });

    it('should enforce deadline independently of client timeout', async () => {
      const mockClient: HttpClient = {
        async request(_url: string, options: HttpRequestOptions): Promise<HttpResponse> {
          // Simulate slow request
          await new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
            setTimeout(resolve, 5000);
          });

          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ ok: true }),
          };
        },
      };

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
        timeoutMs: 10000, // 10 second client timeout
      });

      const operation = createTestOperation();
      const deadline = new Date(Date.now() + 100); // 100ms deadline (shorter than client timeout)
      const context = createTestContext({ deadline });

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TIMEOUT');
      }
    });
  });

  describe('cancellation', () => {
    it('should return CANCELLED if signal is aborted before execution', async () => {
      const mockClient = createMockClient(new Map());

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation();
      const abortController = new AbortController();
      abortController.abort();
      const context = createTestContext({ signal: abortController.signal });

      const result = await executor.execute(operation, {}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('CANCELLED');
      }
    });

    it('should propagate AbortSignal to HTTP client', async () => {
      let capturedSignal: AbortSignal | undefined;

      const mockClient: HttpClient = {
        async request(_url: string, options: HttpRequestOptions): Promise<HttpResponse> {
          capturedSignal = options.signal;
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ ok: true }),
          };
        },
      };

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
      });

      const operation = createTestOperation();
      const abortController = new AbortController();
      const context = createTestContext({ signal: abortController.signal });

      await executor.execute(operation, {}, context);

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);

      // Abort and verify signal is connected
      abortController.abort();
      expect(capturedSignal?.aborted).toBe(true);
    });
  });
});
