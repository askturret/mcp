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

/**
 * Create a composite source that combines multiple sources.
 *
 * Discovers from all child sources and concatenates results.
 * Duplicates are fine - compiler handles conflict resolution.
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

      // Check cancellation before starting
      if (abortSignal.aborted) {
        logger.debug('Composite discovery cancelled before start');
        return [];
      }

      logger.debug(`Composite source discovering from ${sources.length} child sources`, {
        sourceId,
        childCount: sources.length,
        parallel,
      });

      try {
        // Discover from all sources with abort signal support
        const results = parallel
          ? await Promise.race([
              Promise.all(sources.map((s) => s.discover(context))),
              new Promise<never>((_, reject) => {
                if (abortSignal.aborted) {
                  reject(new Error('Aborted'));
                }
                abortSignal.addEventListener('abort', () => {
                  logger.debug('Composite discovery aborted mid-flight');
                  reject(new Error('Aborted'));
                }, { once: true });
              }),
            ])
          : await discoverSequential(sources, context);

        // Check cancellation after discovery
        if (abortSignal.aborted) {
          logger.debug('Composite discovery cancelled after child discovery');
          return [];
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
        // Handle abort errors gracefully
        if (error instanceof Error && error.message === 'Aborted') {
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
      break;
    }

    // Race the discover call against abort signal
    // This ensures we can interrupt mid-flight, not just between iterations
    const abortPromise = new Promise<never>((_, reject) => {
      if (context.abortSignal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
      }
      context.abortSignal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });

    try {
      const ops = await Promise.race([
        source.discover(context),
        abortPromise,
      ]);
      results.push(ops);
    } catch (error) {
      // If aborted, break out of loop
      if (error instanceof DOMException && error.name === 'AbortError') {
        context.logger.debug('Sequential discovery aborted mid-flight');
        break;
      }
      // Re-throw other errors
      throw error;
    }
  }

  return results;
}
