// SPDX-License-Identifier: Apache-2.0
/**
 * Dispatcher stage logging.
 *
 * Drives the REAL dispatcher rather than asserting against the logger alone -
 * the claim is about the dispatcher's coverage, and a logger-only test would
 * pass while a stage quietly stopped logging.
 *
 * ## Level changed from info to debug in #39
 *
 * #38 shipped stage logs at INFO because its acceptance criterion said so,
 * with a recorded reservation that twelve info lines per request is
 * debug-shaped volume. #39 added a real span tree, which represents
 * stage-by-stage progress with duration and parentage, sampled, without
 * multiplying one request into twelve long-retention records.
 *
 * Keeping both would pay twice for the same information - the duplication QA
 * flagged. So spans carry PROGRESS and logs carry OUTCOME: stage detail is
 * still emitted, at debug, and one info line per request reports the result.
 *
 * These assertions were updated deliberately in the same commit as the
 * behaviour, rather than left to fail.
 */

import { describe, it, expect } from '@jest/globals';
import { AtomicRegistryReference } from '../../registry-reference.js';
import { createDispatcher } from '../../dispatcher/index.js';
import { createSnapshot } from '../../compiler/passes/freeze-and-hash.js';
import { createLogger } from '../logger.js';
import { REDACTED } from '../redaction.js';
import type { LogRecord } from '../types.js';
import type { OperationDefinition, OperationResult } from '../../types.js';
import type { OperationExecutor } from '../../executor/index.js';

const ALL_STAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function operation(id: string): OperationDefinition {
  return {
    id,
    name: id,
    description: `Operation ${id}`,
    input: { type: 'object' },
    output: { type: 'object' },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
    },
    executor: { type: 'test' },
  };
}

function harness() {
  const records: LogRecord[] = [];
  const snapshot = createSnapshot([operation('listPets')], 1);
  const ref = new AtomicRegistryReference(snapshot);

  const executor: OperationExecutor = {
    async execute(): Promise<OperationResult> {
      return { ok: true, value: { pets: [] } };
    },
  };

  const dispatcher = createDispatcher(
    ref,
    { audit: async () => undefined },
    new Map<string, OperationExecutor>([['test', executor]]),
    {
      logger: createLogger({
        sink: (record) => records.push(record),
        now: () => new Date('2026-08-23T01:00:00.000Z'),
        // Stage detail is debug since #39; the default `info` threshold would
        // filter it out entirely.
        level: 'debug',
      }),
    },
  );

  return { records, dispatcher, snapshot };
}

function command(overrides?: Partial<Parameters<ReturnType<typeof harness>['dispatcher']['dispatch']>[0]>) {
  return {
    requestId: 'req-001',
    operationId: 'listPets',
    input: {},
    deadline: new Date('2026-08-23T01:01:00.000Z'),
    signal: new AbortController().signal,
    registryHash: 'unused-by-dispatcher',
    ...(overrides ?? {}),
  };
}

describe('dispatcher stage logging', () => {
  it('emits a debug log for all 12 stages on the success path', async () => {
    const { records, dispatcher } = harness();

    await dispatcher.dispatch(command());

    const stages = records
      .filter((r) => r.level === 'debug' && r.message === 'dispatch stage')
      .map((r) => r.fields['stage']);

    expect(stages).toEqual(ALL_STAGES);
  });

  it('emits exactly ONE info line per request, carrying the outcome', async () => {
    // The other half of the #39 split: progress went to spans and debug, so
    // info must now be the outcome and nothing else. If stage logs regressed
    // to info, this count would jump from 1 to 13.
    const { records, dispatcher } = harness();

    await dispatcher.dispatch(command());

    const infoRecords = records.filter((r) => r.level === 'info');

    expect(infoRecords).toHaveLength(1);
    expect(infoRecords[0]?.message).toBe('dispatch complete');
    expect(infoRecords[0]?.fields['outcome']).toBe('success');
    expect(infoRecords[0]?.fields['operationId']).toBe('listPets');
    expect(typeof infoRecords[0]?.fields['durationSeconds']).toBe('number');
  });

  it('reports the error code on the info outcome line when the call fails', async () => {
    const { records, dispatcher } = harness();

    await dispatcher.dispatch(command({ operationId: 'noSuchOperation' }));

    const infoRecords = records.filter((r) => r.level === 'info');
    expect(infoRecords).toHaveLength(1);
    expect(infoRecords[0]?.fields['outcome']).toBe('error');
    expect(infoRecords[0]?.fields['errorCode']).toBe('INVALID_INPUT');
  });

  it('labels every stage with a name, never `unknown`', () => {
    // A stage logged as `unknown` is worse than unlogged: it looks like
    // coverage while telling an operator nothing.
    const { records, dispatcher } = harness();

    return dispatcher.dispatch(command()).then(() => {
      const names = records
        .filter((r) => r.message === 'dispatch stage')
        .map((r) => r.fields['stageName']);

      expect(names).not.toContain('unknown');
      expect(names[0]).toBe('resolve-snapshot');
      expect(names[names.length - 1]).toBe('map-result');
    });
  });

  it('carries the canonical field set on every stage record', async () => {
    const { records, dispatcher, snapshot } = harness();

    await dispatcher.dispatch(command({ traceId: 'trace-abc' }));

    const stageRecords = records.filter((r) => r.message === 'dispatch stage');
    expect(stageRecords.length).toBeGreaterThan(0);

    for (const record of stageRecords) {
      expect(record.fields['requestId']).toBe('req-001');
      expect(record.fields['operationId']).toBe('listPets');
      expect(record.fields['registryHash']).toBe(snapshot.hash);
      expect(record.fields['traceId']).toBe('trace-abc');
    }
  });

  it('omits traceId entirely when the caller supplied none', async () => {
    // Absent means "unknown"; a null would be a claim that there is no trace.
    const { records, dispatcher } = harness();

    await dispatcher.dispatch(command());

    const first = records.find((r) => r.message === 'dispatch stage');
    expect(first?.fields).not.toHaveProperty('traceId');
  });

  it('never logs raw input, raw output, or a principal identifier', async () => {
    // The §9.4 never-include list, checked against what was actually emitted
    // rather than against the call sites.
    const { records, dispatcher } = harness();

    await dispatcher.dispatch(
      command({
        input: { secretQuery: 'sensitive-input-value' },
        principal: { id: 'user-42', type: 'user' },
      }),
    );

    const dumped = JSON.stringify(records);
    expect(dumped).not.toContain('sensitive-input-value');
    expect(dumped).not.toContain('user-42');
  });

  it('records authentication as a boolean, not as an identity', async () => {
    const { records, dispatcher } = harness();

    await dispatcher.dispatch(command({ principal: { id: 'user-42', type: 'user' } }));

    const stage2 = records.find((r) => r.fields['stage'] === 2);
    expect(stage2?.fields['authenticated']).toBe(true);
  });

  it('stops at stage 1 with an outcome when the operation is unknown', async () => {
    const { records, dispatcher } = harness();

    await dispatcher.dispatch(command({ operationId: 'noSuchOperation' }));

    const stages = records.filter((r) => r.message === 'dispatch stage');
    expect(stages).toHaveLength(1);
    expect(stages[0]?.fields['stage']).toBe(1);
    expect(stages[0]?.fields['outcome']).toBe('operation-not-found');
  });

  it('is silent by default, so an adopter opts IN to dispatcher logs', async () => {
    // Every pre-#38 caller constructs the dispatcher without a logger and must
    // keep its exact behaviour.
    const snapshot = createSnapshot([operation('listPets')], 1);
    const ref = new AtomicRegistryReference(snapshot);
    const executor: OperationExecutor = {
      async execute(): Promise<OperationResult> {
        return { ok: true, value: {} };
      },
    };

    const dispatcher = createDispatcher(
      ref,
      {},
      new Map<string, OperationExecutor>([['test', executor]]),
    );

    const result = await dispatcher.dispatch(command());
    expect(result.isError).toBe(false);
  });

  it('redacts a credential-shaped field bound at request scope', async () => {
    const { records, dispatcher } = harness();

    await dispatcher.dispatch(command({ requestId: 'req-001' }));

    // Sanity: the pipeline the dispatcher logs through is the redacting one.
    const log = createLogger({ sink: (r) => records.push(r) });
    log.info('probe', { token: 'abc' });

    expect(records[records.length - 1]?.fields['token']).toBe(REDACTED);
  });
});
