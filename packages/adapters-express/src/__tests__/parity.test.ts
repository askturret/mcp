// SPDX-License-Identifier: Apache-2.0
/**
 * Config parity with the Fastify facade (§41).
 *
 * The other half of a transitive proof. This file asserts that Express's
 * options type IS core's `McpFacadeOptions`; the Fastify package asserts the
 * same of its own. Type identity is transitive, so together they establish that
 * Express and Fastify share one type — without either package depending on the
 * other, and without the weaker "two types that happen to accept the same
 * object today" that §41's drift concern is actually about.
 *
 * Keep this file and `packages/adapters-fastify/src/__tests__/parity.test.ts`
 * in step: dropping either one silently reduces the guarantee to a claim.
 */

import { describe, it, expect } from '@jest/globals';

import {
  FACADE_DEFAULT_BASE_PATH,
  FACADE_DEFAULT_DEADLINE_MS,
  FACADE_DEFAULT_MAX_REQUEST_BODY_SIZE,
  FACADE_DEFAULT_MAX_RESPONSE_SIZE,
  resolveFacadeDefaults,
  type McpFacadeOptions,
  type McpFromOpenApiFacadeOptions,
} from '@askturret/mcp-core';

import type { ExpressMcpOptions, McpFromOpenApiOptions } from '../types.js';

type Identical<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

// If either stops compiling, the facades have drifted and "swap the import and
// change nothing else" is no longer true.
type _OptionsAreOneType = Expect<Identical<ExpressMcpOptions, McpFacadeOptions>>;
type _OneCallOptionsAreOneType = Expect<
  Identical<McpFromOpenApiOptions, McpFromOpenApiFacadeOptions>
>;

describe('config parity with the Fastify facade', () => {
  it('shares one options type with core (and therefore with Fastify)', () => {
    const witness: _OptionsAreOneType & _OneCallOptionsAreOneType = true;
    expect(witness).toBe(true);
  });

  it('applies the same Light preset defaults both facades use', () => {
    const resolved = resolveFacadeDefaults({ sources: [] });

    expect(resolved.basePath).toBe(FACADE_DEFAULT_BASE_PATH);
    expect(resolved.maxRequestBodySize).toBe(FACADE_DEFAULT_MAX_REQUEST_BODY_SIZE);
    expect(resolved.maxResponseSize).toBe(FACADE_DEFAULT_MAX_RESPONSE_SIZE);
    expect(resolved.deadlineMs).toBe(FACADE_DEFAULT_DEADLINE_MS);
  });
});
