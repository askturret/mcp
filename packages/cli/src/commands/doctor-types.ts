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
  wouldBeExposedInLight: boolean;
  wouldBeDroppedReason?: string;
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
    lightExposed: number;
    lightDropped: number;
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
