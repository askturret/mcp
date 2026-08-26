// SPDX-License-Identifier: Apache-2.0
/**
 * Composite source - combines multiple sources
 *
 * Implements Composite pattern for OperationSource.
 * Discovers from all child sources and concatenates results.
 * Conflict resolution (duplicate IDs) is the compiler's job, not the source's.
 */

import type {
  OperationSource,
  DiscoveredOperation,
  DiscoveryContext,
} from './types.js';

/**
 * Composite source options.
 */
export interface CompositeSourceOptions {
  /**
   * Source ID (defaults to 'composite').
   */
  sourceId?: string;

  /**
   * Whether to run child sources in parallel (default: true).
   * Set to false for sequential discovery (useful for debugging).
   */
  parallel?: boolean;
}

/** The one abort signal this module raises, so the catch can key on its TYPE. */
const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');

/**
 * Is this the abort signal, as opposed to a real failure?
 *
 * Deliberately NOT `error.message === 'Aborted'`. That test converted any child
 * source throwing `new Error('Aborted')` into a successful empty discovery, and
 * `compatibility-policy.md` rules error wording uncovered: "Do not parse them."
 */
const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

/**
 * Create a composite source that combines multiple sources.
 *
 * Discovers from all child sources and concatenates results.
 * Duplicates are fine - compiler handles conflict resolution.
 *
 * ## Abort contract (#340)
 *
 * **An aborted `discover()` RESOLVES with `[]`. It does not reject, and it does
 * not return partial results.** That holds for every mode and every timing:
 * already-aborted before starting, aborted mid-flight in parallel, aborted
 * mid-flight in sequential.
 *
 * `[]` rather than a partial set is deliberate. A partial discovery would feed
 * the compiler and then the registry snapshot hash — a covered surface that
 * identifies what a call was made against — minting a valid-looking, silently
 * incomplete registry. `[]` is unmistakably empty; partial is plausible, and
 * plausible-but-incomplete is the failure this codebase exists to refuse.
 *
 * `[]` rather than a throw is also deliberate, and the reason is the interface
 * rather than this function: `OperationSource` is the covered surface, and
 * `fromOpenApi` already resolves `[]` on abort. Throwing here would move the
 * inconsistency from inside one function to across implementations of one
 * interface, where a caller holding an `OperationSource` could not tell which
 * behaviour it had.
 *
 * @param sources - Array of child sources to combine
 * @param options - Optional composite configuration
 * @returns OperationSource that emits from all children
 *
 * @example
 * ```ts
 * const source = compositeSource([
 *   fromOpenApi(apiDoc),
 *   fromDefinitions(customOps),
 * ]);
 * ```
 */
export function compositeSource(
  sources: readonly OperationSource[],
  options: CompositeSourceOptions = {},
): OperationSource {
  const sourceId = options.sourceId ?? 'composite';
  const parallel = options.parallel ?? true;

  return {
    id: sourceId,

    async discover(context: DiscoveryContext): Promise<DiscoveredOperation[]> {
      const { logger, abortSignal } = context;

      try {
        // ONE ABORT EXIT (#340). Every path that detects abort THROWS an
        // AbortError, and the single catch below is the only place it becomes
        // `[]`. Before this the three paths returned `[]` independently and
        // merely happened to agree, which is what let a dead partial-result
        // accumulation survive unnoticed one frame away.
        if (abortSignal.aborted) {
          logger.debug('Composite discovery cancelled before start');
          throw abortError();
        }

        logger.debug(`Composite source discovering from ${sources.length} child sources`, {
          sourceId,
          childCount: sources.length,
          parallel,
        });

        // Discover from all sources with abort signal support
        const results = parallel
          ? await Promise.race([
              Promise.all(sources.map((s) => s.discover(context))),
              new Promise<never>((_, reject) => {
                // No pre-check here: the guard above already returned for an
                // already-aborted signal, so a synchronous reject would be
                // unreachable — the same dead-branch shape #340 is fixing.
                abortSignal.addEventListener('abort', () => {
                  logger.debug('Composite discovery aborted mid-flight');
                  reject(abortError());
                }, { once: true });
              }),
            ])
          : await discoverSequential(sources, context);

        // Reachable, and not redundant: `Promise.race` resolves if the children
        // settle in the same tick the signal fires, so this covers the ordering
        // where discovery completed but the caller has already given up.
        if (abortSignal.aborted) {
          logger.debug('Composite discovery cancelled after child discovery');
          throw abortError();
        }

        // Flatten results
        const allOperations = results.flat();

        logger.info(`Composite source discovered ${allOperations.length} operations`, {
          sourceId,
          operationCount: allOperations.length,
          childSources: sources.map((s) => s.id),
        });

        return allOperations;
      } catch (error) {
        // The single abort exit. Keyed on the error TYPE, never on its message:
        // this previously read `error.message === 'Aborted'`, so a child source
        // throwing `new Error('Aborted')` for any unrelated reason was swallowed
        // and returned as a SUCCESSFUL EMPTY DISCOVERY. A real failure became a
        // clean result — and compatibility-policy.md forbids parsing our own
        // error messages precisely because their wording is not covered.
        if (isAbortError(error)) {
          logger.debug('Composite discovery aborted', { sourceId });
          return [];
        }

        logger.error('Composite source discovery failed', {
          sourceId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

/**
 * Discover from sources sequentially.
 * Used when parallel=false in options.
 *
 * Returns only a COMPLETE set. On abort it throws rather than returning what it
 * gathered so far (#340).
 *
 * It used to `break` and return the partial set, which read as "preserve
 * partial work" — but `discover()` discarded it one frame up, so the
 * accumulation was unreachable. Nobody could observe it, and the two frames
 * disagreed about what abort meant. Throwing removes that reading entirely:
 * this function now leaves on abort exactly the way the parallel path does, as
 * a rejection, and `discover()`'s single catch decides what abort means for
 * both.
 */
async function discoverSequential(
  sources: readonly OperationSource[],
  context: DiscoveryContext,
): Promise<DiscoveredOperation[][]> {
  const results: DiscoveredOperation[][] = [];

  for (const source of sources) {
    // Check cancellation between sources
    if (context.abortSignal.aborted) {
      context.logger.debug('Sequential discovery cancelled mid-flight');
      throw abortError();
    }

    // Race the discover call against abort signal
    // This ensures we can interrupt mid-flight, not just between iterations
    const abortPromise = new Promise<never>((_, reject) => {
      // No pre-check: the loop guard above ran in this same synchronous tick,
      // so an already-aborted signal cannot reach here.
      context.abortSignal.addEventListener('abort', () => {
        reject(abortError());
      }, { once: true });
    });

    try {
      const ops = await Promise.race([
        source.discover(context),
        abortPromise,
      ]);
      results.push(ops);
    } catch (error) {
      if (isAbortError(error)) {
        context.logger.debug('Sequential discovery aborted mid-flight');
      }
      // Abort included: `discover()` owns the abort contract, so this function
      // never decides what an aborted run returns.
      throw error;
    }
  }

  return results;
}
