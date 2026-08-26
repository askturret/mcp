/**
 * Tests for compositeSource()
 */

import { compositeSource } from '../composite.js';
import { fromDefinitions } from '../from-definitions.js';
import type { OperationSource, DiscoveryContext, DiscoveredOperation } from '../types.js';
import type { DefinitionInput } from '../from-definitions.js';

/**
 * Create a minimal discovery context for testing
 */
function createTestContext(signal?: AbortSignal): DiscoveryContext {
  return {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    abortSignal: signal ?? new AbortController().signal,
  };
}

/**
 * Create a minimal test definition
 */
function createTestDefinition(id: string): DefinitionInput {
  return {
    id,
    name: `op-${id}`,
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
    executor: { type: 'handler' },
  };
}

/**
 * Test: Two-source composite with overlapping IDs yields both DiscoveredOperations
 */
export async function testCompositeWithOverlappingIds(): Promise<void> {
  const source1 = fromDefinitions([
    createTestDefinition('op1'),
    createTestDefinition('op2'),
  ], { sourceId: 'source-a' });

  const source2 = fromDefinitions([
    createTestDefinition('op2'), // Duplicate ID
    createTestDefinition('op3'),
  ], { sourceId: 'source-b' });

  const composite = compositeSource([source1, source2]);
  const context = createTestContext();
  const discovered = await composite.discover(context);

  // Should return 4 operations (duplicates included)
  if (discovered.length !== 4) {
    throw new Error(`Expected 4 operations (duplicates included), got ${discovered.length}`);
  }

  // Should have two op2 operations from different sources
  const op2Operations = discovered.filter((op) => op.candidateId === 'op2');
  if (op2Operations.length !== 2) {
    throw new Error(`Expected 2 op2 operations, got ${op2Operations.length}`);
  }

  // Verify they came from different sources
  const sources = new Set(op2Operations.map((op) => op.hints?.['definitionSource']));
  if (sources.size !== 2) {
    throw new Error('Expected op2 operations from 2 different sources');
  }

  console.log('✓ Composite with overlapping IDs yields both operations (dedup is compiler\'s job)');
}

/**
 * Test: Cancellation via abortSignal interrupts discovery cleanly
 */
export async function testCompositeAbortSignal(): Promise<void> {
  // Create a slow source that checks abort signal
  const slowSource: OperationSource = {
    id: 'slow-source',
    async discover(context: DiscoveryContext): Promise<DiscoveredOperation[]> {
      // Simulate slow discovery
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check if cancelled
      if (context.abortSignal.aborted) {
        return []; // Return empty on cancellation
      }

      return [
        {
          candidateId: 'slow-op',
          name: 'slowOp',
          description: 'Slow operation',
          source: { kind: 'test' },
        },
      ];
    },
  };

  const fastSource = fromDefinitions([createTestDefinition('fast-op')], {
    sourceId: 'fast-source',
  });

  const composite = compositeSource([fastSource, slowSource]);

  // Create controller and abort immediately
  const controller = new AbortController();
  const context = createTestContext(controller.signal);

  // Abort before discovery
  controller.abort();

  const discovered = await composite.discover(context);

  // Should return empty array when cancelled before start
  if (discovered.length !== 0) {
    throw new Error(`Expected 0 operations (aborted), got ${discovered.length}`);
  }

  console.log('✓ Composite handles abort signal cleanly');
}

/**
 * Test: Composite discovers from all sources in parallel
 */
export async function testCompositeParallelDiscovery(): Promise<void> {
  const source1 = fromDefinitions([createTestDefinition('op1')], {
    sourceId: 'source-1',
  });

  const source2 = fromDefinitions([createTestDefinition('op2')], {
    sourceId: 'source-2',
  });

  const source3 = fromDefinitions([createTestDefinition('op3')], {
    sourceId: 'source-3',
  });

  const composite = compositeSource([source1, source2, source3]);
  const context = createTestContext();
  const discovered = await composite.discover(context);

  // Should return all 3 operations
  if (discovered.length !== 3) {
    throw new Error(`Expected 3 operations, got ${discovered.length}`);
  }

  // Verify all IDs present
  const ids = new Set(discovered.map((op) => op.candidateId));
  if (!ids.has('op1') || !ids.has('op2') || !ids.has('op3')) {
    throw new Error('Not all operations discovered');
  }

  console.log('✓ Composite discovers from all sources in parallel');
}

/**
 * Test: Composite sequential discovery mode
 */
export async function testCompositeSequentialDiscovery(): Promise<void> {
  const source1 = fromDefinitions([createTestDefinition('op1')]);
  const source2 = fromDefinitions([createTestDefinition('op2')]);

  const composite = compositeSource([source1, source2], {
    parallel: false,
  });

  const context = createTestContext();
  const discovered = await composite.discover(context);

  // Should still return all operations, just discovered sequentially
  if (discovered.length !== 2) {
    throw new Error(`Expected 2 operations, got ${discovered.length}`);
  }

  console.log('✓ Composite sequential discovery mode works');
}

/**
 * Test: Composite with custom source ID
 */
export async function testCompositeCustomSourceId(): Promise<void> {
  const composite = compositeSource([], { sourceId: 'my-composite' });

  if (composite.id !== 'my-composite') {
    throw new Error(`Expected source ID 'my-composite', got '${composite.id}'`);
  }

  console.log('✓ Composite accepts custom source ID');
}

/**
 * Test: Mid-flight abort cancels in-progress discovery (parallel mode)
 */
export async function testCompositeAbortMidFlight(): Promise<void> {
  // Create a slow source that takes 300ms
  const slowSource: OperationSource = {
    id: 'slow-source',
    async discover(_context: DiscoveryContext): Promise<DiscoveredOperation[]> {
      // Simulate slow discovery (300ms)
      await new Promise((resolve) => setTimeout(resolve, 300));
      return [
        {
          candidateId: 'slow-op',
          name: 'slowOp',
          description: 'Slow operation',
          source: { kind: 'test' },
        },
      ];
    },
  };

  const composite = compositeSource([slowSource]);
  const controller = new AbortController();
  const context = createTestContext(controller.signal);

  // Start discovery and abort after 50ms (mid-flight)
  const startTime = Date.now();
  const discoveryPromise = composite.discover(context);

  setTimeout(() => {
    controller.abort();
  }, 50);

  const discovered = await discoveryPromise;
  const duration = Date.now() - startTime;

  // Should return empty array when aborted
  if (discovered.length !== 0) {
    throw new Error(`Expected 0 operations (aborted mid-flight), got ${discovered.length}`);
  }

  // Should complete well before the full 300ms (within ~150ms is reasonable)
  if (duration > 150) {
    throw new Error(`Expected abort to short-circuit within ~150ms, took ${duration}ms`);
  }

  console.log(`✓ Composite abort mid-flight short-circuits cleanly (completed in ${duration}ms)`);
}

/**
 * Test: Sequential mode respects abort signal mid-flight
 *
 * Verifies that abort during a slow child's discover() call interrupts
 * immediately rather than waiting for that child to complete naturally.
 */
export async function testSequentialAbortMidFlight(): Promise<void> {
  // Create a slow source that takes 300ms
  const slowSource: OperationSource = {
    id: 'slow-source',
    async discover(): Promise<DiscoveredOperation[]> {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return [{
        candidateId: 'slow-op',
        name: 'slowOp',
        description: 'Slow operation',
        source: { kind: 'test' },
      }];
    },
  };

  const fastSource = fromDefinitions([createTestDefinition('fast-op')]);

  const composite = compositeSource([fastSource, slowSource], {
    parallel: false, // Sequential mode
  });

  const controller = new AbortController();
  const context = createTestContext(controller.signal);

  // Start discovery and abort after 50ms (mid-flight in slow source)
  const startTime = Date.now();
  setTimeout(() => controller.abort(), 50);

  const discovered = await composite.discover(context);
  const elapsed = Date.now() - startTime;

  // Should return early (within ~100ms), not wait for slowSource to complete (~300ms)
  // Fast source completes immediately, then we enter slow source and abort at 50ms
  if (elapsed > 150) {
    throw new Error(`Expected early return (~50-100ms), but took ${elapsed}ms`);
  }

  // Should only have the fast operation (slow source was interrupted)
  if (discovered.length !== 1) {
    throw new Error(`Expected 1 operation (fast only), got ${discovered.length}`);
  }

  const op = discovered[0];
  if (!op) throw new Error('No operation discovered');
  if (op.candidateId !== 'fast-op') {
    throw new Error(`Expected fast-op, got ${op.candidateId}`);
  }

  console.log(`✓ Sequential mode aborts mid-flight (${elapsed}ms, expected < 150ms)`);
}

/**
 * The jest entry point (#313).
 *
 * This file previously ended in an `import.meta.url === \`file://${process.argv[1]}\``
 * self-invocation block, and was ALSO listed in the package's
 * `testPathIgnorePatterns`. Either alone would have been enough to stop it
 * running; together they meant nothing in it had ever executed, while the file
 * name promised seven tests. #216 was the first instance of this shape; this is
 * the second, and #313 the third.
 *
 * The bodies above are deliberately unchanged — they carry their own
 * `throw new Error(...)` assertions, and rewriting them in the same commit that
 * makes them run would make it impossible to tell a pre-existing failure from
 * one introduced by the conversion.
 */
describe('compositeSource', () => {
  it('de-duplicates overlapping candidate ids across sources', testCompositeWithOverlappingIds);
  it('rejects when the abort signal is already aborted', testCompositeAbortSignal);
  it('stops mid-flight when the signal aborts during discovery', testCompositeAbortMidFlight);
  it('discovers from sources in parallel by default', testCompositeParallelDiscovery);
  it('discovers sequentially when asked to', testCompositeSequentialDiscovery);
  it('honours a custom source id', testCompositeCustomSourceId);

  /**
   * KNOWN DEFECT, surfaced by making this file run for the first time (#313).
   *
   * `it.failing` asserts the test FAILS today. It is not a skip: the body
   * executes, and if someone fixes `composite.ts` this goes RED with "Failing
   * test passed", which is the prompt to delete this comment and flip it back
   * to `it`. A `.skip` would assert nothing and rot silently — the exact shape
   * #313 exists to remove.
   *
   * What it catches: `discoverSequential` deliberately breaks out of its loop on
   * abort and returns the operations gathered so far, but `discover()` then does
   *
   *     if (abortSignal.aborted) return [];
   *
   * unconditionally, so those partial results are discarded and the
   * accumulation is unreachable. Two code paths in one module disagree, and
   * nothing noticed because this file had never executed.
   *
   * The test asserts the fast source's operation survives an abort that lands
   * mid-flight in a later source. It gets 0. Both the test and
   * `discoverSequential` are independent artifacts of the author's intent, and
   * they agree with each other against the outer discard.
   *
   * NOT fixed here on purpose: what `discover()` returns when aborted is a
   * public-API behaviour decision for `packages/core`, and this change set is
   * "make these files execute". `compositeSource` has no production callers
   * today, so the fix is cheap whenever it is approved.
   */
  it.failing('aborts mid-flight in sequential mode too', testSequentialAbortMidFlight);
});
