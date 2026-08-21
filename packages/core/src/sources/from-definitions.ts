/**
 * fromDefinitions() - zero-cost explicit definition source
 *
 * Simplest source implementation. Accepts explicit OperationDefinition-shaped objects
 * and returns them as DiscoveredOperations with minimal wrapping.
 *
 * Zero-cost: no reflection, no HTTP calls, no parsing.
 * Preserves provenance as { kind: 'code', location: <optional> }.
 */

import type {
  OperationSource,
  DiscoveredOperation,
  DiscoveryContext,
} from './types.js';
import type { OperationDefinition } from '../types.js';

/**
 * Definition input - accepts OperationDefinition or a compatible shape.
 * Allows slight flexibility while maintaining type safety.
 */
export type DefinitionInput = Omit<OperationDefinition, 'id'> & {
  /**
   * Operation ID - required for fromDefinitions.
   */
  id: string;

  /**
   * Optional location hint for provenance (file:line, module name, etc.)
   */
  location?: string;
};

/**
 * fromDefinitions() source configuration.
 */
export interface FromDefinitionsOptions {
  /**
   * Source ID (defaults to 'definitions').
   * Useful when combining multiple fromDefinitions sources.
   */
  sourceId?: string;

  /**
   * Optional default location hint for all definitions.
   * Individual definition locations override this.
   */
  defaultLocation?: string;
}

/**
 * Create an OperationSource from explicit definitions.
 *
 * Zero-cost source - no reflection, no HTTP, no parsing.
 * Returns definitions as DiscoveredOperations directly.
 *
 * @param definitions - Array of explicit operation definitions
 * @param options - Optional source configuration
 * @returns OperationSource that emits these definitions
 *
 * @example
 * ```ts
 * const source = fromDefinitions([
 *   {
 *     id: 'create-user',
 *     name: 'createUser',
 *     description: 'Creates a new user',
 *     input: { type: 'object', properties: { email: { type: 'string' } } },
 *     output: { type: 'object', properties: { id: { type: 'string' } } },
 *     effects: { readOnly: false, idempotent: true, retryable: true, ... },
 *     executor: { type: 'handler', config: { handler: createUserHandler } },
 *   },
 * ]);
 * ```
 */
export function fromDefinitions(
  definitions: readonly DefinitionInput[],
  options: FromDefinitionsOptions = {},
): OperationSource {
  const sourceId = options.sourceId ?? 'definitions';
  const defaultLocation = options.defaultLocation;

  return {
    id: sourceId,

    async discover(_context: DiscoveryContext): Promise<DiscoveredOperation[]> {
      // Zero-cost: map definitions to discovered operations directly
      // No async work - returns synchronously wrapped in Promise
      return definitions.map((def): DiscoveredOperation => {
        const location = def.location ?? defaultLocation;

        return {
          candidateId: def.id,
          name: def.name,
          description: def.description,
          rawInput: def.input,
          rawOutput: def.output,
          source: {
            kind: 'code',
            ...(location !== undefined && { location }),
          },
          effects: def.effects,
          executor: def.executor,
          annotations: def.annotations,
          provenance: def.provenance,
          hints: {
            // Preserve any additional fields as hints
            definitionSource: sourceId,
          },
        };
      });
    },
  };
}
