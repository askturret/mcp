// SPDX-License-Identifier: Apache-2.0
/**
 * Base-URL resolution tests (#103).
 *
 * A wrong base URL sends real traffic to an unintended host, so every case that
 * cannot be resolved with confidence must resolve to *nothing* with a stated
 * reason — never to a plausible guess.
 */

import { describe, it, expect } from '@jest/globals';
import { resolveServerUrl } from '../resolve-server-url.js';

describe('resolveServerUrl', () => {
  it('uses an absolute server URL', () => {
    const r = resolveServerUrl([{ url: 'https://api.example.com/v1' }], undefined);

    expect(r.baseUrl).toBe('https://api.example.com/v1');
    expect(r.reason).toBeUndefined();
  });

  it('strips a trailing slash so joins do not double up', () => {
    expect(resolveServerUrl([{ url: 'https://api.example.com/v1/' }], undefined).baseUrl).toBe(
      'https://api.example.com/v1',
    );
  });

  it('takes the first server and reports the others rather than choosing silently', () => {
    const r = resolveServerUrl(
      [
        { url: 'https://prod.example.com' },
        { url: 'https://staging.example.com' },
        { url: 'https://dev.example.com' },
      ],
      undefined,
    );

    expect(r.baseUrl).toBe('https://prod.example.com');
    expect(r.alternatives).toEqual(['https://staging.example.com', 'https://dev.example.com']);
  });

  it('substitutes server variables from their declared defaults', () => {
    const r = resolveServerUrl(
      [
        {
          url: 'https://{region}.api.example.com/{version}',
          variables: {
            region: { default: 'eu-west', enum: ['eu-west', 'us-east'] },
            version: { default: 'v2' },
          },
        },
      ],
      undefined,
    );

    expect(r.baseUrl).toBe('https://eu-west.api.example.com/v2');
  });

  it('refuses a variable with no default rather than leaving a literal placeholder', () => {
    const r = resolveServerUrl(
      [{ url: 'https://{tenant}.api.example.com', variables: { tenant: {} } }],
      undefined,
    );

    expect(r.baseUrl).toBeUndefined();
    expect(r.reason).toContain('tenant');
    expect(r.reason).toMatch(/default/i);
  });

  it('falls through to a later server when the first is unusable', () => {
    const r = resolveServerUrl(
      [
        { url: '{scheme}://broken.example.com', variables: { scheme: {} } },
        { url: 'https://good.example.com' },
      ],
      undefined,
    );

    expect(r.baseUrl).toBe('https://good.example.com');
  });

  describe('no servers entry', () => {
    it('resolves to nothing with a reason', () => {
      const r = resolveServerUrl(undefined, undefined);

      expect(r.baseUrl).toBeUndefined();
      expect(r.reason).toMatch(/no servers/i);
    });

    it('treats an empty array the same way', () => {
      expect(resolveServerUrl([], undefined).baseUrl).toBeUndefined();
    });
  });

  describe('relative server URLs', () => {
    it('resolves against the spec URL when the spec was fetched over http(s)', () => {
      const r = resolveServerUrl(
        [{ url: '/api/v1' }],
        'https://specs.example.com/petstore/openapi.json',
      );

      expect(r.baseUrl).toBe('https://specs.example.com/api/v1');
    });

    it('refuses when the spec came from disk, which carries no origin', () => {
      const r = resolveServerUrl([{ url: '/api/v1' }], './openapi.yaml');

      expect(r.baseUrl).toBeUndefined();
      expect(r.reason).toMatch(/relative/i);
    });

    it('refuses when there is no spec location at all', () => {
      const r = resolveServerUrl([{ url: '/api/v1' }], undefined);

      expect(r.baseUrl).toBeUndefined();
      expect(r.reason).toMatch(/relative/i);
    });
  });

  describe('non-http schemes', () => {
    it('refuses a file: server URL rather than turning a spec into a local read', () => {
      const r = resolveServerUrl([{ url: 'file:///etc/passwd' }], undefined);

      expect(r.baseUrl).toBeUndefined();
      expect(r.reason).toMatch(/http/i);
    });

    it('refuses other non-http schemes', () => {
      expect(resolveServerUrl([{ url: 'ftp://files.example.com' }], undefined).baseUrl)
        .toBeUndefined();
    });
  });

  it('ignores entries with no url', () => {
    const r = resolveServerUrl(
      [{ description: 'no url here' }, { url: 'https://api.example.com' }],
      undefined,
    );

    expect(r.baseUrl).toBe('https://api.example.com');
  });
});
