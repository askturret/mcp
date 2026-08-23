// SPDX-License-Identifier: Apache-2.0
/**
 * The in-repo adapters, as `AdapterUnderTest` values (§54).
 *
 * These produce the Express and Fastify rows of the public conformance table.
 *
 * ## They come from the conformance package, not from here
 *
 * An earlier version of this file built the servers itself — `createServer`
 * from `node:http`, `app.listen`, the lot. The network-import guard rejected
 * it, and it was right to.
 *
 * The obvious fix was to add this path to that guard's allowlist, next to the
 * conformance package which does exactly the same thing. But read why THAT
 * entry is permitted: "this package is `private: true`, is never published,
 * ships in nothing an adopter installs". **None of that is true here.** §54
 * exists to publish this package to npm, so reusing that justification would
 * have meant copying a reason that does not apply, and widening a security
 * guard on the strength of it.
 *
 * So the framework-aware code stays on the side of the boundary that is already
 * allowlisted, and this package — the one meant to be published — needs no
 * network exemption at all. `adapterUnderTest` is a rename rather than a
 * reimplementation: `AdapterFactory` already IS
 * `(options) => Promise<{ url, close }>`, so the official adapters are still
 * driven through the same public shape a community adapter takes, with no
 * privileged route.
 */

import { adapterUnderTest } from '@askturret/mcp-adapter-conformance';

import type { AdapterUnderTest } from './kit.js';

export const expressAdapterUnderTest: AdapterUnderTest = adapterUnderTest('express');

export const fastifyAdapterUnderTest: AdapterUnderTest = adapterUnderTest('fastify');

/** Both in-repo adapters, for the conformance table. */
export const IN_REPO_ADAPTERS: readonly AdapterUnderTest[] = [
  expressAdapterUnderTest,
  fastifyAdapterUnderTest,
];
