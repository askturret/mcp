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

// ===========================================================================
// Panels (§13, ADR-020, #56)
// ===========================================================================

/** Panel 1 — one field's provenance. */
export interface ExplorerProvenanceFieldView {
  field: string;
  kind: string;
  /** Human label for the §5.3 level, e.g. '2 · MCP overlay'. */
  precedence: string;
  location?: string;
  /** True when an overlay set this field — what §56 asks to highlight. */
  overlayModified: boolean;
}

export interface ExplorerProvenanceView {
  operationId: string;
  fields: ExplorerProvenanceFieldView[];
  overlayModifiedCount: number;
  /**
   * False when the operation carries no provenance at all.
   *
   * Distinct from "every field came from the source": an operation compiled
   * before provenance existed has nothing to explain, and saying so is more
   * useful than rendering an empty table that implies it was checked.
   */
  available: boolean;
}

/** Panel 2 — one piece of #33 PolicyEvidence. */
export interface PolicyEvidenceView {
  policyId: string;
  claim: string;
  detail?: string;
}

export interface ExplorerPolicyExplanationView {
  operationId: string;
  policy: string;
  effect: string;
  code?: string;
  reason?: string;
  evidence: PolicyEvidenceView[];
  denied: boolean;
}

/** Panel 3 — the surface a chosen principal sees. */
export interface ExplorerPrincipalSurfaceView {
  principal: {
    anonymous: boolean;
    type?: string;
    /**
     * Permission NAMES only. The principal's id is deliberately absent — #33's
     * evidence contract singles it out as unsafe, and a debugging page that
     * rendered a real identifier would be exactly that leak.
     */
    permissions: string[];
  };
  visible: { id: string; name: string }[];
  /** Shown alongside `visible`, because "why can't X see this?" is the question. */
  hidden: { id: string; name: string }[];
  totalCount: number;
}

/** Panel 4 — the recent request tail. */
export interface ExplorerTraceSpanView {
  name: string;
  attributes: Record<string, unknown>;
  outcome?: string;
  startedAt: string;
  durationMs?: number;
}

export interface ExplorerTraceView {
  /** False when no span buffer is wired — opt-in, so absence is normal. */
  available: boolean;
  reason?: string;
  spans: ExplorerTraceSpanView[];
}

/** Panel 5 — live breaker and bulkhead state. */
export interface ExplorerBreakerView {
  /** Distinguishes "none configured" from "all closed" — breakers are opt-in. */
  breakersConfigured: boolean;
  bulkheadsConfigured: boolean;
  breakers: { name: string; state: string; failures?: number }[];
  bulkheads: {
    name: string;
    inFlight?: number;
    queued?: number;
    concurrency?: number;
    queueSize?: number;
  }[];
  pollIntervalMs: number;
  /** Documented in the model so the page and the docs cannot disagree (§56). */
  refreshStrategy: 'polling';
}

/** Panel 6 — snapshot diff, classified by the same code the CLI uses. */
export interface ExplorerDiffView {
  available: boolean;
  reason?: string;
  snapshots: { hash: string; version: number; createdAt: string; toolCount: number }[];
  changes: {
    code: string;
    severity: string;
    operationId?: string;
    detail?: string;
  }[];
  summary?: unknown;
}

/** All six panels. Each is optional; absence means "not supplied by the host". */
export interface ExplorerPanels {
  provenance?: ExplorerProvenanceView;
  policy?: ExplorerPolicyExplanationView;
  principalSurface?: ExplorerPrincipalSurfaceView;
  traces: ExplorerTraceView;
  runtime: ExplorerBreakerView;
  diff: ExplorerDiffView;
}
