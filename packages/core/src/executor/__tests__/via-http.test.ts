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

      expect(capturedHeaders?.['Authorization']).toBe('Bearer secret-token');
      expect(capturedHeaders && capturedHeaders['X-API-Key']).toBe('api-key-123');
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

  // ==========================================================================
  // Upstream 4xx semantics (#201)
  //
  // A 404 used to collapse into INTERNAL_ERROR: "Upstream service error", so an
  // adopter chasing a missing record was told something broke on our end. The
  // mapping keys on HTTP semantics ONLY — never on whether the spec documented
  // the status — because that fact does not survive compilation and reaching
  // for it would make the error contract depend on where the operation was
  // discovered. See the NOT_FOUND note in types.ts.
  // ==========================================================================

  describe('upstream 4xx mapping (#201)', () => {
    /** Drive one upstream status through the real executor. */
    const executeWithStatus = async (status: number) => {
      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: createMockClient(
          new Map([['https://api.example.com/testOp', { status, headers: {}, body: '' }]]),
        ),
      });

      return executor.execute(createTestOperation(), {}, createTestContext());
    };

    it.each([404, 410])('maps %i to NOT_FOUND', async (status) => {
      // 410 is "was here, permanently gone" — the caller's remedy is identical
      // to a 404's, so one code covers both rather than two near-synonyms.
      const result = await executeWithStatus(status);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    });

    it('maps a 404 the spec never documented to NOT_FOUND TOO', async () => {
      // The test that pins the scoping decision. `createTestOperation()` is a
      // bare operation with no OpenAPI provenance and no documented responses
      // at all — if anyone later reintroduces spec-scoped mapping, this is what
      // goes red, because there is no spec here to consult.
      const result = await executeWithStatus(404);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    });

    it.each([400, 422])('maps %i to INVALID_INPUT', async (status) => {
      // Reuses an existing code rather than adding one: the remedy is the same
      // as a local validation failure. This does widen INVALID_INPUT's meaning
      // to "rejected as malformed, here or upstream".
      const result = await executeWithStatus(status);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('leaves 409 generic but INSPECTABLE via details.upstreamStatus', async () => {
      // The residual 4xx class. No single caller remedy follows from a
      // Conflict, so inventing a code would assert something we do not know —
      // but the status is surfaced so it is distinguishable from a real fault.
      const result = await executeWithStatus(409);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INTERNAL_ERROR');
        expect(result.error.details?.['upstreamStatus']).toBe(409);
      }
    });

    it('carries upstreamStatus on a 500 as well, not only on 4xx', async () => {
      const result = await executeWithStatus(500);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.details?.['upstreamStatus']).toBe(500);
    });

    it('returns the SAME code regardless of which source the operation came from', async () => {
      // The guarantee behind the scoping decision, tested rather than asserted.
      //
      // The rejected design consulted the OpenAPI document's declared responses.
      // Under it, `getPetById` would answer NOT_FOUND when compiled from a spec
      // and INTERNAL_ERROR when registered as an explicit definition — the error
      // contract depending on where the operation was DISCOVERED, which is what
      // ADR-002's source-agnostic model exists to prevent.
      //
      // `provenance` is the field that records discovery source, so an
      // implementation that consulted it would diverge here. Identical
      // operations, identical upstream, only the provenance differs.
      const fromOpenApi = createTestOperation({
        provenance: [{ field: 'description', kind: 'openapi', location: 'petstore.yaml' }],
      });
      const fromExplicitDefinition = createTestOperation({
        provenance: [{ field: 'description', kind: 'code' }],
      });
      const withNoProvenanceAtAll = createTestOperation();

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: createMockClient(
          new Map([['https://api.example.com/testOp', { status: 404, headers: {}, body: '' }]]),
        ),
      });

      const codes: string[] = [];
      for (const operation of [fromOpenApi, fromExplicitDefinition, withNoProvenanceAtAll]) {
        const result = await executor.execute(operation, {}, createTestContext());
        expect(result.ok).toBe(false);
        if (!result.ok) codes.push(result.error.code);
      }

      expect(codes).toEqual(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
    });

    it('does NOT reclassify the statuses that were already mapped', async () => {
      // The paired guard. Inserting new branches ahead of the existing ones is
      // exactly how 401/403/429/502 would get silently swallowed by a broader
      // rule, and every assertion above would still pass.
      const cases: readonly [number, string][] = [
        [401, 'UNAUTHENTICATED'],
        [403, 'FORBIDDEN'],
        [429, 'RATE_LIMITED'],
        [502, 'UPSTREAM_UNAVAILABLE'],
        [503, 'UPSTREAM_UNAVAILABLE'],
        [504, 'UPSTREAM_UNAVAILABLE'],
      ];

      for (const [status, expected] of cases) {
        const result = await executeWithStatus(status);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe(expected);
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
        // OUTCOME_UNKNOWN, not TIMEOUT — and this assertion was CHANGED (#44).
        //
        // `createTestOperation()` is `idempotent: false`, and the request was
        // already in flight when the deadline fired. TIMEOUT reads as "it did
        // not happen", so a caller retries — and the upstream may have applied
        // the first request perfectly well. For a non-idempotent operation
        // that is a double-apply.
        //
        // The old expectation pinned exactly that dangerous answer, which is
        // why this fix had to change a PASSING test rather than only add one.
        // The idempotent complement below still asserts TIMEOUT.
        expect(result.error.code).toBe('OUTCOME_UNKNOWN');
      }
    });

    it('returns TIMEOUT — not OUTCOME_UNKNOWN — for an IDEMPOTENT operation', async () => {
      // The complement, and what makes the change above a refinement rather
      // than a blanket downgrade. Retrying an idempotent operation is safe, so
      // the caller should be told plainly that it timed out.
      //
      // Nothing covered this branch before: the suite asserted only the
      // non-idempotent case and, by expecting TIMEOUT there, implied this one.
      const mockClient: HttpClient = {
        async request(_url: string, options: HttpRequestOptions): Promise<HttpResponse> {
          await new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
            setTimeout(resolve, 5000);
          });
          return { status: 200, headers: {}, body: '{}' };
        },
      };

      const executor = viaHttp({
        baseUrl: 'https://api.example.com',
        client: mockClient,
        timeoutMs: 10000,
      });

      const base = createTestOperation();
      const idempotent = { ...base, effects: { ...base.effects, idempotent: true } };
      const context = createTestContext({ deadline: new Date(Date.now() + 100) });

      const result = await executor.execute(idempotent, {}, context);

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

  describe('retry support (#45, §8.4)', () => {
    /** Capture the headers the executor actually put on the wire. */
    function capturingClient(response: HttpResponse): {
      client: HttpClient;
      headers: () => Record<string, string>;
    } {
      let captured: Record<string, string> = {};
      return {
        client: {
          async request(_url: string, options: HttpRequestOptions): Promise<HttpResponse> {
            captured = { ...(options.headers ?? {}) };
            return response;
          },
        },
        headers: () => captured,
      };
    }

    const ok: HttpResponse = { status: 200, headers: {}, body: '{"ok":true}' };

    it('sends the idempotency key as a header so the upstream can deduplicate', async () => {
      // The runtime deliberately does not persist keys — carrying it to the
      // upstream is the entire mechanism, so a key that never left the process
      // would make the stage-4 enforcement meaningless.
      const { client, headers } = capturingClient(ok);
      const executor = viaHttp({ baseUrl: 'https://api.example.com', client });

      await executor.execute(
        createTestOperation(),
        {},
        createTestContext({ idempotencyKey: 'key-42' }),
      );

      expect(headers()['Idempotency-Key']).toBe('key-42');
    });

    it('omits the header entirely when no key was supplied', async () => {
      // Not an empty string: an empty Idempotency-Key is a value an upstream
      // could try to deduplicate on, and every keyless request would collide.
      const { client, headers } = capturingClient(ok);
      const executor = viaHttp({ baseUrl: 'https://api.example.com', client });

      await executor.execute(createTestOperation(), {}, createTestContext());

      expect(Object.keys(headers())).not.toContain('Idempotency-Key');
    });

    it.each([502, 503, 504])(
      'maps %i to UPSTREAM_UNAVAILABLE, so the retry policy can see it is transient',
      async (status) => {
        const mockClient = createMockClient(
          new Map([
            ['https://api.example.com/test', { status, headers: {}, body: '' }],
          ]),
        );
        const executor = viaHttp({ baseUrl: 'https://api.example.com', client: mockClient });

        const result = await executor.execute(
          createTestOperation({ executor: { type: 'http', config: { path: '/test' } } }),
          {},
          createTestContext(),
        );

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('UPSTREAM_UNAVAILABLE');
      },
    );

    it('leaves 500 as INTERNAL_ERROR — "certain 5xx" excludes application faults', async () => {
      // A 500 means the request REACHED the backend and the backend broke on
      // it. Replaying it reproduces the same fault, so it must not become a
      // transient code. This is the boundary of the mapping above, and it is
      // asserted rather than assumed.
      const mockClient = createMockClient(
        new Map([['https://api.example.com/test', { status: 500, headers: {}, body: '' }]]),
      );
      const executor = viaHttp({ baseUrl: 'https://api.example.com', client: mockClient });

      const result = await executor.execute(
        createTestOperation({ executor: { type: 'http', config: { path: '/test' } } }),
        {},
        createTestContext(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INTERNAL_ERROR');
    });
  });
});
