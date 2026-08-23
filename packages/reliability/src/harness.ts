// SPDX-License-Identifier: Apache-2.0
/**
 * The rig every reliability scenario drives (§12.1, §17 criterion 10).
 *
 * ## Why this is in-process rather than k6 or autocannon
 *
 * §51 suggests a load generator. Those drive HTTP at a deployed server, which
 * answers "does the process survive traffic" — a real question, and one the
 * nightly job can still answer by pointing at a running instance.
 *
 * It is not the question this suite is FOR. The unit suites already prove
 * each primitive in isolation; what is untested is how they behave TOGETHER —
 * a reload landing mid-drain, a bulkhead rejection reaching a breaker, a
 * retry holding its slot. Those interactions live inside the dispatcher, and
 * an external load tool can only observe their consequences at the wire,
 * where a wrong answer and a right answer often look identical.
 *
 * Driving the real transport and the real dispatcher in-process lets a
 * scenario assert on the thing that actually matters — which snapshot a call
 * ran against, whether a permit was released, which error code came back —
 * and adds no dependency to a repository that has so far added none.
 */

import {
  AtomicRegistryReference,
  createSnapshot,
  type BreakersConfig,
  type BulkheadsConfig,
  type MetricName,
  type OperationDefinition,
  type OperationExecutor,
  type OperationResult,
  type RegistrySnapshot,
  type RetryConfig,
  createRecordingMetricRecorder,
  noopTracer,
} from '@askturret/mcp-core';
import { createHttpTransport } from '@askturret/mcp-transports';

/**
 * Scale knobs.
 *
 * §51 asks for 100 req/s over ten minutes. That cannot run on a pull
 * request, and §51 says so itself — load and chaos run on merge, not per PR.
 * So every scenario takes its size from here: small enough that the whole
 * suite is a normal test run, and scalable to the stated figures by
 * environment variable for the nightly job.
 *
 * The SHAPE of each scenario is identical at both sizes. Only the counts
 * change — which is the property that makes the small run meaningful rather
 * than a different test wearing the same name.
 */
export interface ReliabilityScale {
  /** Concurrent callers in load scenarios. */
  readonly concurrency: number;
  /** Total calls issued in load scenarios. */
  readonly totalCalls: number;
  /** Rounds of random fault injection in the chaos scenario. */
  readonly chaosRounds: number;
}

export const PR_SCALE: ReliabilityScale = {
  concurrency: 25,
  totalCalls: 200,
  chaosRounds: 120,
};

export const NIGHTLY_SCALE: ReliabilityScale = {
  concurrency: 100,
  totalCalls: 60_000,
  chaosRounds: 5_000,
};

export function scaleFromEnv(env: NodeJS.ProcessEnv = process.env): ReliabilityScale {
  const base = env['RELIABILITY_SCALE'] === 'nightly' ? NIGHTLY_SCALE : PR_SCALE;

  return {
    concurrency: positive(env['RELIABILITY_CONCURRENCY'], base.concurrency),
    totalCalls: positive(env['RELIABILITY_CALLS'], base.totalCalls),
    chaosRounds: positive(env['RELIABILITY_CHAOS_ROUNDS'], base.chaosRounds),
  };
}

function positive(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** An operation whose effects can be varied per scenario. */
export function operation(
  id: string,
  overrides: Partial<OperationDefinition['effects']> = {},
  executorType = 'test',
  annotations?: Readonly<Record<string, unknown>>,
): OperationDefinition {
  return {
    id,
    name: id,
    description: id,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: false,
      idempotencyKeyRequired: false,
      classifications: [],
      ...overrides,
    },
    executor: { type: executorType },
    ...(annotations === undefined ? {} : { annotations }),
  };
}

export interface HarnessOptions {
  readonly operations: readonly OperationDefinition[];
  readonly executors: Map<string, OperationExecutor>;
  readonly bulkheads?: BulkheadsConfig;
  readonly breakers?: BreakersConfig;
  readonly retry?: RetryConfig;
  readonly auditSink?: Parameters<typeof createHttpTransport>[0]['auditSink'];
  readonly flushAudit?: () => Promise<void>;
}

export interface Harness {
  readonly transport: ReturnType<typeof createHttpTransport>;
  readonly registry: AtomicRegistryReference;
  readonly metrics: ReturnType<typeof createRecordingMetricRecorder>;
  /** One tools/call through the REAL transport handler. */
  call(operationId: string, id?: string): Promise<CallOutcome>;
  /** Publish a new snapshot, as a reload would. */
  swap(operations: readonly OperationDefinition[], version: number): RegistrySnapshot;
  samples(metric: MetricName): ReturnType<
    ReturnType<typeof createRecordingMetricRecorder>['forMetric']
  >;
}

export interface CallOutcome {
  readonly status: number;
  readonly isError: boolean;
  /** The typed error code, when the call failed. */
  readonly code?: string;
  readonly message?: string;
  /** Parsed JSON-RPC body, for assertions that need the payload. */
  readonly body: unknown;
}

class MockRequest {
  headers: Record<string, string> = { host: 'localhost' };
  method = 'POST';
  url = '/mcp';
  private chunks: Buffer[] = [];

  setBody(body: string): void {
    this.chunks = [Buffer.from(body, 'utf-8')];
  }

  on(event: string, handler: (data?: unknown) => void): void {
    if (event === 'data') this.chunks.forEach((chunk) => handler(chunk));
    else if (event === 'end') handler();
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';

  writeHead(statusCode: number, headers: Record<string, string>): void {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(body?: string): void {
    if (body !== undefined) this.body += body;
  }

  write(data: string): void {
    this.body += data;
  }
}

export function createHarness(options: HarnessOptions): Harness {
  const metrics = createRecordingMetricRecorder();
  const registry = new AtomicRegistryReference(
    createSnapshot([...options.operations], 1),
  );

  const transport = createHttpTransport({
    registry,
    basePath: '/mcp',
    executors: options.executors,
    observability: { metrics, tracer: noopTracer },
    ...(options.bulkheads === undefined ? {} : { bulkheads: options.bulkheads }),
    ...(options.breakers === undefined ? {} : { breakers: options.breakers }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(options.auditSink === undefined ? {} : { auditSink: options.auditSink }),
    ...(options.flushAudit === undefined ? {} : { flushAudit: options.flushAudit }),
  } as Parameters<typeof createHttpTransport>[0]);

  let sequence = 0;

  return {
    transport,
    registry,
    metrics,

    async call(operationId: string, id?: string): Promise<CallOutcome> {
      const request = new MockRequest();
      const response = new MockResponse();
      sequence += 1;

      request.setBody(
        JSON.stringify({
          jsonrpc: '2.0',
          id: id ?? `req-${sequence}`,
          method: 'tools/call',
          params: { name: operationId, arguments: {} },
        }),
      );

      await transport.handler()(request as never, response as never);

      let body: unknown;
      try {
        body = JSON.parse(response.body);
      } catch {
        body = response.body;
      }

      const error = (body as { error?: { code?: string; message?: string } } | null)?.error;

      return {
        status: response.statusCode,
        isError: error !== undefined,
        ...(error?.code === undefined ? {} : { code: error.code }),
        ...(error?.message === undefined ? {} : { message: error.message }),
        body,
      };
    },

    swap(operations, version) {
      const next = createSnapshot([...operations], version);
      registry.swap(next);
      return next;
    },

    samples: (metric) => metrics.forMetric(metric),
  };
}

/**
 * Drive `total` calls with at most `concurrency` in flight.
 *
 * A bounded worker pool rather than `Promise.all` over the whole set: firing
 * every call at once measures how fast promises can be created, not how the
 * server behaves under sustained pressure, and it makes bulkhead queue depth
 * a function of the test harness rather than of the configuration under test.
 */
export async function drive(
  total: number,
  concurrency: number,
  issue: (index: number) => Promise<CallOutcome>,
): Promise<CallOutcome[]> {
  const results: CallOutcome[] = new Array<CallOutcome>(total);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= total) return;
      results[index] = await issue(index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );

  return results;
}

/** Count outcomes by typed error code, with successes under `success`. */
export function tally(outcomes: readonly CallOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    const key = outcome.isError ? (outcome.code ?? 'UNKNOWN') : 'success';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Executor that resolves only when the returned gate is released. */
export function gatedExecutor(result: OperationResult = { ok: true, value: {} }): {
  executor: OperationExecutor;
  release: () => void;
  entered: () => number;
  inFlight: () => number;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  let finished = 0;

  return {
    executor: {
      execute: async () => {
        entered += 1;
        await gate;
        finished += 1;
        return result;
      },
    },
    release,
    entered: () => entered,
    inFlight: () => entered - finished,
  };
}
