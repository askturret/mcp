/**
 * Doctor command output formatters
 */

import type { AnalysisResult, Finding, OperationAnalysis } from './doctor-types.js';

/**
 * Format result as human-readable colorized text
 */
export function formatHumanReadable(result: AnalysisResult): string {
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  AskTurret MCP Doctor - API Readiness Analysis');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  // Spec info
  if (result.spec.title) {
    lines.push(`Spec: ${result.spec.title} v${result.spec.version || 'unknown'}`);
  }
  lines.push(`OpenAPI: ${result.spec.openApiVersion}`);
  lines.push('');

  // Score
  const scoreColor = result.score >= 80 ? '✓' : result.score >= 60 ? '⚠' : '✗';
  lines.push(`${scoreColor} MCP Readiness Score: ${result.score}/100`);
  lines.push('');

  // Summary
  lines.push('Summary:');
  lines.push(`  Total Operations: ${result.summary.totalOperations}`);
  lines.push(`  Errors:           ${colorize(result.summary.errors, 'red', result.summary.errors > 0)}`);
  lines.push(`  Warnings:         ${colorize(result.summary.warnings, 'yellow', result.summary.warnings > 0)}`);
  lines.push(`  Info:             ${result.summary.info}`);
  lines.push(`  Light Exposed:    ${result.summary.lightExposed}`);
  lines.push(`  Light Dropped:    ${result.summary.lightDropped}`);
  lines.push('');

  // Global findings
  if (result.globalFindings.length > 0) {
    lines.push('Global Issues:');
    for (const finding of result.globalFindings) {
      lines.push(formatFinding(finding, '  '));
    }
    lines.push('');
  }

  // Per-operation table
  if (result.operations.length > 0) {
    lines.push('Operations:');
    lines.push('');
    lines.push(formatOperationsTable(result.operations));
    lines.push('');
  }

  // Detailed findings
  const opsWithFindings = result.operations.filter((op) => op.findings.length > 0);
  if (opsWithFindings.length > 0) {
    lines.push('Detailed Findings:');
    lines.push('');

    for (const op of opsWithFindings) {
      const opLabel = op.operationId || `${op.method} ${op.path}`;
      lines.push(`  ${opLabel}:`);
      for (const finding of op.findings) {
        lines.push(formatFinding(finding, '    '));
      }
      lines.push('');
    }
  }

  // Light preset policy
  if (result.summary.lightDropped > 0) {
    lines.push('Light Preset Policy:');
    lines.push('  The following operations would be dropped in Light preset:');
    lines.push('');

    for (const op of result.operations) {
      if (!op.wouldBeExposedInLight) {
        const opLabel = op.operationId || `${op.method} ${op.path}`;
        lines.push(`  • ${opLabel}`);
        if (op.wouldBeDroppedReason) {
          lines.push(`    ${op.wouldBeDroppedReason}`);
        }
      }
    }
    lines.push('');
  }

  // Footer
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  if (result.summary.errors > 0) {
    lines.push('✗ Analysis complete with errors. Fix errors before deployment.');
  } else if (result.summary.warnings > 0) {
    lines.push('⚠ Analysis complete with warnings. Review before deployment.');
  } else {
    lines.push('✓ Analysis complete. No issues found.');
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * Format result as machine-readable JSON
 */
export function formatJson(result: AnalysisResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format a single finding
 */
function formatFinding(finding: Finding, indent: string): string {
  const icon = {
    error: '✗',
    warning: '⚠',
    info: 'ℹ',
  }[finding.severity];

  let line = `${indent}${icon} [${finding.code}] ${finding.message}`;

  if (finding.context) {
    const ctx = finding.context as Record<string, unknown>;
    if (typeof ctx['suggestion'] === 'string') {
      line += `\n${indent}  Suggestion: ${ctx['suggestion']}`;
    }
    if (ctx['unsafeFields'] && Array.isArray(ctx['unsafeFields'])) {
      line += `\n${indent}  Fields: ${(ctx['unsafeFields'] as string[]).join(', ')}`;
    }
  }

  return line;
}

/**
 * Format operations as a table
 */
function formatOperationsTable(operations: OperationAnalysis[]): string {
  const rows: string[] = [];

  // Header
  rows.push('  Method  Path                          OpID                  E  W  Light');
  rows.push('  ──────  ────────────────────────────  ────────────────────  ─  ─  ─────');

  // Operations
  for (const op of operations) {
    const method = op.method.padEnd(6);
    const path = truncate(op.path, 28).padEnd(28);
    const opId = truncate(op.operationId || '-', 20).padEnd(20);
    const errors = op.findings.filter((f) => f.severity === 'error').length;
    const warnings = op.findings.filter((f) => f.severity === 'warning').length;
    const light = op.wouldBeExposedInLight ? '✓' : '✗';

    const errorStr = errors > 0 ? colorize(errors.toString(), 'red', true) : '-';
    const warnStr = warnings > 0 ? colorize(warnings.toString(), 'yellow', true) : '-';

    rows.push(`  ${method}  ${path}  ${opId}  ${errorStr.padEnd(2)}  ${warnStr.padEnd(2)}  ${light}`);
  }

  return rows.join('\n');
}

/**
 * Truncate string to max length
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Colorize text (simple terminal colors)
 */
function colorize(value: string | number, color: 'red' | 'yellow' | 'green', condition: boolean): string {
  if (!condition) return value.toString();

  const codes = {
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    reset: '\x1b[0m',
  };

  return `${codes[color]}${value}${codes.reset}`;
}
