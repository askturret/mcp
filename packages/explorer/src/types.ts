// SPDX-License-Identifier: Apache-2.0
/**
 * Explorer UI type definitions
 */

import type { JSONSchema } from '@askturret/mcp-core';

/**
 * Explorer configuration options
 */
export interface ExplorerOptions {
  /**
   * Port for Explorer UI
   */
  port?: number;
}

/**
 * Effect flags shown on a tool's detail view.
 *
 * Mirrors core's EffectMetadata, but as a plain (non-readonly) shape so the
 * whole view model survives a JSON round-trip into the browser.
 */
export interface ExplorerEffectsView {
  readOnly: boolean;
  idempotent: boolean;
  retryable: boolean;
  idempotencyKeyRequired: boolean;
  classifications: string[];
}

/**
 * A single tool as the Explorer renders it.
 */
export interface ExplorerToolView {
  /** Operation id within the snapshot. */
  id: string;
  /** Agent-facing tool name — this is what `tools/call` takes. */
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  effects: ExplorerEffectsView;
  /**
   * Executor binding type (e.g. 'handler', 'http').
   *
   * Only the type is exposed. `ExecutorBinding.config` is deliberately NOT
   * included: it is executor-specific and can hold upstream URLs, headers or
   * credential references, none of which belong in a page served to a browser.
   */
  executorType: string;
}

/**
 * Registry identity shown in the Explorer header.
 */
export interface ExplorerHeaderView {
  registryHash: string;
  version: number;
  /** ISO-8601 string; a Date does not survive JSON embedding. */
  createdAt: string;
  toolCount: number;
}

/**
 * Everything the Explorer page needs, derived from one RegistrySnapshot.
 */
export interface ExplorerViewModel {
  header: ExplorerHeaderView;
  tools: ExplorerToolView[];
  /**
   * Base path of the MCP transport, e.g. '/mcp'. The Explorer posts
   * `tools/call` here — it never uses a side channel.
   */
  basePath: string;
}
