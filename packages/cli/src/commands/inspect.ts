// SPDX-License-Identifier: Apache-2.0
/**
 * Inspect command - Live server introspection
 */

import { readFile } from 'fs/promises';
import type {
  InspectResult,
  ServerInfo,
  ToolInfo,
  LatencyStats,
  DryRunResult,
  DiffResult,
} from './inspect-types.js';
import { formatHumanReadable, formatJson } from './inspect-output.js';

/**
 * JSON-RPC response types
 */
interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: JsonRpcError;
}

interface InitializeResult {
  protocolVersion: string;
  serverInfo?: {
    name?: string;
    version?: string;
    registryHash?: string;
  };
  capabilities?: Record<string, unknown>;
}

interface ToolsListResult {
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    'x-mcp-effects'?: {
      readOnly?: boolean;
      idempotent?: boolean;
      [key: string]: unknown;
    };
    'x-mcp-auth'?: {
      required?: boolean;
      schemes?: string[];
    };
    annotations?: Record<string, unknown>;
  }>;
}

/**
 * Inspect command entry point
 */
export async function inspectCommand(args: string[]): Promise<void> {
  const flags = parseArgs(args);

  if (!flags.url) {
    console.error('Error: Missing required --url argument');
    console.error('Usage: npx @askturret/mcp inspect --url <endpoint>');
    console.error('       npx @askturret/mcp inspect --url <endpoint> --tool <name> --dry-run');
    process.exit(1);
  }

  try {
    // After check above, url is guaranteed to be string
    const result = await inspectServer({ ...flags, url: flags.url as string });

    if (flags.json) {
      console.log(formatJson(result));
    } else {
      console.log(formatHumanReadable(result, result.diffSnapshot));
    }

    // Exit with non-zero if unhealthy
    process.exit(result.healthy ? 0 : 1);
  } catch (err) {
    console.error('Inspection failed:', err instanceof Error ? err.message : err);
    process.exit(2);
  }
}

/**
 * Parse command-line arguments
 */
function parseArgs(args: string[]): {
  url?: string;
  tool?: string;
  dryRun: boolean;
  json: boolean;
  diffAgainst?: string;
} {
  const flags: {
    url?: string;
    tool?: string;
    dryRun: boolean;
    json: boolean;
    diffAgainst?: string;
  } = {
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === '--url') {
      const value = args[++i];
      if (value !== undefined) flags.url = value;
    } else if (arg === '--tool') {
      const value = args[++i];
      if (value !== undefined) flags.tool = value;
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--diff-against') {
      const value = args[++i];
      if (value !== undefined) flags.diffAgainst = value;
    }
  }

  return flags;
}

/**
 * Inspect a live MCP server
 */
async function inspectServer(flags: {
  url: string;
  tool?: string;
  dryRun: boolean;
  diffAgainst?: string;
}): Promise<InspectResult> {
  try {
    // Perform MCP handshake
    const handshakeStart = Date.now();
    const serverInfo = await performHandshake(flags.url);
    const handshakeMs = Date.now() - handshakeStart;

    // Get tools/list
    const toolsListStart = Date.now();
    const tools = await getToolsList(flags.url);
    const toolsListMs = Date.now() - toolsListStart;

    // Optional: measure ping
    let pingMs: number | undefined;
    try {
      const pingStart = Date.now();
      await ping(flags.url);
      pingMs = Date.now() - pingStart;
    } catch {
      // Ping not critical
    }

    const latency: LatencyStats = {
      ...(pingMs !== undefined ? { pingMs } : {}),
      toolsListMs,
      handshakeMs,
    };

    // Optional: dry-run a specific tool
    let dryRun: DryRunResult | undefined;
    if (flags.tool && flags.dryRun) {
      dryRun = await executeDryRun(flags.url, flags.tool);
    }

    // Optional: diff against snapshot
    let diffSnapshot: DiffResult | undefined;
    if (flags.diffAgainst) {
      const snapshot = await loadSnapshot(flags.diffAgainst);
      diffSnapshot = computeDiff(snapshot, { server: serverInfo, tools, latency });
    }

    return {
      server: serverInfo,
      tools,
      latency,
      ...(dryRun !== undefined ? { dryRun } : {}),
      ...(diffSnapshot !== undefined ? { diffSnapshot } : {}),
      healthy: true,
    };
  } catch (err) {
    return {
      server: {
        name: 'unknown',
        version: 'unknown',
        protocolVersion: 'unknown',
      },
      tools: [],
      latency: {
        toolsListMs: 0,
        handshakeMs: 0,
      },
      healthy: false,
      error: {
        code: 'CONNECTION_FAILED',
        message: err instanceof Error ? err.message : String(err),
        details: err,
      },
    };
  }
}

/**
 * Perform MCP protocol handshake
 */
async function performHandshake(url: string): Promise<ServerInfo> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: '@askturret/mcp-cli',
          version: '0.1.0',
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as JsonRpcResponse<InitializeResult>;

  if (data.error) {
    throw new Error(`MCP error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }

  const result = data.result;
  if (!result) {
    throw new Error('Missing result in initialize response');
  }

  return {
    name: result.serverInfo?.name ?? 'unknown',
    version: result.serverInfo?.version ?? 'unknown',
    protocolVersion: result.protocolVersion ?? 'unknown',
    ...(result.serverInfo?.registryHash !== undefined ? { registryHash: result.serverInfo.registryHash } : {}),
  };
}

/**
 * Get tools/list from server
 */
async function getToolsList(url: string): Promise<ToolInfo[]> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }),
  });

  if (!response.ok) {
    // Check for auth challenge
    const wwwAuth = response.headers.get('www-authenticate');
    if (response.status === 401 && wwwAuth) {
      throw new Error(
        `Authentication required: ${wwwAuth}\n` +
        `Configure credentials via environment variables or --auth-file.`,
      );
    }
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as JsonRpcResponse<ToolsListResult>;

  if (data.error) {
    throw new Error(`MCP error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }

  const tools = data.result?.tools ?? [];
  return tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
    ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
    ...(t['x-mcp-effects'] !== undefined ? { effects: t['x-mcp-effects'] } : {}),
    ...(t['x-mcp-auth'] !== undefined ? { auth: t['x-mcp-auth'] } : {}),
    ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
  }));
}

/**
 * Ping the server (lightweight health check)
 */
async function ping(url: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'ping',
      params: {},
    }),
  });

  if (!response.ok) {
    throw new Error(`Ping failed: HTTP ${response.status}`);
  }
}

/**
 * Execute a dry-run of a specific tool
 */
async function executeDryRun(url: string, toolName: string): Promise<DryRunResult> {
  const start = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: {}, // Empty args for dry-run
        },
      }),
    });

    const executionMs = Date.now() - start;

    if (!response.ok) {
      return {
        tool: toolName,
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        executionMs,
      };
    }

    const data = (await response.json()) as JsonRpcResponse;

    if (data.error) {
      return {
        tool: toolName,
        success: false,
        error: data.error.message ?? JSON.stringify(data.error),
        executionMs,
      };
    }

    return {
      tool: toolName,
      success: true,
      result: data.result,
      executionMs,
    };
  } catch (err) {
    return {
      tool: toolName,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      executionMs: Date.now() - start,
    };
  }
}

/**
 * Load snapshot from file
 */
async function loadSnapshot(path: string): Promise<Partial<InspectResult>> {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content);
}

/**
 * Compute diff between snapshot and current state
 */
function computeDiff(
  snapshot: Partial<InspectResult>,
  current: Partial<InspectResult>,
): DiffResult {
  const snapshotTools = new Set(snapshot.tools?.map((t) => t.name) ?? []);
  const currentTools = new Set(current.tools?.map((t) => t.name) ?? []);

  const added: string[] = [];
  const removed: string[] = [];

  for (const tool of currentTools) {
    if (!snapshotTools.has(tool)) {
      added.push(tool);
    }
  }

  for (const tool of snapshotTools) {
    if (!currentTools.has(tool)) {
      removed.push(tool);
    }
  }

  // Check for modified schemas (simplified)
  const modified: Array<{ tool: string; changes: string[] }> = [];
  const snapshotToolMap = new Map(snapshot.tools?.map((t) => [t.name, t]) ?? []);
  const currentToolMap = new Map(current.tools?.map((t) => [t.name, t]) ?? []);

  for (const toolName of currentTools) {
    if (snapshotTools.has(toolName)) {
      const oldTool = snapshotToolMap.get(toolName);
      const newTool = currentToolMap.get(toolName);

      if (oldTool && newTool) {
        const changes: string[] = [];

        if (JSON.stringify(oldTool.inputSchema) !== JSON.stringify(newTool.inputSchema)) {
          changes.push('input schema changed');
        }

        if (JSON.stringify(oldTool.effects) !== JSON.stringify(newTool.effects)) {
          changes.push('effects changed');
        }

        if (changes.length > 0) {
          modified.push({ tool: toolName, changes });
        }
      }
    }
  }

  return {
    added,
    removed,
    modified,
    hashChanged: snapshot.server?.registryHash !== current.server?.registryHash,
    ...(snapshot.server?.registryHash !== undefined ? { previousHash: snapshot.server.registryHash } : {}),
    ...(current.server?.registryHash !== undefined ? { currentHash: current.server.registryHash } : {}),
  };
}
