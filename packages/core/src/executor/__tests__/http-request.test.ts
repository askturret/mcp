// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for upstream request building (#103).
 */

import { describe, it, expect } from '@jest/globals';
import type { OperationDefinition } from '../../types.js';
import { buildUpstreamRequest, RequestBuildError } from '../http-request.js';

function op(
  executor: OperationDefinition['executor'],
  id = 'listPets',
): OperationDefinition {
  return {
    id,
    name: id,
    description: 'test op',
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor,
  } as OperationDefinition;
}

describe('buildUpstreamRequest — bound (spec-derived) operations', () => {
  it('uses the declared method and path instead of POSTing to the operation id', () => {
    const built = buildUpstreamRequest(
      op({ type: 'http', config: { method: 'GET', path: '/pets' } }),
      {},
      'https://api.example.com',
    );

    // The bug this fixes: previously every call was POST {base}/{operationId}.
    expect(built.method).toBe('GET');
    expect(built.url).toBe('https://api.example.com/pets');
    expect(built.body).toBeUndefined();
  });

  it('substitutes path parameters from the input', () => {
    const built = buildUpstreamRequest(
      op({ type: 'http', config: { method: 'GET', path: '/pets/{petId}' } }, 'getPet'),
      { petId: 42 },
      'https://api.example.com',
    );

    expect(built.url).toBe('https://api.example.com/pets/42');
  });

  it('percent-encodes path parameters so they cannot inject path segments', () => {
    const built = buildUpstreamRequest(
      op({ type: 'http', config: { method: 'GET', path: '/pets/{petId}' } }, 'getPet'),
      { petId: '../../admin/secrets' },
      'https://api.example.com',
    );

    expect(built.url).toBe('https://api.example.com/pets/..%2F..%2Fadmin%2Fsecrets');
    expect(built.url).not.toContain('/admin/secrets');
  });

  it('sends leftover input as query parameters for methods with no body', () => {
    const built = buildUpstreamRequest(
      op({ type: 'http', config: { method: 'GET', path: '/pets' } }),
      { limit: 10, status: 'available' },
      'https://api.example.com',
    );

    expect(built.method).toBe('GET');
    expect(built.body).toBeUndefined();
    const url = new URL(built.url);
    expect(url.pathname).toBe('/pets');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('status')).toBe('available');
  });

  it('repeats the key for array query values', () => {
    const built = buildUpstreamRequest(
      op({ type: 'http', config: { method: 'GET', path: '/pets' } }),
      { tag: ['cat', 'dog'] },
      'https://api.example.com',
    );

    expect(new URL(built.url).searchParams.getAll('tag')).toEqual(['cat', 'dog']);
  });

  it('sends leftover input as a JSON body for methods that take one', () => {
    const built = buildUpstreamRequest(
      op({ type: 'http', config: { method: 'POST', path: '/pets' } }, 'createPet'),
      { name: 'Rex', tag: 'dog' },
      'https://api.example.com',
    );

    expect(built.method).toBe('POST');
    expect(built.url).toBe('https://api.example.com/pets');
    expect(JSON.parse(built.body!)).toEqual({ name: 'Rex', tag: 'dog' });
  });

  it('keeps path parameters out of the body', () => {
    const built = buildUpstreamRequest(
      op({ type: 'http', config: { method: 'PUT', path: '/pets/{petId}' } }, 'updatePet'),
      { petId: 7, name: 'Rex' },
      'https://api.example.com',
    );

    expect(built.url).toBe('https://api.example.com/pets/7');
    expect(JSON.parse(built.body!)).toEqual({ name: 'Rex' });
  });

  it('prefers the per-operation base URL over the executor default', () => {
    const built = buildUpstreamRequest(
      op({
        type: 'http',
        config: { method: 'GET', path: '/pets', baseUrl: 'https://per-op.example.com' },
      }),
      {},
      'https://default.example.com',
    );

    expect(built.url).toBe('https://per-op.example.com/pets');
  });

  it('does not double up slashes when the base URL has a trailing one', () => {
    const built = buildUpstreamRequest(
      op({ type: 'http', config: { method: 'GET', path: '/pets' } }),
      {},
      'https://api.example.com/api/v1/',
    );

    expect(built.url).toBe('https://api.example.com/api/v1/pets');
  });

  it('reports a missing path parameter as INVALID_INPUT, naming the parameter', () => {
    const build = () =>
      buildUpstreamRequest(
        op({ type: 'http', config: { method: 'GET', path: '/pets/{petId}' } }, 'getPet'),
        {},
        'https://api.example.com',
      );

    expect(build).toThrow(RequestBuildError);

    try {
      build();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RequestBuildError);
      expect((err as RequestBuildError).code).toBe('INVALID_INPUT');
      expect((err as RequestBuildError).message).toContain('petId');
    }
  });

  it('fails with an actionable message when no base URL is available anywhere', () => {
    try {
      buildUpstreamRequest(
        op({ type: 'http', config: { method: 'GET', path: '/pets' } }),
        {},
        undefined,
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RequestBuildError);
      const e = err as RequestBuildError;
      expect(e.code).toBe('INTERNAL_ERROR');
      // Must name the operation and say what to do about it.
      expect(e.message).toContain('listPets');
      expect(e.message).toMatch(/base URL/i);
    }
  });
});

describe('buildUpstreamRequest — RPC operations (unchanged behaviour)', () => {
  it('POSTs to {baseUrl}/{id} when the binding declares no path', () => {
    const built = buildUpstreamRequest(
      op({ type: 'handler', config: {} }, 'testOp'),
      { a: 1 },
      'https://api.example.com',
    );

    expect(built.method).toBe('POST');
    expect(built.url).toBe('https://api.example.com/testOp');
    expect(JSON.parse(built.body!)).toEqual({ a: 1 });
  });

  it('ignores a caller-supplied url field — input never sets the host', () => {
    const built = buildUpstreamRequest(
      op({ type: 'handler', config: {} }, 'testOp'),
      { url: 'https://malicious.example.com' },
      'https://api.example.com',
    );

    expect(built.url).toBe('https://api.example.com/testOp');
    expect(built.url).not.toContain('malicious');
  });
});
