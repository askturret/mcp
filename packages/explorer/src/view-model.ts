// SPDX-License-Identifier: Apache-2.0
/**
 * Builds the Explorer view model from a RegistrySnapshot.
 *
 * The Explorer consumes the SAME snapshot the transport serves, so what it
 * shows cannot drift from what `tools/list` would return.
 */

import { redactExplorerModel } from '@askturret/mcp-core';
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

  // Surface 5 of §9.4 — applied to the FINISHED model, immediately before it
  // is handed to the caller for serialization.
  //
  // The Explorer renders operation descriptions and JSON Schemas taken
  // straight from an adopter's spec, and specs routinely carry example values.
  // An `example: "sk_live_..."` in a schema is a real way a credential reaches
  // a browser, and nothing upstream of here would catch it.
  //
  // NOTE for QA: §9.4 names this surface "Explorer call history". No call
  // history exists in the Explorer today — there is no request log, and #56 is
  // the issue that adds runtime state to it. The view model is the only thing
  // the Explorer currently serializes, so it is what gets wired; the call
  // history will need this same treatment when #56 builds it. Logged to #156.
  return redactExplorerModel({
    header: {
      registryHash: snapshot.hash,
      version: snapshot.version,
      createdAt: toIsoString(snapshot.createdAt),
      toolCount: tools.length,
    },
    tools,
    basePath,
  });
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
