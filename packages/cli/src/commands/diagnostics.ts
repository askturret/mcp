// SPDX-License-Identifier: Apache-2.0
/**
 * `diagnostics` — produce a redacted support bundle (§13).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { describePreset } from '@askturret/mcp-core';

import { analyzeSpec, loadSpec } from './doctor.js';

import { createTarGz } from './diagnostics-tar.js';
import {
  buildBundleEntries,
  environmentNames,
  type BundleInputs,
} from './diagnostics-bundle.js';

/** Stamped into the bundle; matches the constant the dispatcher emits. */
const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Lines of `--log-file` included. */
export const DEFAULT_LOG_TAIL_LINES = 500;

export interface DiagnosticsFlags {
  readonly url?: string;
  /** OpenAPI spec for the doctor section (§13 item 6). */
  readonly spec?: string;
  readonly config?: string;
  readonly out: string;
  readonly fullSchemas: boolean;
  readonly logFile?: string;
  readonly json: boolean;
  readonly preset?: 'production';
  readonly tailLines: number;
}

export function parseDiagnosticsArgs(args: readonly string[]): DiagnosticsFlags {
  let url: string | undefined;
  let spec: string | undefined;
  let config: string | undefined;
  let out = './bundle.tar.gz';
  let fullSchemas = false;
  let logFile: string | undefined;
  let json = false;
  let preset: 'production' | undefined;
  let tailLines = DEFAULT_LOG_TAIL_LINES;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--url':
        url = args[++i];
        break;
      case '--spec':
        spec = args[++i];
        break;
      case '--config':
        config = args[++i];
        break;
      case '--out':
        out = args[++i] ?? out;
        break;
      case '--log-file':
        logFile = args[++i];
        break;
      case '--tail':
        tailLines = Number.parseInt(args[++i] ?? '', 10) || DEFAULT_LOG_TAIL_LINES;
        break;
      case '--preset':
        preset = args[++i] === 'production' ? 'production' : undefined;
        break;
      case '--full-schemas':
        fullSchemas = true;
        break;
      case '--json':
        json = true;
        break;
      default:
        break;
    }
  }

  return {
    ...(url === undefined ? {} : { url }),
    ...(spec === undefined ? {} : { spec }),
    ...(config === undefined ? {} : { config }),
    out,
    fullSchemas,
    ...(logFile === undefined ? {} : { logFile }),
    json,
    ...(preset === undefined ? {} : { preset }),
    tailLines,
  };
}

/** JSON-RPC POST, kept local so a failure here degrades one section only. */
async function jsonRpc(url: string, method: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'MCP error');
  return body.result;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

/**
 * Collect everything the bundle can reach.
 *
 * Every collector is individually fallible and individually recorded. A
 * support bundle that refused to build because one endpoint was down would be
 * useless precisely when it is needed — the server being unwell is the reason
 * someone is running this. So a failed section becomes an entry in
 * `unavailable` WITH its reason, and the bundle is still produced.
 *
 * Recording the reason rather than omitting the section is the same
 * distinction #47 drew for health: "could not check" must never read as
 * "nothing to report".
 */
export async function collectBundleInputs(
  flags: DiagnosticsFlags,
  now: Date = new Date(),
): Promise<BundleInputs> {
  const unavailable: Record<string, string> = {};

  const versions: Record<string, string> = {
    node: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    mcpProtocol: MCP_PROTOCOL_VERSION,
  };

  let tools: readonly unknown[] | undefined;
  let registry: BundleInputs['registry'];
  let health: unknown;

  if (flags.url !== undefined) {
    try {
      const result = (await jsonRpc(flags.url, 'tools/list')) as { tools?: unknown[] };
      tools = result?.tools ?? [];
      registry = { summary: { toolCount: tools.length } };
    } catch (error) {
      unavailable['tools'] = describeError(error);
    }

    const base = flags.url.replace(/\/+$/, '');
    try {
      health = {
        live: await getJson(`${base}/health/live`),
        ready: await getJson(`${base}/health/ready`),
      };
    } catch (error) {
      unavailable['health'] = describeError(error);
    }
  } else {
    unavailable['tools'] = 'No --url supplied; live server sections were skipped.';
    unavailable['health'] = 'No --url supplied; live server sections were skipped.';
  }

  // `registry` rides on the same live call as `tools`, so it is unreachable
  // for exactly the same reason. Recorded explicitly: QA found it absent with
  // NO reason anywhere, which is the one outcome this bundle's own README
  // says must not happen.
  if (registry === undefined && unavailable['registry'] === undefined) {
    unavailable['registry'] =
      unavailable['tools'] ?? 'Registry summary comes from the live server and was not collected.';
  }

  // §13 item 6 — the doctor readiness analysis.
  //
  // This section previously existed in the type and in the README and was
  // assigned by NO code path, so `doctor.json` could never appear in a
  // CLI-produced bundle while every README promised it. Wired for real rather
  // than recorded as permanently unavailable: `analyzeSpec` and `loadSpec`
  // already exist, so the section is a genuine deliverable rather than one
  // that needs writing off.
  let doctor: unknown;
  if (flags.spec !== undefined) {
    try {
      const isUrl = /^https?:\/\//.test(flags.spec);
      doctor = await analyzeSpec(await loadSpec(flags.spec, isUrl));
    } catch (error) {
      unavailable['doctor'] = describeError(error);
    }
  } else {
    unavailable['doctor'] = 'No --spec supplied; the readiness analysis needs an OpenAPI source.';
  }

  // §13 lists a snapshot of mcp_circuit_breaker_state and mcp_tool_queue_depth.
  // Neither is reachable over the wire: there is no metrics endpoint on the
  // transport, and #46 deliberately left per-breaker state to a read seam
  // (`breakerStats()`) that only an in-process caller can use. Recorded as
  // unavailable with the reason rather than silently dropped. See #156.
  unavailable['runtimeState'] =
    'Breaker and bulkhead state are in-process only; no metrics endpoint is exposed by the transport.';

  let logTail: readonly string[] | undefined;
  if (flags.logFile !== undefined) {
    try {
      const text = await readFile(flags.logFile, 'utf8');
      logTail = text.split('\n').filter(Boolean).slice(-flags.tailLines);
    } catch (error) {
      unavailable['logs'] = describeError(error);
    }
  }

  const paths = [flags.config, flags.logFile, flags.spec].filter(
    (value): value is string => value !== undefined,
  );

  return {
    generatedAt: now.toISOString(),
    versions,
    ...(flags.preset === undefined ? {} : { preset: describePreset(flags.preset) }),
    ...(registry === undefined ? {} : { registry }),
    ...(tools === undefined ? {} : { tools }),
    ...(health === undefined ? {} : { health }),
    ...(doctor === undefined ? {} : { doctor }),
    ...(logTail === undefined ? {} : { logTail }),
    paths,
    envNames: environmentNames(),
    fullSchemas: flags.fullSchemas,
    unavailable,
  };
}

/** Never surface a stack or a type name into an artefact meant for sharing. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export async function diagnosticsCommand(args: string[]): Promise<void> {
  const flags = parseDiagnosticsArgs(args);

  if (args.includes('--help') || args.includes('-h')) {
    printDiagnosticsHelp();
    return;
  }

  const inputs = await collectBundleInputs(flags);
  const entries = buildBundleEntries(inputs);
  const archive = createTarGz(entries);

  await writeFile(flags.out, archive);

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          out: flags.out,
          bytes: archive.length,
          files: entries.map((entry) => entry.name),
          generatedAt: inputs.generatedAt,
          unavailable: inputs.unavailable ?? {},
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Diagnostic bundle written to ${flags.out} (${archive.length} bytes)`);
  console.log('');
  console.log('Contents:');
  for (const entry of entries) console.log(`  ${entry.name}`);

  const unavailable = Object.entries(inputs.unavailable ?? {});
  if (unavailable.length > 0) {
    console.log('');
    console.log('Not collected:');
    for (const [section, reason] of unavailable) console.log(`  ${section}: ${reason}`);
  }

  console.log('');
  console.log('Review the bundle before sharing it — see README.md inside for what');
  console.log('redaction does and does not guarantee.');
}

function printDiagnosticsHelp(): void {
  console.log('');
  console.log('Produce a redacted support bundle.');
  console.log('');
  console.log('Usage:');
  console.log('  npx @askturret/mcp diagnostics --url <url> --out ./bundle.tar.gz');
  console.log('  npx @askturret/mcp diagnostics --config ./askturret.config.ts --out ./bundle.tar.gz');
  console.log('');
  console.log('Options:');
  console.log('  --url <url>         Live MCP endpoint to snapshot');
  console.log('  --spec <path|url>   OpenAPI source for the readiness analysis');
  console.log('  --config <path>     Configuration file (recorded by basename)');
  console.log('  --out <path>        Output archive (default ./bundle.tar.gz)');
  console.log('  --preset production Include the expanded preset');
  console.log('  --log-file <path>   Include a re-redacted tail of this log file');
  console.log(`  --tail <n>          Lines of log tail (default ${DEFAULT_LOG_TAIL_LINES})`);
  console.log('  --full-schemas      Include tool schemas in full');
  console.log('  --json              Machine-readable summary on stdout');
  console.log('');
  console.log('The bundle is written locally. Nothing is uploaded.');
  console.log('');
}
