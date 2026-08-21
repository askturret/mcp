// SPDX-License-Identifier: Apache-2.0
/**
 * Operation sources - pluggable discovery interface
 *
 * Export all source types and implementations.
 */

export type {
  Logger,
  DiscoveryContext,
  SourceMetadata,
  DiscoveredOperation,
  OperationSource,
} from './types.js';

export type {
  DefinitionInput,
  FromDefinitionsOptions,
} from './from-definitions.js';

export { fromDefinitions } from './from-definitions.js';

export type {
  CompositeSourceOptions,
} from './composite.js';

export { compositeSource } from './composite.js';
