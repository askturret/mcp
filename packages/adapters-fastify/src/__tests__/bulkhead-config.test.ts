// SPDX-License-Identifier: Apache-2.0
/**
 * Bulkhead config reaches the dispatcher through a facade (#43).
 *
 * §43 specifies a config surface. `DispatcherOptions.bulkheads` is where stage
 * 6 reads it, but the transport is what constructs the dispatcher and the
 * facade is what constructs the transport — so without threading, the option
 * would exist and be unreachable from any adapter, and bulkheads would ship
 * configurable only in theory.
 *
 * That chain is three layers deep, which is exactly the kind of claim that is
 * easy to assert in a comment and wrong in fact. Measured here instead:
 * configure a one-slot bulkhead through the PUBLIC facade options and prove a
 * real HTTP caller is shed with QUEUE_FULL.
 */

import { describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';

import type { McpFacadeOptions, OperationExecutor, OperationSource } from '@askturret/mcp-core';
import { fastifyMcp } from '../index.js';

/** One read-only operation whose executor blocks until released. */
function blockingSetup() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const source = {
    id: 'static',
    discover: async () => [
      {
        candidateId: 'slowOp',
        name: 'slowOp',
        description: 'blocks until released',
        source: { kind: 'explicit', location: 'static:slowOp' },
        rawInput: { type: 'object', properties: {} },
        rawOutput: { type: 'object', properties: {} },
        hints: { readOnly: true },
      },
    ],
  } as unknown as OperationSource;

  const executor = {
    execute: async () => {
      await gate;
      return { ok: true, value: {} };
    },
  } as unknown as OperationExecutor;

  return { source, executor, release };
}

const rpc = (name: string) => ({
  jsonrpc: '2.0',
  id: Math.floor(Math.random() * 100000),
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('bulkhead config through the facade', () => {
  it('sheds with QUEUE_FULL when a one-slot bulkhead is configured via transport options', async () => {
    const { source, executor, release } = blockingSetup();

    const options: McpFacadeOptions = {
      sources: [source],
      include: '*',
      enableExplorer: false,
      transport: {
        executors: new Map([
          ['handler', executor],
          ['explicit', executor],
        ]),
        // The surface under test. A read-only operation routes to `reads`.
        bulkheads: {
          default: { concurrency: 1, queueSize: 0 },
          reads: { concurrency: 1, queueSize: 0 },
        },
      } as McpFacadeOptions['transport'],
    };

    const app = Fastify();
    await app.register(fastifyMcp(options), { prefix: '/mcp' });
    await app.ready();

    try {
      // First call occupies the only slot and blocks.
      const inFlight = app.inject({ method: 'POST', url: '/mcp', payload: rpc('slowOp') });
      await new Promise((r) => setTimeout(r, 50));

      const shed = await app.inject({ method: 'POST', url: '/mcp', payload: rpc('slowOp') });
      const body = JSON.stringify(JSON.parse(shed.body));

      // The whole point: configured through the facade, enforced in stage 6,
      // and surfaced as QUEUE_FULL rather than as an internal fault.
      expect(body).toContain('QUEUE_FULL');
      expect(body).not.toContain('INTERNAL_ERROR');

      release();
      await inFlight;
    } finally {
      await app.close();
    }
  }, 15000);

  it('does not shed when the configured bulkhead has room', async () => {
    // The complement. A test that only ever saw QUEUE_FULL would pass against
    // a build that rejected everything.
    const { source, executor, release } = blockingSetup();
    release(); // never blocks

    const app = Fastify();
    await app.register(
      fastifyMcp({
        sources: [source],
        include: '*',
        enableExplorer: false,
        transport: {
          executors: new Map([
            ['handler', executor],
            ['explicit', executor],
          ]),
          bulkheads: { default: { concurrency: 5, queueSize: 5 }, reads: { concurrency: 5, queueSize: 5 } },
        } as McpFacadeOptions['transport'],
      }),
      { prefix: '/mcp' },
    );
    await app.ready();

    try {
      const response = await app.inject({ method: 'POST', url: '/mcp', payload: rpc('slowOp') });
      expect(response.body).not.toContain('QUEUE_FULL');
    } finally {
      await app.close();
    }
  }, 15000);
});
