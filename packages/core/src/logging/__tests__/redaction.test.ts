// SPDX-License-Identifier: Apache-2.0
/**
 * Redaction placeholder tests (§9.4).
 */

import { describe, it, expect } from '@jest/globals';
import {
  defaultRedaction,
  redactWithGaps,
  shannonEntropy,
  DEFAULT_REDACTED_KEYS,
  REDACTED,
} from '../redaction.js';

describe('defaultRedaction', () => {
  it('masks a password field rather than dropping the key', () => {
    // The issue's stated outcome verbatim. Note this CONTRADICTS its own
    // "never include credentials" line, which would imply removing the key
    // entirely - flagged for QA. The explicit test wins.
    expect(defaultRedaction({ password: 'p' })).toEqual({ password: REDACTED });
  });

  it('masks every key on the documented list', () => {
    const fields = Object.fromEntries(
      DEFAULT_REDACTED_KEYS.map((key) => [key, 'sensitive-value']),
    );

    const out = defaultRedaction(fields);

    for (const key of DEFAULT_REDACTED_KEYS) {
      expect(out[key]).toBe(REDACTED);
    }
    expect(Object.values(out)).not.toContain('sensitive-value');
  });

  it('matches key names case-insensitively', () => {
    // `Authorization` is the commonest spelling of the header; a
    // case-sensitive list would miss precisely the real-world case.
    const out = defaultRedaction({ Authorization: 'Bearer abc', APIKEY: 'k' });

    expect(out['Authorization']).toBe(REDACTED);
    expect(out['APIKEY']).toBe(REDACTED);
  });

  it('redacts nested and array-held values, not just top-level keys', () => {
    const out = defaultRedaction({
      outer: { token: 'abc', safe: 'keep' },
      list: [{ secret: 's' }],
    });

    expect(out).toEqual({
      outer: { token: REDACTED, safe: 'keep' },
      list: [{ secret: REDACTED }],
    });
  });

  it('leaves ordinary fields untouched', () => {
    const fields = { requestId: 'r-1', stage: 4, ok: true, nothing: null };
    expect(defaultRedaction(fields)).toEqual(fields);
  });
});

describe('redaction gap detection', () => {
  it('reports a JWT sitting under a key the list does not cover', () => {
    const { fields, gaps } = redactWithGaps({
      sessionBlob:
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    });

    expect(gaps).toEqual([{ path: 'sessionBlob', reason: 'jwt-shaped' }]);
    // The gap is a WARNING, not a redaction: the value is still emitted. That
    // is the honest behaviour for a placeholder - it reports what it cannot
    // handle rather than pretending to handle it.
    expect(fields['sessionBlob']).toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('reports bearer- and basic-prefixed values', () => {
    const { gaps } = redactWithGaps({
      proxyAuth: 'Bearer sk-live-0123456789abcdef',
      legacyAuth: 'Basic dXNlcjpwYXNzd29yZDEyMw==',
    });

    expect(gaps.map((g) => g.reason)).toEqual(['bearer-prefixed', 'bearer-prefixed']);
  });

  it('reports a PEM private key block', () => {
    const { gaps } = redactWithGaps({
      keyMaterial: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----',
    });

    expect(gaps[0]?.reason).toBe('pem-block');
  });

  it('reports a high-entropy blob under an innocuous key name', () => {
    const { gaps } = redactWithGaps({ cacheKey: 'aZ3kP9xQ7mW2rT8vY5nB1cF6' });

    expect(gaps[0]).toEqual({ path: 'cacheKey', reason: 'high-entropy-string' });
  });

  it('does not report ordinary prose or short identifiers', () => {
    // A gap warning on every human-readable string would be noise, and noise
    // is how a real signal gets ignored. This case caught a real false
    // positive during development: entropy per character is capped at
    // log2(length), so a 49-char English sentence scored in the same band as
    // a 24-char secret. Shape, not entropy, is what separates them.
    const { gaps } = redactWithGaps({
      message: 'the operation completed successfully after a retry',
      requestId: 'req-42',
      stageName: 'validate-input',
    });

    expect(gaps).toEqual([]);
  });

  it('does not report camelCase identifiers or lowercase URLs', () => {
    // Both are long and whitespace-free, so length alone would flag them.
    const { gaps } = redactWithGaps({
      handlerName: 'operationIdListPetsByStatusAndTag',
      endpoint: 'https://example.com/some/path/to/a/resource',
    });

    expect(gaps).toEqual([]);
  });

  it('does not flag canonical fields, however hash-like their values', () => {
    // registryHash is a hex digest on EVERY line. If it ever grows past the
    // hex threshold, flagging it would put a warning on every single record -
    // which is how warnings get switched off wholesale.
    const { gaps } = redactWithGaps({
      registryHash: 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(32),
      requestId: 'aZ3kP9xQ7mW2rT8vY5nB1cF6',
      traceId: 'aZ3kP9xQ7mW2rT8vY5nB1cF6',
    });

    expect(gaps).toEqual([]);
  });

  it('still flags a hash-like value under a NON-canonical key', () => {
    // The exemption is per-key, not a blanket softening of the heuristic.
    const { gaps } = redactWithGaps({
      someOtherHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    });

    expect(gaps).toEqual([{ path: 'someOtherHash', reason: 'high-entropy-string' }]);
  });

  it('does not flag a repetitive low-entropy string that merely looks hex', () => {
    // `deadbeef` repeated is all-hex and 64 chars, but has five distinct
    // characters and ~2 bits/char. The entropy floor is what stops the shape
    // rules alone from flagging obviously non-random filler.
    const { gaps } = redactWithGaps({ filler: 'deadbeef'.repeat(8) });

    expect(gaps).toEqual([]);
  });

  it('does not report values it already masked', () => {
    // A key on the redaction list is handled, so it is not a GAP. Reporting
    // it would inflate the #49 signal with cases already covered.
    const { gaps } = redactWithGaps({ token: 'Bearer sk-live-0123456789abcdef' });

    expect(gaps).toEqual([]);
  });

  it('reports the dotted path so a nested gap is locatable', () => {
    const { gaps } = redactWithGaps({
      headers: { proxyAuth: 'Bearer sk-live-0123456789abcdef' },
    });

    expect(gaps[0]?.path).toBe('headers.proxyAuth');
  });
});

describe('shannonEntropy', () => {
  it('scores random-looking strings above prose', () => {
    const prose = shannonEntropy('the quick brown fox jumps over the lazy dog');
    const key = shannonEntropy('aZ3kP9xQ7mW2rT8vY5nB1cF6');

    expect(key).toBeGreaterThan(prose);
  });

  it('returns 0 for an empty string and for a single repeated character', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
  });
});
