// SPDX-License-Identifier: Apache-2.0
/**
 * Diff output formatting (§13 "human-readable colorized diff by default,
 * --json for CI consumption").
 */

import type { Change, ChangeSeverity, DiffReport } from '@askturret/mcp-core';
import { shouldUseColor } from '../color.js';

const COLORS = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
} as const;

export interface FormatOptions {
  /**
   * Force colour on or off. Omitted, colour is detected from `NO_COLOR` and
   * whether stdout is a TTY (see `shouldUseColor`). Present so tests can pin
   * either mode without mutating globals.
   */
  readonly color?: boolean;
}

function paint(text: string, color: keyof typeof COLORS, enabled: boolean): string {
  if (!enabled) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

const SEVERITY_ORDER: readonly ChangeSeverity[] = [
  'breaking',
  'ambiguous',
  'double-check',
  'non-breaking',
];

const SEVERITY_LABEL: Record<ChangeSeverity, string> = {
  breaking: 'BREAKING',
  ambiguous: 'AMBIGUOUS',
  'double-check': 'DOUBLE-CHECK',
  'non-breaking': 'ok',
};

const SEVERITY_COLOR: Record<ChangeSeverity, keyof typeof COLORS> = {
  breaking: 'red',
  ambiguous: 'yellow',
  'double-check': 'yellow',
  'non-breaking': 'green',
};

export function formatHumanReadable(report: DiffReport, options: FormatOptions = {}): string {
  const color = options.color ?? shouldUseColor();
  const lines: string[] = [];

  lines.push('');
  lines.push(paint('Registry snapshot diff', 'bold', color));
  lines.push(
    paint(
      `  before  v${report.before.version}  ${short(report.before.hash)}`,
      'dim',
      color,
    ),
  );
  lines.push(
    paint(`  after   v${report.after.version}  ${short(report.after.hash)}`, 'dim', color),
  );
  lines.push('');

  if (report.changes.length === 0) {
    lines.push(paint('  No changes.', 'green', color));
    lines.push('');
    return lines.join('\n');
  }

  // Grouped by severity, most serious first: the reader's first question is
  // "does this block the release", not "what happened to operation A".
  for (const severity of SEVERITY_ORDER) {
    const group = report.changes.filter((c) => c.severity === severity);
    if (group.length === 0) continue;

    lines.push(
      paint(`  ${SEVERITY_LABEL[severity]} (${group.length})`, SEVERITY_COLOR[severity], color),
    );
    for (const change of group) lines.push(...formatChange(change, color));
    lines.push('');
  }

  lines.push(paint('Summary', 'bold', color));
  lines.push(`  breaking      ${report.summary.breaking}`);
  lines.push(`  double-check  ${report.summary.doubleCheck}`);
  lines.push(`  ambiguous     ${report.summary.ambiguous}`);
  lines.push(`  non-breaking  ${report.summary.nonBreaking}`);
  lines.push('');

  return lines.join('\n');
}

function formatChange(change: Change, color: boolean): string[] {
  const where = change.path === undefined ? change.operationId : `${change.operationId}.${change.path}`;
  return [
    `    ${where}`,
    `      ${paint(change.code, 'dim', color)}  ${change.detail}`,
  ];
}

function short(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

/**
 * Machine-readable form (§13 `--json`).
 *
 * The report is emitted as-is rather than reshaped: `DiffReport` is already the
 * contract, and a second CI-only shape would be a second thing to keep in sync.
 */
export function formatJson(report: DiffReport): string {
  return JSON.stringify(report, null, 2);
}
