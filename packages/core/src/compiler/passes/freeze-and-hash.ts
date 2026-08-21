/**
 * Pass 9: Freeze and hash snapshot
 *
 * Deep-freezes operations and computes deterministic content hash.
 * Hash MUST be stable across processes and Node versions (§17 criterion 2).
 */

import type { CompilerPass, CompiledOperation, CompilerContext } from '../types.js';
import type { OperationDefinition, RegistrySnapshot, EffectMetadata } from '../../types.js';
import { createHash } from 'crypto';

/**
 * Deep-freeze an object (recursive Object.freeze)
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Freeze the object itself
  Object.freeze(obj);

  // Recursively freeze all properties
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === 'object' && value !== null) {
      deepFreeze(value);
    }
  }

  return obj;
}

/**
 * Compute deterministic content-addressed hash of operations.
 *
 * Hash contract (ADR-004, Issue #12):
 * - **Included**: id, name, description, input, output, effects, executor, annotations
 * - **Excluded**: provenance (metadata, not contract), createdAt (timing, not content)
 * - **Format**: SHA-256 truncated to 16 hex chars (sufficient uniqueness at our scale)
 *
 * Determinism requirements:
 * - Object keys sorted alphabetically
 * - Operations sorted by ID
 * - No Date.now() or Math.random()
 * - Stable across Node versions and processes
 */
function computeHash(operations: readonly OperationDefinition[]): string {
  // Sort operations by ID for deterministic order
  const sorted = [...operations].sort((a, b) => a.id.localeCompare(b.id));

  // Filter operations to include only contract fields (exclude provenance)
  const contractFields = sorted.map(op => ({
    id: op.id,
    name: op.name,
    description: op.description,
    input: op.input,
    output: op.output,
    effects: op.effects,
    executor: op.executor,
    ...(op.annotations && { annotations: op.annotations }),
  }));

  // Serialize with sorted keys
  const canonical = JSON.stringify(contractFields, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Sort object keys alphabetically
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        sorted[key] = value[key];
      }
      return sorted;
    }
    return value;
  });

  // SHA-256 hash, truncated to 16 hex chars
  const fullHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return fullHash.substring(0, 16);
}

export const freezeAndHash: CompilerPass = {
  name: 'freeze-and-hash',

  async run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]> {
    context.logger.debug('Running freeze-and-hash pass', { count: operations.length });

    // Convert to OperationDefinition (drop transient fields)
    // Pass 8 (validate-invariants) guarantees effects is complete by this point
    const definitions: OperationDefinition[] = operations.map(op => ({
      id: op.id!,
      name: op.name,
      description: op.description,
      input: op.input!,
      output: op.output!,
      effects: op.effects! as EffectMetadata, // Safe: validate-invariants ensures completeness
      executor: op.executor!,
      ...(op.annotations && { annotations: op.annotations }),
      ...(op.provenance && { provenance: op.provenance }),
    }));

    // Deep-freeze each operation
    const frozen = definitions.map(op => deepFreeze(op));

    context.logger.debug('Operations frozen and ready for snapshot', {
      count: frozen.length,
    });

    // Return frozen operations (cast back to CompiledOperation for pass interface)
    return frozen as readonly CompiledOperation[];
  },
};

/**
 * Create final registry snapshot with hash
 * (Called by main compiler after all passes complete)
 */
export function createSnapshot(
  operations: readonly OperationDefinition[],
  version: number,
): RegistrySnapshot {
  const hash = computeHash(operations);
  const operationsMap = new Map(operations.map(op => [op.id, op]));

  const snapshot: RegistrySnapshot = {
    version,
    hash,
    createdAt: new Date(),
    operations: operationsMap,
  };

  return deepFreeze(snapshot);
}
