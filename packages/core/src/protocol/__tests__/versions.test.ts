// SPDX-License-Identifier: Apache-2.0
/**
 * Protocol-version negotiation (#61, §12.3).
 *
 * The bug this module exists to close: the version lived in two places and they
 * disagreed. The transport announced `2024-11-05` while the dispatcher stamped
 * `2025-06-18` onto `mcp.protocol.version` on every span — so the attribute
 * named after the protocol version reported one the server had never spoken.
 *
 * The last describe block is what stops that recurring: it asserts the
 * agreement itself, not just each value.
 */

import { describe, it, expect } from '@jest/globals';

import {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
} from '../versions.js';

describe('negotiateProtocolVersion', () => {
  it('accepts a client that asks for the version we speak', () => {
    const result = negotiateProtocolVersion(MCP_PROTOCOL_VERSION);

    expect(result.ok).toBe(true);
    expect(result.ok && result.version).toBe(MCP_PROTOCOL_VERSION);
  });

  it('accepts a client that omits the field', () => {
    // Omission is common and is not a statement of incompatibility. Refusing it
    // would break clients that work perfectly well.
    for (const absent of [undefined, null]) {
      const result = negotiateProtocolVersion(absent);
      expect(result.ok).toBe(true);
      expect(result.ok && result.version).toBe(MCP_PROTOCOL_VERSION);
    }
  });

  it('REFUSES an unsupported version', () => {
    const result = negotiateProtocolVersion('1999-01-01');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.requested).toBe('1999-01-01');
  });

  it('names both the rejected version and what it does speak', () => {
    // A refusal that does not say what would work sends the operator reading
    // source. Both halves are asserted because either alone is unhelpful.
    const result = negotiateProtocolVersion('1999-01-01');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('1999-01-01');
    expect(result.reason).toContain(MCP_PROTOCOL_VERSION);
  });

  it('refuses a non-string rather than coercing it', () => {
    // `{ protocolVersion: 20241105 }` must not be silently stringified into
    // something that happens to compare unequal — the operator gets told the
    // type is wrong, which is the actual mistake.
    const result = negotiateProtocolVersion(20241105);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('must be a string');
  });

  it('returns a decision rather than exiting the process', () => {
    // §61 is explicit: refusal must not be process.exit(). This runs inside an
    // adopter's server, so exiting would let a remote client halt every
    // unrelated route by sending one field. The test is that we get a VALUE
    // back at all — a process.exit() implementation could not.
    const result = negotiateProtocolVersion('nope');

    expect(result).toBeDefined();
    expect(result.ok).toBe(false);
  });
});

describe('isSupportedProtocolVersion', () => {
  it('accepts every declared version', () => {
    for (const version of SUPPORTED_MCP_PROTOCOL_VERSIONS) {
      expect(isSupportedProtocolVersion(version)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isSupportedProtocolVersion('2025-06-18')).toBe(false);
  });
});

describe('the announced version and the supported set agree', () => {
  it('announces a version it will also accept', () => {
    // Announcing something we would then refuse is the most embarrassing
    // possible shape of this bug, and it is one line to prevent.
    expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).toContain(MCP_PROTOCOL_VERSION);
  });

  it('is the version docs/compatibility.md publishes as supported', () => {
    // compatibility.md is a VERSIONED CONTRACT. If this constant changes
    // without that document changing, one of the two is lying to adopters —
    // and the document is the one they read.
    expect(MCP_PROTOCOL_VERSION).toBe('2024-11-05');
  });
});
