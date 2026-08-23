// SPDX-License-Identifier: Apache-2.0
/**
 * The adapter conformance contract (§12.2, §12.4).
 *
 * ## What an adapter must provide
 *
 * Exactly one thing: a factory that takes the shared facade options and returns
 * a LISTENING server plus a way to close it. Everything the bank asserts is then
 * exercised over real HTTP.
 *
 * That is deliberate, and it is the whole reason this suite can claim parity.
 * A bank that imported `expressMcp` and `fastifyMcp` and poked at them directly
 * would be testing two code paths it already knows are different. Speaking
 * JSON-RPC over a socket tests the only thing a user actually depends on — that
 * both adapters present the SAME behaviour at the wire — and it means a future
 * adapter (Koa, NestJS, something not yet written) joins by implementing one
 * function rather than by being understood by this package.
 *
 * Nothing in the test bank may import a framework. If a category cannot be
 * expressed over the wire, that is a finding about the contract, not a licence
 * to reach into an adapter.
 */

import type { McpFacadeOptions } from '@askturret/mcp-core';

/** A running adapter under test. */
export interface ConformanceServer {
  /** Absolute URL of the MCP endpoint, e.g. `http://127.0.0.1:54321/mcp`. */
  readonly url: string;

  /** Shut the server down and release its socket. */
  close(): Promise<void>;
}

/**
 * Builds and starts a server for one adapter.
 *
 * Takes the SHARED facade options type, not an adapter-specific one. Since #41
 * `ExpressMcpOptions` and `FastifyMcpOptions` are aliases of
 * `McpFacadeOptions`, so this signature is not a lowest-common-denominator
 * compromise — it is the actual, whole config surface of both adapters. A
 * category that needs an option therefore needs no per-adapter translation, and
 * an adapter that quietly narrowed its surface would fail to satisfy this type.
 */
export type AdapterFactory = (options: McpFacadeOptions) => Promise<ConformanceServer>;

const adapters = new Map<string, AdapterFactory>();

export function registerAdapter(name: string, factory: AdapterFactory): void {
  if (adapters.has(name)) {
    // A silent overwrite would let two registrations disagree about what
    // "express" means, and the suite would report parity for whichever won.
    throw new Error(`Adapter '${name}' is already registered.`);
  }
  adapters.set(name, factory);
}

export function registeredAdapters(): readonly string[] {
  return [...adapters.keys()].sort();
}

export function getAdapter(name: string): AdapterFactory {
  const factory = adapters.get(name);
  if (!factory) {
    throw new Error(
      `No adapter registered under '${name}'. Registered: ${registeredAdapters().join(', ') || '(none)'}`,
    );
  }
  return factory;
}

/** Test-only: reset between suites that assert on registration itself. */
export function clearAdapters(): void {
  adapters.clear();
}

/**
 * Which adapters to run, honouring `--adapter <name>` (§42 "Running the suite").
 *
 * An unknown name THROWS rather than running nothing. A filter typo that
 * silently produced an empty run would report a green suite having tested
 * nothing at all — the failure mode this whole package exists to prevent.
 */
export function selectedAdapters(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  // `--adapter` arrives as an ENV VAR under `npm run test:conformance`, because
  // Jest rejects unknown CLI flags outright (`Unrecognized option "adapter"`)
  // and exits before any test runs. `bin/run.mjs` does the translation. The
  // argv form is still honoured so this stays testable without a subprocess.
  const fromEnv = env['CONFORMANCE_ADAPTER'];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (!adapters.has(fromEnv)) {
      throw new Error(
        `CONFORMANCE_ADAPTER=${fromEnv} is not registered. Registered: ${registeredAdapters().join(', ') || '(none)'}`,
      );
    }
    return [fromEnv];
  }

  const flagIndex = argv.indexOf('--adapter');
  if (flagIndex === -1) return registeredAdapters();

  const requested = argv[flagIndex + 1];
  if (requested === undefined || requested.startsWith('--')) {
    throw new Error('--adapter requires a value, e.g. --adapter express');
  }
  if (!adapters.has(requested)) {
    throw new Error(
      `--adapter ${requested} is not registered. Registered: ${registeredAdapters().join(', ') || '(none)'}`,
    );
  }
  return [requested];
}
