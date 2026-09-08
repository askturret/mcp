// SPDX-License-Identifier: Apache-2.0
/**
 * Doctor command types
 */

import type { PresetDescription } from '@askturret/mcp-core';

/**
 * Severity level for findings
 */
export type FindingSeverity = 'error' | 'warning' | 'info';

/**
 * Finding from analysis
 */
export interface Finding {
  /**
   * Severity level
   */
  severity: FindingSeverity;

  /**
   * Finding code (stable identifier)
   */
  code: string;

  /**
   * Human-readable message
   */
  message: string;

  /**
   * Operation ID if finding is operation-specific
   */
  operationId?: string;

  /**
   * Path + method if operation-specific
   */
  path?: string;
  method?: string;

  /**
   * Additional context
   */
  context?: Record<string, unknown>;
}

/**
 * Analysis result for a single operation
 */
export interface OperationAnalysis {
  operationId?: string;
  path: string;
  method: string;
  findings: Finding[];

  /**
   * Does the Light preset's POLICY admit this operation? (#762)
   *
   * Read-only methods are admitted; anything else needs an explicit `x-mcp`
   * opt-in. Those two inputs are the whole decision.
   *
   * **This is not a prediction that the tool will appear.** Appearing requires
   * policy admission AND successful construction from the spec, and doctor
   * models only the first. It was previously called `wouldBeExposedInLight`,
   * which named the conjunction while computing one conjunct — so an operation
   * admitted here can still fail to build, and doctor cannot see that.
   */
  admittedByLightPolicy: boolean;

  /**
   * Why the Light preset's policy excluded this operation, when it did.
   * Absent for admitted operations. Never a construction failure — see above.
   */
  lightPolicyExclusionReason?: string;
}

/**
 * Overall analysis result
 */
export interface AnalysisResult {
  /**
   * MCP readiness score (0-100)
   */
  score: number;

  /**
   * Per-operation analysis
   */
  operations: OperationAnalysis[];

  /**
   * Global findings (not tied to a specific operation)
   */
  globalFindings: Finding[];

  /**
   * Summary counts
   */
  summary: {
    totalOperations: number;
    errors: number;
    warnings: number;
    info: number;

    /**
     * Operations the Light preset's POLICY admits / excludes (#762).
     *
     * Renamed from `lightExposed` / `lightDropped`, which read as "will appear"
     * / "will fail to appear" and were measured from preset policy alone.
     * Whether an operation can actually be CONSTRUCTED from the spec is a
     * separate question that doctor does not model at all, so `Excluded` is a
     * floor on what goes missing, never the whole of it.
     */
    lightPolicyAdmitted: number;
    lightPolicyExcluded: number;
  };

  /**
   * Spec metadata
   */
  spec: {
    title?: string;
    version?: string;
    openApiVersion: string;
  };

  /**
   * The expansion of a requested preset, when `--preset` was passed.
   *
   * ADR-007: presets expand to ordinary configuration and can be inspected.
   * This is that inspection surface — an operator can read the expansion,
   * copy it, and change a single field without re-deriving the whole preset.
   *
   * Must stay JSON-safe and deterministic: `formatJson` stringifies this whole
   * result, and a test pins that two runs produce identical output.
   */
  preset?: PresetDescription;
}
