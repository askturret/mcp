// SPDX-License-Identifier: Apache-2.0
/**
 * The factories every in-repo adapter registers with (§42 "Each adapter
 * registers itself with a small factory").
 *
 * These are the ONLY framework-aware lines in this package. Everything in
 * `bank.ts` speaks HTTP.
 *
 * ## Where these live, and why not in the adapter packages
 *
 * §42 shows `registerAdapter('express', createExpressServer)` — the adapter
 * registering itself — and also says "a new adapter that lands in the repo
 * automatically joins the suite". Those pull in opposite directions: something
 * registered by hand does not join automatically, and something that joins
 * automatically was not registered by hand.
 *
 * Reconciled by making the FACTORY explicit and the MEMBERSHIP automatic:
 * factories live here (a few lines each, needing no change to an adapter's
 * public surface), and `registry.test.ts` discovers `packages/adapters-*` from
 * disk and FAILS if any of them has no factory. So a new adapter cannot land
 * and quietly sit outside the suite — the build stops until it joins — which is
 * the guarantee "automatically joins" is actually asking for.
 *
 * Flagged for QA as an interpretation rather than picked silently.
 */

import { createServer } from 'node:http';
import type { McpFacadeOptions } from '@askturret/mcp-core';
import { registerAdapter, type ConformanceServer } from './registry.js';

/** Where the bank expects the MCP endpoint to be mounted. */
export const MOUNT_PATH = '/mcp';

function urlFor(port: number): string {
  return `http://127.0.0.1:${port}${MOUNT_PATH}`;
}

registerAdapter('express', async (options: McpFacadeOptions): Promise<ConformanceServer> => {
  const [{ default: express }, { expressMcp }] = await Promise.all([
    import('express'),
    import('@askturret/mcp-adapters-express'),
  ]);

  const app = express();
  app.use(MOUNT_PATH, expressMcp(options));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: urlFor(port),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // `close()` stops accepting new connections but WAITS for open ones.
        // The cancellation category deliberately leaves a half-dead socket
        // behind, so without this the suite would hang on teardown rather than
        // report a result. Fastify's own `close()` does the equivalent.
        server.closeAllConnections?.();
      }),
  };
});

registerAdapter('fastify', async (options: McpFacadeOptions): Promise<ConformanceServer> => {
  const [{ default: Fastify }, { fastifyMcp }] = await Promise.all([
    import('fastify'),
    import('@askturret/mcp-adapters-fastify'),
  ]);

  const app = Fastify();
  await app.register(fastifyMcp(options), { prefix: MOUNT_PATH });
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return { url: urlFor(port), close: () => app.close() };
});
