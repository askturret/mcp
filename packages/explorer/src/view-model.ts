// SPDX-License-Identifier: Apache-2.0
/**
 * Builds the Explorer view model from a RegistrySnapshot.
 *
 * The Explorer consumes the SAME snapshot the transport serves, so what it
 * shows cannot drift from what `tools/list` would return.
 */

import type { RegistrySnapshot } from '@askturret/mcp-core';
import type { ExplorerToolView, ExplorerViewModel } from './types.js';

/**
 * Derive the Explorer's view model from a registry snapshot.
 *
 * @param snapshot - The snapshot to render (typically `registry.current()`).
 * @param basePath - MCP transport base path, e.g. '/mcp'.
 */
export function buildExplorerViewModel(
  snapshot: RegistrySnapshot,
  basePath: string,
): ExplorerViewModel {
  const tools: ExplorerToolView[] = Array.from(snapshot.operations.values()).map((op) => ({
    id: op.id,
    name: op.name,
    description: op.description,
    inputSchema: op.input,
    outputSchema: op.output,
    effects: {
      readOnly: op.effects.readOnly,
      idempotent: op.effects.idempotent,
      retryable: op.effects.retryable,
      idempotencyKeyRequired: op.effects.idempotencyKeyRequired,
      classifications: [...op.effects.classifications],
    },
    // Deliberately only the type — see ExplorerToolView.executorType.
    executorType: op.executor.type,
  }));

  // Stable, predictable ordering. Map iteration order is insertion order, which
  // depends on discovery order and would shuffle the UI between restarts.
  tools.sort((a, b) => a.name.localeCompare(b.name));

  return {
    header: {
      registryHash: snapshot.hash,
      version: snapshot.version,
      createdAt: toIsoString(snapshot.createdAt),
      toolCount: tools.length,
    },
    tools,
    basePath,
  };
}

/**
 * `createdAt` is typed as a Date, but a snapshot can be rehydrated from JSON
 * (session stores, fixtures), in which case it is a string at runtime. Render
 * whatever we were actually given rather than throwing in a dev-only UI.
 */
function toIsoString(value: Date | string | number): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'unknown' : value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}
