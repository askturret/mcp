// SPDX-License-Identifier: Apache-2.0
/**
 * Protocol-version negotiation (#61, §12.3).
 *
 * The bug this module exists to close: the version lived in two places and they
 * disagreed. The transport announced `2024-11-05` while the dispatcher stamped
 * `2025-06-18` onto `mcp.protocol.version` on every span — so the attribute
 * named after the protocol version reported one the server had never spoken.
 *
 * The last TWO describe blocks are what stop that recurring, and they cover
 * different pairings: the constant against the supported SET, and the constant
 * against the published CONTRACT. Neither implies the other.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
} from '../versions.js';

/**
 * The published contract, READ rather than restated (#640).
 *
 * This test was named `is the version docs/compatibility.md publishes as
 * supported` and asserted `toBe('2024-11-05')` — a hardcoded literal. It pinned
 * the constant honestly, but it never opened the document, so it could not
 * observe the pairing its own name claimed. Not a check that fails to run: a
 * check that runs, passes, and is MISLABELLED — which is more durable, because
 * nothing ever fails to draw attention to it.
 *
 * WHY THE TEST NOW READS THE DOCUMENT rather than the name being corrected to
 * match the weaker assertion. Both were legitimate options; this one was chosen
 * because the pairing turns out to be covered by NOTHING ELSE.
 * `check-compatibility-contract.mjs` walks only entries carrying a `declared`
 * key, and `protocol.mcp.protocolVersion` carries none — verified by running
 * its own `declaredEntries` export over the real contract, which returns five
 * entries, the only protocol-adjacent one being `protocol.mcp.sdk`. So this is
 * not duplicating a guard; without it the constant and the document can diverge
 * with nothing anywhere noticing. Renaming would have made the file honest and
 * left the gap open.
 *
 * BOTH COPIES ARE READ, deliberately. `compatibility.md` and
 * `compatibility.json` are hand-maintained in parallel and neither derives from
 * the other — they have drifted before (#625 found the OpenAPI rows saying
 * different things). Asserting only one would leave the other free to rot, so
 * the pairing is checked against each.
 *
 * Reading a repository document from a package test is established practice
 * here, not a new coupling: `sources-openapi`'s `from-openapi.test.ts` reads
 * this same file the same way.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

const CONTRACT_JSON = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs', 'compatibility.json'), 'utf-8'),
) as { protocol?: { mcp?: { protocolVersion?: string } } };

const CONTRACT_MD = readFileSync(join(REPO_ROOT, 'docs', 'compatibility.md'), 'utf-8');

/** The `| MCP protocol version | \`…\` | ✅ Supported |` row's published value. */
const MD_PROTOCOL_VERSION = /^\|\s*MCP protocol version\s*\|\s*`([^`]+)`\s*\|/m.exec(CONTRACT_MD)?.[1];

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
    // ONE negative sample, deliberately — and the reason is the IMPLEMENTATION,
    // not this test's pairing with the one above it (#712).
    //
    // The tempting rationale is "the positive direction above iterates the whole
    // supported set, so a single negative balances it". That argument is about
    // the pairing, and it is not what makes one sample enough.
    // `isSupportedProtocolVersion` is a one-line
    // `SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(version)` — set membership, with
    // no parsing, no ranges, no prefix or normalisation handling. There is no
    // second sample that could catch anything the first does not, because there
    // is no branch for one to take.
    //
    // The distinction is load-bearing for whoever changes that implementation:
    // if it ever grows surface, this test wants revisiting — and the pairing
    // argument would go on reading as sound while the coverage quietly stopped
    // being adequate. The rationale is what generalises; the decision is not.
    //
    // The sample is the version from the originating bug (#61): the one the
    // dispatcher used to stamp onto every span but the server never spoke.
    expect(isSupportedProtocolVersion('2025-06-18')).toBe(false);
  });
});

describe('the announced version and the supported set agree', () => {
  it('announces a version it will also accept', () => {
    // Announcing something we would then refuse is the most embarrassing
    // possible shape of this bug, and it is one line to prevent.
    expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).toContain(MCP_PROTOCOL_VERSION);
  });

});

describe('the announced version and the published contract agree', () => {
  // Its own describe block, not folded into the one above (#640). That one is
  // about the constant versus the supported SET — both of which live in
  // versions.ts. This is the constant versus a DOCUMENT, which is a different
  // pairing with a different failure mode, and nesting it under the other made
  // the parent block's subject wrong too.

  // Guards the guard, and it is load-bearing rather than ceremony — but what it
  // buys is DIAGNOSIS, not the ability to fail (#712).
  //
  // If either read yields undefined the assertions below do not go quiet. They
  // fail either way, because `expect('2024-11-05').toBe(undefined)` fails. What
  // breaks is what the failure SAYS: it inverts into `Expected: undefined,
  // Received: "2024-11-05"`, accusing MCP_PROTOCOL_VERSION — the one value in
  // the comparison still known to be correct. A reader follows that message to
  // the constant and finds nothing wrong with it.
  //
  // So this assertion names the CAUSE — a contract read stopped producing a
  // version — rather than preventing a silent pass, which is not a failure mode
  // available here. Do not take that on trust; it is cheap to check. Break
  // either read (misspell the row label in the regex above, or parse `'{}'` in
  // place of the JSON file) and run this suite: TWO arms redden, not one, and
  // only this one says what actually happened.
  it('read a version out of both contract copies to compare against', () => {
    expect(CONTRACT_JSON.protocol?.mcp?.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MD_PROTOCOL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches the version docs/compatibility.json publishes', () => {
    // compatibility.json is a VERSIONED CONTRACT. If this constant changes
    // without that document changing, one of the two is lying to adopters —
    // and the document is the one they read.
    expect(MCP_PROTOCOL_VERSION).toBe(CONTRACT_JSON.protocol?.mcp?.protocolVersion);
  });

  it('matches the version docs/compatibility.md publishes', () => {
    // The prose copy is read separately because it is maintained by hand
    // alongside the JSON rather than generated from it, so the two can drift
    // apart independently of the code.
    expect(MCP_PROTOCOL_VERSION).toBe(MD_PROTOCOL_VERSION);
  });
});
