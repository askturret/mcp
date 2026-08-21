/**
 * Inspect command output formatters
 */

import type { InspectResult, ToolInfo, DiffResult } from './inspect-types.js';

/**
 * Format result as human-readable colorized text
 */
export function formatHumanReadable(
  result: InspectResult,
  diff?: DiffResult,
): string {
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  AskTurret MCP Inspect - Live Server Introspection');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  if (!result.healthy) {
    lines.push(`✗ Server Unreachable`);
    lines.push('');
    lines.push(`Error: ${result.error?.message || 'Unknown error'}`);
    lines.push(`Code:  ${result.error?.code || 'UNKNOWN'}`);
    lines.push('');
    lines.push('═══════════════════════════════════════════════════════════════');
    return lines.join('\n');
  }

  // Server info
  lines.push('Server Information:');
  lines.push(`  Name:             ${result.server.name}`);
  lines.push(`  Version:          ${result.server.version}`);
  lines.push(`  Protocol Version: ${result.server.protocolVersion}`);
  if (result.server.registryHash) {
    lines.push(`  Registry Hash:    ${result.server.registryHash.slice(0, 12)}...`);
  }
  lines.push('');

  // Latency
  lines.push('Performance:');
  if (result.latency.pingMs !== undefined) {
    lines.push(`  Ping:             ${result.latency.pingMs}ms`);
  }
  lines.push(`  Handshake:        ${result.latency.handshakeMs}ms`);
  lines.push(`  tools/list:       ${result.latency.toolsListMs}ms`);
  lines.push('');

  // Tools summary
  lines.push(`Tools: ${result.tools.length} available`);
  lines.push('');

  if (result.tools.length > 0) {
    lines.push(formatToolsTable(result.tools));
    lines.push('');
  }

  // Detailed tool info
  if (result.tools.length > 0) {
    lines.push('Tool Details:');
    lines.push('');

    for (const tool of result.tools.slice(0, 10)) {
      // Limit to first 10 for readability
      lines.push(`  ${tool.name}`);
      if (tool.description) {
        lines.push(`    ${tool.description}`);
      }

      if (tool.effects) {
        const effects: string[] = [];
        if (tool.effects.readOnly) effects.push('read-only');
        if (tool.effects.idempotent) effects.push('idempotent');
        if (effects.length > 0) {
          lines.push(`    Effects: ${effects.join(', ')}`);
        }
      }

      if (tool.auth?.required) {
        lines.push(`    Auth: ${tool.auth.schemes?.join(', ') || 'required'}`);
      }

      lines.push('');
    }

    if (result.tools.length > 10) {
      lines.push(`  ... and ${result.tools.length - 10} more`);
      lines.push('');
    }
  }

  // Dry-run result
  if (result.dryRun) {
    lines.push('Dry-Run Result:');
    lines.push(`  Tool:      ${result.dryRun.tool}`);
    lines.push(`  Status:    ${result.dryRun.success ? '✓ Success' : '✗ Failed'}`);
    lines.push(`  Time:      ${result.dryRun.executionMs}ms`);

    if (result.dryRun.success && result.dryRun.result) {
      lines.push(`  Result:    ${JSON.stringify(result.dryRun.result).slice(0, 100)}`);
    } else if (!result.dryRun.success && result.dryRun.error) {
      lines.push(`  Error:     ${result.dryRun.error}`);
    }

    lines.push('');
  }

  // Diff result
  if (diff) {
    lines.push('Diff vs Snapshot:');

    if (diff.added.length > 0) {
      lines.push(`  Added: ${diff.added.join(', ')}`);
    }

    if (diff.removed.length > 0) {
      lines.push(`  Removed: ${diff.removed.join(', ')}`);
    }

    if (diff.modified.length > 0) {
      lines.push(`  Modified:`);
      for (const mod of diff.modified) {
        lines.push(`    ${mod.tool}: ${mod.changes.join(', ')}`);
      }
    }

    if (diff.hashChanged) {
      lines.push(`  Registry Hash: ${diff.previousHash?.slice(0, 12) || '?'} -> ${diff.currentHash?.slice(0, 12) || '?'}`);
    }

    if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
      lines.push('  No changes detected');
    }

    lines.push('');
  }

  // Footer
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('✓ Inspection complete. Server is healthy.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format result as machine-readable JSON
 */
export function formatJson(result: InspectResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format tools as a table
 */
function formatToolsTable(tools: ToolInfo[]): string {
  const rows: string[] = [];

  // Header
  rows.push('  Name                          Description                  Effects      Auth');
  rows.push('  ────────────────────────────  ───────────────────────────  ───────────  ────');

  // Tools
  for (const tool of tools) {
    const name = truncate(tool.name, 28).padEnd(28);
    const desc = truncate(tool.description || '-', 27).padEnd(27);

    const effects: string[] = [];
    if (tool.effects?.readOnly) effects.push('RO');
    if (tool.effects?.idempotent) effects.push('ID');
    const effectsStr = effects.length > 0 ? effects.join(',') : '-';

    const authStr = tool.auth?.required ? 'Yes' : '-';

    rows.push(`  ${name}  ${desc}  ${effectsStr.padEnd(11)}  ${authStr}`);
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
