// SPDX-License-Identifier: Apache-2.0
/**
 * Span attribute redaction tests (§9.1 "attributes NEVER emitted").
 */

import { describe, it, expect } from '@jest/globals';
import { REDACTED, isDeniedAttributeKey, maskUrl, sanitizeAttributes } from '../attributes.js';
import { createRecordingTracer } from '../tracer.js';
import { SPAN_ATTR } from '../types.js';

describe('sanitizeAttributes', () => {
  it('masks a payload attribute rather than dropping the key', () => {
    // The issue's stated outcome: emitting a span with a payload results in
    // `payload: '[REDACTED]'` — key present, value gone.
    expect(sanitizeAttributes({ payload: 'token=x' })).toEqual({ payload: REDACTED });
  });

  it('masks every §9.1 never-emitted category', () => {
    const out = sanitizeAttributes({
      arguments: 'raw request body',
      response: 'raw response body',
      authorization: 'Bearer abc',
      cookie: 'session=1',
      principal: 'user-42',
      input: 'x',
      output: 'y',
    });

    expect(Object.values(out).every((v) => v === REDACTED)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('user-42');
    expect(JSON.stringify(out)).not.toContain('Bearer abc');
  });

  it('allows principal.identityHash, the §9.1-recommended substitute', () => {
    // The remedy the spec names must not be blocked by the rule that
    // recommends it — otherwise there is no compliant way to correlate.
    expect(isDeniedAttributeKey('principal.identityHash')).toBe(false);
    expect(sanitizeAttributes({ 'principal.identityHash': 'abc123' })).toEqual({
      'principal.identityHash': 'abc123',
    });
  });

  it('leaves the stable attribute set untouched', () => {
    const stable = {
      [SPAN_ATTR.method]: 'tools/call',
      [SPAN_ATTR.toolName]: 'listPets',
      [SPAN_ATTR.protocolVersion]: '2025-06-18',
      [SPAN_ATTR.registryHash]: 'a1b2c3d4e5f6',
      [SPAN_ATTR.clientName]: 'claude-desktop',
      [SPAN_ATTR.outcome]: 'success',
      [SPAN_ATTR.executorType]: 'http',
    };

    expect(sanitizeAttributes(stable)).toEqual(stable);
  });

  it('matches denied keys regardless of case and separators', () => {
    expect(sanitizeAttributes({ Authorization: 'x' })).toEqual({ Authorization: REDACTED });
    expect(sanitizeAttributes({ api_key: 'x' })).toEqual({ api_key: REDACTED });
    expect(sanitizeAttributes({ 'raw-input': 'x' })).toEqual({ 'raw-input': REDACTED });
  });
});

describe('maskUrl', () => {
  it('strips the query string entirely', () => {
    // A query string is where tokens and search terms live.
    expect(maskUrl('https://api.example.com/pets?token=secret&q=fluffy')).toBe(
      'https://api.example.com/pets?<redacted>',
    );
  });

  it('replaces identifier-shaped path segments while keeping the route shape', () => {
    // The route shape is the useful part AND the low-cardinality part.
    expect(maskUrl('https://api.example.com/pets/12345/visits')).toBe(
      'https://api.example.com/pets/:id/visits',
    );
    expect(maskUrl('https://api.example.com/users/8f14e45f-ceea-467a-9d5f-1c0a2b3c4d5e')).toBe(
      'https://api.example.com/users/:id',
    );
  });

  it('keeps ordinary route words', () => {
    expect(maskUrl('https://api.example.com/pets/available')).toBe(
      'https://api.example.com/pets/available',
    );
  });

  it('masks a relative path when the value is not an absolute URL', () => {
    expect(maskUrl('/pets/12345?token=x')).toBe('/pets/:id');
  });

  it('masks URL-shaped attribute values through sanitizeAttributes', () => {
    expect(
      sanitizeAttributes({ 'http.url': 'https://api.example.com/pets/99?apiKey=leak' }),
    ).toEqual({ 'http.url': 'https://api.example.com/pets/:id?<redacted>' });
  });
});

describe('spans enforce redaction, not just the helper', () => {
  it('sanitises attributes set at span start', () => {
    const tracer = createRecordingTracer();
    tracer.startSpan('mcp.request', { attributes: { payload: 'token=x' } }).end();

    expect(tracer.all()[0]?.attributes['payload']).toBe(REDACTED);
  });

  it('sanitises attributes set one at a time', () => {
    // A single-key setter must not be a way around the bulk-set rule.
    const tracer = createRecordingTracer();
    const span = tracer.startSpan('mcp.request');
    span.setAttribute('authorization', 'Bearer abc');
    span.end();

    expect(tracer.all()[0]?.attributes['authorization']).toBe(REDACTED);
  });

  it('sanitises attributes on child spans too', () => {
    const tracer = createRecordingTracer();
    const root = tracer.startSpan('mcp.request');
    root.startChild('executor.invoke', { attributes: { body: 'raw' } }).end();
    root.end();

    const child = tracer.all().find((s) => s.name === 'executor.invoke');
    expect(child?.attributes['body']).toBe(REDACTED);
  });
});
