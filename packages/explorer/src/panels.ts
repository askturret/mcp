// SPDX-License-Identifier: Apache-2.0
/**
 * The six Explorer panels (§13, ADR-020, #56).
 *
 * ## One rule governs this whole file
 *
 * **No panel bypasses the redaction pipeline.** §56 makes that acceptance
 * criteria, and it is the constraint every function here is shaped around:
 * each builder returns its model through `redactExplorerModel`, and
 * `buildExplorerPanels` applies it again at the top so a panel added later
 * cannot escape simply by forgetting.
 *
 * Belt and braces is deliberate. The per-panel call is where the intent lives;
 * the outer call is what survives someone adding a seventh panel in a hurry.
 * Redaction is idempotent — a `[REDACTED]` string redacts to itself — so the
 * double pass costs nothing and removes the "did I remember?" question.
 *
 * ## What these builders are, and are not
 *
 * They are DATA. Each takes the state it needs and returns a plain,
 * JSON-serialisable model. None of them reaches for a registry, a dispatcher
 * or a policy engine on its own — the caller supplies what it already has,
 * which keeps the Explorer incapable of observing anything the server was not
 * already willing to hand it.
 */

import { redactExplorerModel } from '@askturret/mcp-core';
import type {
  Change,
  DiffReport,
  OperationDefinition,
  Principal,
  ProvenanceEntry,
  RegistrySnapshot,
} from '@askturret/mcp-core';

import type {
  ExplorerBreakerView,
  ExplorerDiffView,
  ExplorerPanels,
  ExplorerPolicyExplanationView,
  ExplorerPrincipalSurfaceView,
  ExplorerProvenanceFieldView,
  ExplorerProvenanceView,
  ExplorerTraceView,
  PolicyEvidenceView,
} from './types.js';

// ---------------------------------------------------------------------------
// Panel 1 — provenance / precedence explainer
// ---------------------------------------------------------------------------

/**
 * §5.3's chain, highest first, as the Explorer labels it.
 *
 * Mirrors `PROVENANCE_PRECEDENCE` in core deliberately as LABELS only — the
 * ranking itself is never recomputed here. A second ranking would be a second
 * implementation of the precedence rules, and the panel's whole job is to
 * report the one the compiler actually applied.
 */
const PRECEDENCE_LABELS: Readonly<Record<string, string>> = {
  code: '1 · explicit code enhancement',
  overlay: '2 · MCP overlay',
  'x-mcp': '3 · source-native x-mcp',
  openapi: '4 · source definition (OpenAPI)',
  framework: '4 · source definition (framework)',
  inference: '5 · conservative inference',
  preset: '6 · preset default',
};

/**
 * Per-field provenance for one operation.
 *
 * `overlayModified` is what §56 asks to "highlight visually so an operator can
 * see at a glance what deviates from the source" — computed here rather than in
 * the template, so the highlight and the explanation cannot disagree.
 */
export function buildProvenanceView(operation: OperationDefinition): ExplorerProvenanceView {
  const entries: readonly ProvenanceEntry[] = operation.provenance ?? [];

  const fields: ExplorerProvenanceFieldView[] = entries.map((entry) => ({
    field: entry.field,
    kind: entry.kind,
    precedence: PRECEDENCE_LABELS[entry.kind] ?? entry.kind,
    ...(entry.location === undefined ? {} : { location: entry.location }),
    overlayModified: entry.kind === 'overlay',
  }));

  fields.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));

  return redactExplorerModel({
    operationId: operation.id,
    fields,
    overlayModifiedCount: fields.filter((f) => f.overlayModified).length,
    // Stated rather than left as an empty list to interpret. An operation
    // compiled before provenance existed, or by a path that does not record
    // it, is NOT the same as one whose every field came from the source.
    available: entries.length > 0,
  });
}

// ---------------------------------------------------------------------------
// Panel 2 — policy explanation
// ---------------------------------------------------------------------------

/** What a policy decision looked like, for the panel. */
export interface PolicyDecisionLike {
  readonly effect: string;
  readonly code?: string;
  readonly safeReason?: string;
  readonly evidence: readonly { readonly policyId: string; readonly claim: string; readonly detail?: string }[];
}

/**
 * Render one policy evaluation as an explanation.
 *
 * The evidence list comes straight from #33's `PolicyEvidence`, which is
 * already written to be safe at a trust boundary — its contract forbids
 * principal identifiers, tokens and payloads. It still goes through redaction,
 * because "the producer promises it is safe" and "the surface enforces it" are
 * different guarantees, and only the second survives a policy an adopter wrote.
 */
export function buildPolicyExplanationView(
  operationId: string,
  policyId: string,
  decision: PolicyDecisionLike,
): ExplorerPolicyExplanationView {
  const evidence: PolicyEvidenceView[] = decision.evidence.map((item) => ({
    policyId: item.policyId,
    claim: item.claim,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
  }));

  return redactExplorerModel({
    operationId,
    policy: policyId,
    effect: decision.effect,
    ...(decision.code === undefined ? {} : { code: decision.code }),
    // `safeReason` is the field the policy author marked as fit to cross a
    // trust boundary; the evidence list is richer but is shown here because
    // the Explorer IS the operator-facing diagnostic surface. Both redacted.
    ...(decision.safeReason === undefined ? {} : { reason: decision.safeReason }),
    evidence,
    denied: decision.effect === 'deny',
  });
}

// ---------------------------------------------------------------------------
// Panel 3 — principal-aware effective surface
// ---------------------------------------------------------------------------

/**
 * The tool list as a chosen principal would see it.
 *
 * Answers §56's "why can't customer X see this tool?" by showing BOTH sides:
 * what is visible, and what is hidden. A panel that only listed the visible
 * ones would answer the easy half of that question.
 *
 * The principal itself is echoed back only as its `type` and permission NAMES.
 * The id is deliberately omitted: it is the one field #33's evidence contract
 * singles out as unsafe, and a debugging surface that renders "why can't
 * alice@example.com see this" has put a real identifier in a browser page.
 */
export function buildPrincipalSurfaceView(
  principal: Principal | undefined,
  all: readonly OperationDefinition[],
  visible: readonly OperationDefinition[],
): ExplorerPrincipalSurfaceView {
  const visibleIds = new Set(visible.map((op) => op.id));

  return redactExplorerModel({
    principal:
      principal === undefined
        ? { anonymous: true, permissions: [] }
        : {
            anonymous: false,
            type: principal.type,
            permissions: [...(principal.permissions ?? [])],
          },
    visible: visible.map((op) => ({ id: op.id, name: op.name })),
    hidden: all.filter((op) => !visibleIds.has(op.id)).map((op) => ({ id: op.id, name: op.name })),
    totalCount: all.length,
  });
}

// ---------------------------------------------------------------------------
// Panel 4 — traces
// ---------------------------------------------------------------------------

export interface RecordedSpanLike {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly outcome?: string;
  readonly startedAt: number;
  readonly durationMs?: number;
}

/**
 * The recent request tail.
 *
 * `available: false` when no buffer is wired, and that is the honest default:
 * the span buffer is OPT-IN, because retaining request metadata in process
 * memory is a decision an operator makes rather than one they inherit. An
 * empty panel that looked identical to "no traffic yet" would send someone
 * hunting for requests that were never recorded.
 */
export function buildTraceView(
  spans: readonly RecordedSpanLike[] | undefined,
  toolName?: string,
): ExplorerTraceView {
  if (spans === undefined) {
    return redactExplorerModel({
      available: false,
      reason:
        'No span buffer is configured. Wrap your observability with recordingObservability() to ' +
        'retain a bounded, redacted tail of recent spans.',
      spans: [],
    });
  }

  const filtered =
    toolName === undefined
      ? spans
      : spans.filter((span) => span.attributes['mcp.tool.name'] === toolName);

  return redactExplorerModel({
    available: true,
    spans: filtered.map((span) => ({
      name: span.name,
      attributes: { ...span.attributes },
      ...(span.outcome === undefined ? {} : { outcome: span.outcome }),
      startedAt: new Date(span.startedAt).toISOString(),
      ...(span.durationMs === undefined ? {} : { durationMs: span.durationMs }),
    })),
  });
}

// ---------------------------------------------------------------------------
// Panel 5 — breaker / bulkhead state
// ---------------------------------------------------------------------------

export interface BreakerStatsLike {
  readonly name: string;
  readonly state: string;
  readonly failures?: number;
}

export interface BulkheadStatsLike {
  readonly name: string;
  readonly inFlight?: number;
  readonly queued?: number;
  readonly concurrency?: number;
  readonly queueSize?: number;
}

/**
 * Live breaker and bulkhead state.
 *
 * ## Polling, not SSE — §56 asks for the choice to be documented
 *
 * The Explorer is a dev-only page and this is a gauge, not an event stream.
 * SSE would mean an open connection per open tab, held for as long as the tab
 * exists, on a server whose bulkheads this very panel exists to watch — a
 * diagnostic that consumes the resource it measures. Polling costs one request
 * per interval and stops the moment the tab closes, with no server-side state
 * to leak on disconnect.
 *
 * The panel therefore exposes a `pollIntervalMs` the page honours, and this
 * builder is a pure snapshot of the current values.
 *
 * An EMPTY breaker list is distinguishable from "all closed" — breakers are
 * opt-in (#46), and a UI that could not tell those apart would show a
 * reassuring row of green for a server with no breakers at all.
 */
export function buildBreakerView(
  breakers: readonly BreakerStatsLike[] | undefined,
  bulkheads: readonly BulkheadStatsLike[] | undefined,
  pollIntervalMs = 2000,
): ExplorerBreakerView {
  return redactExplorerModel({
    breakersConfigured: breakers !== undefined && breakers.length > 0,
    bulkheadsConfigured: bulkheads !== undefined && bulkheads.length > 0,
    breakers: (breakers ?? []).map((b) => ({
      name: b.name,
      state: b.state,
      ...(b.failures === undefined ? {} : { failures: b.failures }),
    })),
    bulkheads: (bulkheads ?? []).map((b) => ({
      name: b.name,
      ...(b.inFlight === undefined ? {} : { inFlight: b.inFlight }),
      ...(b.queued === undefined ? {} : { queued: b.queued }),
      ...(b.concurrency === undefined ? {} : { concurrency: b.concurrency }),
      ...(b.queueSize === undefined ? {} : { queueSize: b.queueSize }),
    })),
    pollIntervalMs,
    // Stated in the model rather than only in a comment, so the page and the
    // docs cannot disagree about how this panel refreshes.
    refreshStrategy: 'polling',
  });
}

// ---------------------------------------------------------------------------
// Panel 6 — version diff
// ---------------------------------------------------------------------------

/**
 * A snapshot diff, classified exactly as the `diff` CLI classifies it.
 *
 * The report is produced by core's `diffSnapshots` — the SAME function the CLI
 * calls — and this only reshapes it for rendering. §56 asks the panel to match
 * the CLI's output; calling the same classifier is the only way to make that
 * true rather than approximately true.
 */
export function buildDiffView(
  report: DiffReport | undefined,
  retained: readonly RegistrySnapshot[],
): ExplorerDiffView {
  const available = retained.length > 1;

  return redactExplorerModel({
    // One retained snapshot means there is nothing to compare against. Said
    // explicitly, because an empty diff and an impossible diff look identical.
    available,
    ...(available
      ? {}
      : { reason: 'At least two retained snapshots are needed to diff; only one is held.' }),
    snapshots: retained.map((snapshot) => ({
      hash: snapshot.hash,
      version: snapshot.version,
      createdAt: new Date(snapshot.createdAt).toISOString(),
      toolCount: snapshot.operations.size,
    })),
    // Optional fields are OMITTED rather than set to undefined: the model is
    // JSON-embedded into the page, and `"operationId": undefined` is not a
    // thing JSON can express — it would silently vanish, so building it that
    // way only looks correct until someone reads the serialised output.
    changes:
      report === undefined
        ? []
        : (report.changes as readonly Change[]).map((change) => {
            const operationId = (change as { operationId?: string }).operationId;
            const detail = (change as { detail?: string }).detail;
            return {
              code: String(change.code),
              severity: String(change.severity),
              ...(operationId === undefined ? {} : { operationId }),
              ...(detail === undefined ? {} : { detail }),
            };
          }),
    ...(report === undefined ? {} : { summary: report.summary }),
  });
}

// ---------------------------------------------------------------------------
// All six
// ---------------------------------------------------------------------------

export interface BuildPanelsInput {
  readonly operation?: OperationDefinition;
  readonly policy?: { readonly policyId: string; readonly decision: PolicyDecisionLike };
  readonly principal?: Principal;
  readonly allOperations?: readonly OperationDefinition[];
  readonly visibleOperations?: readonly OperationDefinition[];
  readonly spans?: readonly RecordedSpanLike[];
  readonly breakers?: readonly BreakerStatsLike[];
  readonly bulkheads?: readonly BulkheadStatsLike[];
  readonly diff?: DiffReport;
  readonly retained?: readonly RegistrySnapshot[];
  readonly pollIntervalMs?: number;
}

/**
 * Assemble every panel.
 *
 * The final `redactExplorerModel` is the belt to the per-panel braces — see the
 * file header. It is not redundant: it is what catches a seventh panel added by
 * someone who did not read this comment.
 */
export function buildExplorerPanels(input: BuildPanelsInput): ExplorerPanels {
  return redactExplorerModel({
    ...(input.operation === undefined
      ? {}
      : { provenance: buildProvenanceView(input.operation) }),
    ...(input.policy === undefined || input.operation === undefined
      ? {}
      : {
          policy: buildPolicyExplanationView(
            input.operation.id,
            input.policy.policyId,
            input.policy.decision,
          ),
        }),
    ...(input.allOperations === undefined
      ? {}
      : {
          principalSurface: buildPrincipalSurfaceView(
            input.principal,
            input.allOperations,
            input.visibleOperations ?? input.allOperations,
          ),
        }),
    traces: buildTraceView(input.spans, input.operation?.name),
    runtime: buildBreakerView(input.breakers, input.bulkheads, input.pollIntervalMs),
    diff: buildDiffView(input.diff, input.retained ?? []),
  });
}
