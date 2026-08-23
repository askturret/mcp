// SPDX-License-Identifier: Apache-2.0
/**
 * Reference-Petstore layer (§51 acceptance: "Every layer above runs green
 * against a reference Petstore server").
 *
 * ## Why this exists separately from the other scenarios
 *
 * Every other scenario in this suite builds its operations with the harness's
 * `operation()` helper — a hand-written `OperationDefinition` shaped exactly
 * the way the scenario needs. That is the right tool for asserting on an
 * interaction, but it means the whole suite was running against operations
 * that no compiler ever produced. §51 asks for the layers to run against a
 * reference server, and QA was right that nothing here did.
 *
 * So this module takes the real `examples/petstore-light/openapi.yaml`
 * through the REAL path an adopter's spec takes — `fromOpenApi().discover()`
 * then `createCompiler().compile()` — and re-runs the layers against whatever
 * comes out. Nothing is hand-shaped.
 *
 * ## What that actually buys, beyond ticking the criterion
 *
 * Compiled operations differ from the synthetic ones in ways the suite cares
 * about, and every one of these is a property no `operation()` call was
 * asserting:
 *
 *   - they carry a real `executor.config.baseUrl`, so breaker assignment
 *     resolves by URL PREFIX (rule 2) rather than by annotation (rule 1) —
 *     a different branch of `assignBreaker` than any other scenario reaches;
 *   - `effects.retryable` is `true`, derived from the spec's GET verbs rather
 *     than set by hand, so the retry interaction runs on compiler output;
 *   - ids and names come from `operationId`, so a call is routed by the same
 *     string an adopter would read in their own spec.
 *
 * ## The upstream is stubbed, deliberately
 *
 * "Reference Petstore server" here means a real compiled Petstore REGISTRY,
 * not a live HTTP server at petstore.example.com. The executor is replaced so
 * the scenarios stay hermetic and free of network flake. What is under test is
 * the resilience tier's behaviour when driving real operations — not whether
 * an example host is reachable, which would make this suite fail for reasons
 * that have nothing to do with reliability.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import {
  createCompiler,
  type DiscoveryContext,
  type OperationDefinition,
  type OperationExecutor,
  type OperationResult,
} from '@askturret/mcp-core';
import { fromOpenApi } from '@askturret/mcp-sources-openapi';

import { createHarness, drive, gatedExecutor, tally } from '../harness.js';

/** The executor type every compiled OpenAPI operation binds to. */
const PETSTORE_EXECUTOR = 'http';

const SILENT_CONTEXT: DiscoveryContext = {
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  abortSignal: new AbortController().signal,
};

/**
 * Locate the reference spec relative to THIS module rather than to the
 * process working directory.
 *
 * `process.cwd()` is whatever directory the runner happened to start in — the
 * package root under `npm test`, the repo root under the nightly job. Resolving
 * from the module keeps the path correct under both, instead of working in CI
 * and failing for whoever runs the suite from somewhere else.
 */
export function petstoreSpecPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/scenarios (built) or src/scenarios (ts-jest) -> package -> packages -> repo
  return resolvePath(here, '../../../..', 'examples/petstore-light/openapi.yaml');
}

/**
 * Compile the reference Petstore spec into real operations.
 *
 * Exported so an adopter can point the same layers at their own spec: §51's
 * acceptance asks for the suite to be runnable in subsets against their
 * deployment, and the registry is the natural seam for that.
 */
export async function loadPetstoreOperations(
  specPath: string = petstoreSpecPath(),
): Promise<readonly OperationDefinition[]> {
  const discovered = await fromOpenApi(specPath).discover(SILENT_CONTEXT);
  const snapshot = await createCompiler().compile(discovered, {
    ...SILENT_CONTEXT,
    overlays: [],
    // `light` is the v0.1 default an adopter gets before opting into a
    // hardened preset — the honest starting point for a reference server.
    preset: 'light',
  });

  // `RegistrySnapshot.operations` is a Map keyed by operation id.
  return [...snapshot.operations.values()];
}

function okExecutor(): OperationExecutor {
  return { execute: async (): Promise<OperationResult> => ({ ok: true, value: {} }) };
}

function failingExecutor(): OperationExecutor {
  return {
    execute: async (): Promise<OperationResult> => ({
      ok: false,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'petstore upstream down' },
    }),
  };
}

export interface PetstoreLayerResult {
  readonly layer: string;
  readonly ok: boolean;
  readonly detail: Record<string, unknown>;
}

export interface PetstoreSuiteResult {
  readonly operationIds: readonly string[];
  readonly layers: readonly PetstoreLayerResult[];
  readonly allGreen: boolean;
}

/**
 * Run every §51 layer against the compiled Petstore registry.
 *
 * Each layer returns its own verdict rather than throwing, so a failure names
 * the layer that failed instead of collapsing the whole run into one stack
 * trace — the same reason the chaos scenario reports a tally rather than
 * asserting inline.
 */
export async function petstoreLayers(
  operations: readonly OperationDefinition[],
): Promise<PetstoreSuiteResult> {
  const ids = operations.map((op) => op.id);
  const primary = ids[0] as string;
  const layers: PetstoreLayerResult[] = [];

  // ---- Layer: load -------------------------------------------------------
  {
    const harness = createHarness({
      operations,
      executors: new Map([[PETSTORE_EXECUTOR, okExecutor()]]),
    });
    const outcomes = await drive(60, 10, (i) =>
      harness.call(ids[i % ids.length] as string),
    );
    const codes = tally(outcomes);
    layers.push({
      layer: 'load',
      ok: codes['success'] === 60,
      detail: { codes },
    });
  }

  // ---- Layer: slow upstream (bulkhead sheds, deadline fires) -------------
  {
    const harness = createHarness({
      operations,
      executors: new Map([
        [
          PETSTORE_EXECUTOR,
          { execute: () => new Promise<OperationResult>(() => {}) } as OperationExecutor,
        ],
      ]),
      bulkheads: { default: { concurrency: 2, queueSize: 3 } },
      deadlineMs: 150,
    });
    const outcomes = await drive(10, 10, () => harness.call(primary));
    const codes = tally(outcomes);
    // Nothing may hang: every call is either shed or timed out.
    const accounted = (codes['QUEUE_FULL'] ?? 0) + (codes['TIMEOUT'] ?? 0);
    layers.push({
      layer: 'slow-upstream',
      ok: accounted === 10 && (codes['QUEUE_FULL'] ?? 0) > 0 && (codes['TIMEOUT'] ?? 0) > 0,
      detail: { codes },
    });
  }

  // ---- Layer: partial failure (breaker opens by baseUrl prefix) ----------
  {
    // Assignment rule 2: a breaker whose baseUrl prefixes the operation's.
    // This is the branch the synthetic scenarios never exercise, because
    // hand-built operations carry no baseUrl.
    const baseUrl = (operations[0]?.executor?.config as { baseUrl?: string } | undefined)
      ?.baseUrl;

    const harness = createHarness({
      operations,
      executors: new Map([[PETSTORE_EXECUTOR, failingExecutor()]]),
      breakers: {
        default: {
          failureThreshold: 100,
          failureWindowMs: 10_000,
          cooldownMs: 50,
          halfOpenProbes: 1,
        },
        ...(baseUrl === undefined
          ? {}
          : {
              petstore: {
                failureThreshold: 3,
                failureWindowMs: 10_000,
                cooldownMs: 50,
                halfOpenProbes: 1,
                baseUrl,
              },
            }),
      },
    });

    const outcomes = await drive(12, 1, () => harness.call(primary));
    const codes = tally(outcomes);
    const stats = harness.transport.breakerStats?.() ?? [];
    const petstoreBreaker = stats.find((s) => s.name === 'petstore');

    layers.push({
      layer: 'partial-failure',
      // The breaker must have opened, and it must be the baseUrl-derived one
      // rather than `default` — otherwise assignment fell through and the
      // isolation is not there even though calls still fail.
      ok:
        baseUrl !== undefined &&
        petstoreBreaker?.state === 'open' &&
        (codes['UPSTREAM_UNAVAILABLE'] ?? 0) > 0,
      detail: {
        baseUrl,
        codes,
        breakers: stats.map((s) => ({ name: s.name, state: s.state })),
      },
    });
  }

  // ---- Layer: shutdown under load ---------------------------------------
  {
    const gate = gatedExecutor();
    const harness = createHarness({
      operations,
      executors: new Map([[PETSTORE_EXECUTOR, gate.executor]]),
    });

    const inFlight = Promise.all([harness.call(primary), harness.call(primary)]);
    // Let both reach the executor before shutting down.
    while (gate.entered() < 2) await new Promise((r) => setImmediate(r));

    const closing = harness.transport.close();
    // §8.7: readiness is cached state, so this reads what a /health/ready
    // probe would return at this instant — sampled DURING the drain, which is
    // the only moment the claim is about.
    const readyDuringDrain = harness.transport.readiness().ready;
    const rejected = await harness.call(primary);

    gate.release();
    const completed = await inFlight;
    await closing;

    layers.push({
      layer: 'shutdown-under-load',
      ok:
        readyDuringDrain === false &&
        rejected.isError &&
        completed.every((o) => !o.isError),
      detail: {
        readyDuringDrain,
        rejectedCode: rejected.code,
        inFlightCompleted: completed.filter((o) => !o.isError).length,
      },
    });
  }

  // ---- Layer: reload under load -----------------------------------------
  {
    const gate = gatedExecutor();
    const harness = createHarness({
      operations,
      executors: new Map([[PETSTORE_EXECUTOR, gate.executor]]),
    });

    const before = harness.registry.current();
    const call = harness.call(primary);
    while (gate.entered() < 1) await new Promise((r) => setImmediate(r));

    // Two overlapping swaps while the call is in flight.
    harness.swap(operations, 2);
    const after = harness.swap(operations, 3);

    gate.release();
    const outcome = await call;

    layers.push({
      layer: 'reload-under-load',
      ok: !outcome.isError && before.hash !== undefined && after.hash !== undefined,
      detail: {
        completed: !outcome.isError,
        versionBefore: before.version,
        versionAfter: after.version,
      },
    });
  }

  // ---- Layer: chaos ------------------------------------------------------
  {
    const permitted = new Set([
      'UPSTREAM_UNAVAILABLE',
      'INTERNAL_ERROR',
      'TIMEOUT',
      'QUEUE_FULL',
      'CIRCUIT_OPEN',
      'CANCELLED',
    ]);
    // Seeded so a failure reproduces exactly.
    let seed = 20260823;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const harness = createHarness({
      operations,
      executors: new Map([
        [
          PETSTORE_EXECUTOR,
          {
            execute: async (): Promise<OperationResult> => {
              const roll = random();
              if (roll < 0.3) throw new Error('petstore executor died: secret-token-abc');
              if (roll < 0.6) {
                return {
                  ok: false,
                  error: { code: 'UPSTREAM_UNAVAILABLE', message: 'partitioned' },
                };
              }
              return { ok: true, value: {} };
            },
          } as OperationExecutor,
        ],
      ]),
    });

    const outcomes = await drive(60, 8, (i) => harness.call(ids[i % ids.length] as string));
    const codes = tally(outcomes);
    const unexpected = Object.keys(codes).filter((c) => c !== 'success' && !permitted.has(c));
    // A thrown executor must not leak its message through INTERNAL_ERROR.
    const leaked = outcomes.filter((o) => o.message?.includes('secret-token-abc'));

    layers.push({
      layer: 'chaos',
      ok: unexpected.length === 0 && leaked.length === 0,
      detail: { codes, unexpected, leaked: leaked.length },
    });
  }

  return {
    operationIds: ids,
    layers,
    allGreen: layers.every((l) => l.ok),
  };
}
