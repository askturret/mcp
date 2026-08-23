// SPDX-License-Identifier: Apache-2.0
/**
 * Reload types - atomic reload with in-flight snapshot retention (§7.4, ADR-004).
 *
 * The reload sequence this models:
 *
 * ```
 * 1. trigger (programmatic or file-watch) invalidates the candidate compile
 * 2. compile candidate OFF the request path (async, in background)
 * 3. validate candidate - schema invariants, effect coherence, hash produced
 * 4. valid? yes -> atomic swap; log v(n) -> v(n+1)
 *           no  -> warn; retain v(n); expose degradation on readiness
 * 5. in-flight calls that acquired v(n) continue on v(n) until completion
 * 6. new calls (post-swap) use v(n+1)
 * ```
 *
 * Step 5 is not implemented here and deliberately so: the dispatcher already
 * captures `registry.current()` exactly once at entry (#13) and threads the
 * resulting snapshot through every stage. Reload leans on that rather than
 * duplicating it. The invariant is only as strong as that single capture, so
 * it is covered by a test that drives the real dispatcher rather than by
 * assertion here.
 */

import type { RegistrySnapshot } from '../types.js';
import type { Logger } from '../sources/types.js';
import type { RegistryReference } from '../registry-reference.js';
import type { ReloadMode } from '../preset/types.js';

/**
 * Outcome of a single reload attempt.
 *
 * Maps directly onto the `mcp_registry_reload_total{outcome=...}` label, so
 * the values are wire-visible and must not be renamed casually.
 *
 * - `success` - candidate compiled, validated, and was swapped in.
 * - `invalid` - candidate compiled but FAILED validation. Nothing swapped.
 * - `error`   - candidate could not be produced or validation itself threw.
 */
export type ReloadOutcome = 'success' | 'invalid' | 'error';

/**
 * Why a reload did not publish a new snapshot.
 *
 * Kept separate from `ReloadOutcome` because readiness needs to say WHAT went
 * wrong, not merely that something did. A future health endpoint (Epic #3,
 * #47) surfaces this verbatim.
 *
 * `superseded` is the odd one out, deliberately: it is NOT a fault. It means
 * the reference moved under an in-flight reload - in practice an operator
 * called `rollback()` while a candidate was still compiling - so the candidate
 * was discarded rather than published over the operator's action. Everything
 * is healthy; the attempt simply lost a race it is supposed to lose. Readiness
 * is left untouched for it, and `fail-fast` does not escalate it to a throw.
 */
export type ReloadErrorClass =
  | 'compile-failed'
  | 'validation-failed'
  | 'superseded';

/**
 * A single reason a candidate snapshot was rejected.
 */
export interface SnapshotViolation {
  /** Stable machine-readable code, e.g. `effect-incoherent`. */
  readonly code: string;

  /** Human-readable explanation. */
  readonly message: string;

  /** Operation the violation belongs to, when it is operation-scoped. */
  readonly operationId?: string;
}

/**
 * Validates a candidate snapshot before it is allowed to serve traffic.
 *
 * Returns the violations found - an EMPTY array means valid. Returning a list
 * rather than a boolean is deliberate: a reload that fails needs to tell an
 * operator which invariant broke, and a boolean throws that away.
 *
 * Runs off the request path. May be async.
 */
export type SnapshotValidator = (
  candidate: RegistrySnapshot,
) => readonly SnapshotViolation[] | Promise<readonly SnapshotViolation[]>;

/**
 * A reload that published a new snapshot.
 */
export interface ReloadSuccess {
  readonly outcome: 'success';
  readonly previousHash: string;
  readonly previousVersion: number;
  readonly hash: string;
  readonly version: number;
}

/**
 * A reload that did NOT publish. The previous snapshot is still serving.
 */
export interface ReloadRejected {
  readonly outcome: 'invalid' | 'error';
  readonly errorClass: ReloadErrorClass;

  /** Hash of the snapshot that REMAINS live. */
  readonly retainedHash: string;
  readonly retainedVersion: number;

  readonly detail: string;
  readonly violations: readonly SnapshotViolation[];
}

export type ReloadResult = ReloadSuccess | ReloadRejected;

/**
 * Readiness as the reload subsystem sees it.
 *
 * `ready: false` means "serving a retained snapshot because the most recent
 * reload did not publish" - NOT "unable to serve". The distinction matters:
 * traffic continues either way, which is the whole point of retention.
 */
export interface ReadinessState {
  readonly ready: boolean;

  /** Hash of the snapshot currently serving traffic. */
  readonly registryHash: string;
  readonly registryVersion: number;

  /** Present only when `ready` is false. */
  readonly errorClass?: ReloadErrorClass;

  /** Present only when `ready` is false. */
  readonly detail?: string;

  /** When the current readiness state was entered. */
  readonly since: Date;
}

/**
 * Metrics sink for reload activity (§ Metrics).
 *
 * An interface with a no-op default, matching `PolicyMetrics`, so core never
 * depends on a metrics backend and adopters wire their own.
 */
export interface ReloadMetrics {
  /**
   * `mcp_registry_reload_total{outcome="success|invalid|error"}` - counter.
   *
   * `errorClass` is OPTIONAL and present only when the reload did not publish
   * (#39, closing a QA note on #37). Without it a `superseded` reload — the
   * benign outcome of an operator rollback winning a race against an in-flight
   * compile — lands in the same `error` bucket as a genuine compile or
   * validation failure, so anyone alerting on reload errors pages on a
   * harmless rollback.
   *
   * A SECOND argument rather than a fourth `outcome` value, because the
   * outcome label set is the metric's wire contract: adding a value breaks
   * existing queries, whereas an extra optional label lets a consumer split
   * the series only if they want to.
   */
  recordReload(outcome: ReloadOutcome, errorClass?: ReloadErrorClass): void;

  /**
   * `mcp_registry_operations{registry_hash=<short>}` - gauge.
   *
   * The hash is SHORTENED before it reaches this method precisely so the label
   * stays low-cardinality, as the issue requires.
   */
  recordActiveRegistry(registryHashShort: string, operationCount: number): void;
}

/**
 * Result of a rollback attempt.
 */
export type RollbackResult =
  | {
      readonly rolledBack: true;
      readonly fromHash: string;
      readonly fromVersion: number;
      readonly toHash: string;
      readonly toVersion: number;
    }
  | {
      readonly rolledBack: false;
      readonly reason: 'no-retained-snapshot';
      readonly retainedHash: string;
    };

/**
 * Default number of previous snapshots kept for rollback.
 */
export const DEFAULT_RETAIN_COUNT = 3;

/**
 * Default file-watch debounce window.
 */
export const DEFAULT_DEBOUNCE_MS = 500;

export interface ReloadControllerOptions {
  /**
   * The reference the dispatcher reads from. The controller swaps THIS, which
   * is what makes the in-flight guarantee hold - there is exactly one
   * publication point.
   */
  readonly reference: RegistryReference;

  /**
   * Produces a candidate snapshot. Runs entirely off the request path.
   *
   * Typically wraps source discovery plus `createCompiler().compile(...)`, but
   * the controller does not care - it only needs a snapshot back.
   */
  readonly compile: () => Promise<RegistrySnapshot>;

  /**
   * Extra validation beyond whatever the compiler already enforces.
   *
   * Optional because the compiler's own `validateInvariants` pass runs during
   * `compile`; this seam exists for invariants that are only checkable against
   * a FULLY BUILT snapshot, and for tests.
   */
  readonly validate?: SnapshotValidator;

  /**
   * What to do when a candidate is rejected. Defaults to `degraded`.
   *
   * See `ReloadMode` and the note on `createReloadController` - both modes
   * retain the last-good snapshot; they differ only in how loudly the failure
   * reaches the caller.
   */
  readonly mode?: ReloadMode;

  /** How many previous snapshots to keep. Defaults to `DEFAULT_RETAIN_COUNT`. */
  readonly retain?: number;

  readonly logger?: Logger;
  readonly metrics?: ReloadMetrics;
}

/**
 * Owns the reload lifecycle for one registry reference.
 */
export interface ReloadController {
  /** The snapshot currently serving traffic. */
  current(): RegistrySnapshot;

  /**
   * Run one reload attempt.
   *
   * Concurrent calls are SERIALIZED, not coalesced: each caller gets its own
   * attempt, run one after another. Coalescing would let a caller receive a
   * result computed before its own trigger, which for a config reload is a
   * correctness bug, not an optimization.
   */
  reload(): Promise<ReloadResult>;

  /** Return to the most recently retained snapshot. */
  rollback(): RollbackResult;

  /** Current readiness, for a health endpoint to surface. */
  readiness(): ReadinessState;

  /** Retained previous snapshots, most-recent first. */
  retained(): readonly RegistrySnapshot[];

  /** Snapshots rolled back FROM, most-recent first. */
  stale(): readonly RegistrySnapshot[];
}
