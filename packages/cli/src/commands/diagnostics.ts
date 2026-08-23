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
  sanitizeErrorText,
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
  /**
   * §52's Regulated-only bundle: strip schemas and config paths.
   *
   * Separate from `--preset regulated` on purpose. This flag governs what the
   * BUNDLE discloses, and a regulated organisation may well want the tighter
   * bundle from a server running any preset — for instance when sending a
   * diagnostic to a vendor. Tying the two together would mean choosing between
   * a preset and a disclosure level.
   */
  readonly regulated: boolean;
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
  let regulated = false;

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
      case '--regulated':
        regulated = true;
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
    // --regulated WINS over --full-schemas rather than the last flag winning.
    // The two are contradictory, and the safe resolution of a contradiction
    // about disclosure is the narrower one: someone who passes both has more
    // likely inherited --full-schemas from a saved command line than decided
    // to widen a regulated bundle.
    fullSchemas: regulated ? false : fullSchemas,
    ...(logFile === undefined ? {} : { logFile }),
    json,
    ...(preset === undefined ? {} : { preset }),
    tailLines,
    regulated,
  };
}

/** Schema-bearing fields stripped from a tool entry under `--regulated`. */
const SCHEMA_FIELDS = ['inputSchema', 'outputSchema', 'schema'] as const;

/**
 * Remove schemas from a tools/list entry (§52 Regulated-only diagnostics).
 *
 * A tool's input schema describes the shape of its arguments — field names,
 * enums, formats — which for a regulated adopter is a description of their
 * internal data model, not just their API surface. The tool NAMES are kept: a
 * bundle that could not say which tools exist would not be a diagnostic.
 */
function stripSchemas(tool: unknown): unknown {
  if (tool === null || typeof tool !== 'object') return tool;

  const copy: Record<string, unknown> = { ...(tool as Record<string, unknown>) };
  for (const field of SCHEMA_FIELDS) delete copy[field];
  return copy;
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

  // §52 Regulated-only diagnostics: no config paths.
  //
  // A filesystem path is a disclosure in its own right — it names deployment
  // layout, usernames in home directories, and internal hostnames in mount
  // points. The sanitiser (#50) scrubs values found INSIDE collected content;
  // these are the paths the operator supplied on the command line, and under
  // --regulated they are withheld entirely rather than sanitised.
  //
  // Withheld with a stated reason, never silently: an empty `paths` array that
  // meant "none supplied" and "deliberately removed" interchangeably is exactly
  // the ambiguity this bundle's own contract forbids.
  const paths = flags.regulated
    ? []
    : [flags.config, flags.logFile, flags.spec].filter(
        (value): value is string => value !== undefined,
      );

  if (flags.regulated) {
    unavailable['paths'] =
      'Withheld by --regulated: filesystem paths disclose deployment layout and are omitted ' +
      'from a regulated bundle.';
    unavailable['schemas'] =
      'Withheld by --regulated: tool input/output schemas describe the adopter data model and ' +
      'are stripped from a regulated bundle. Tool names are retained.';
  }

  const disclosedTools =
    tools === undefined ? undefined : flags.regulated ? tools.map(stripSchemas) : tools;

  return {
    generatedAt: now.toISOString(),
    versions,
    ...(flags.preset === undefined ? {} : { preset: describePreset(flags.preset) }),
    ...(registry === undefined ? {} : { registry }),
    ...(disclosedTools === undefined ? {} : { tools: disclosedTools }),
    ...(health === undefined ? {} : { health }),
    ...(doctor === undefined ? {} : { doctor }),
    ...(logTail === undefined ? {} : { logTail }),
    paths,
    envNames: environmentNames(),
    fullSchemas: flags.fullSchemas,
    unavailable,
  };
}

/**
 * Never surface a stack, a type name, a credential or a filesystem layout
 * into an artefact meant for sharing.
 *
 * Returning `error.message` verbatim was the leak QA found: Node embeds the
 * operator's own input in its error strings, so a credentialed `--url` and a
 * typo'd `--spec` both ended up written into the bundle. Sanitised at THIS
 * seam because it is the single point every collector's failure passes
 * through — the alternative is remembering at each of the five call sites.
 */
function describeError(error: unknown): string {
  // Duck-typed on `message` rather than `instanceof Error`.
  //
  // Not a style choice: a rejection that crosses a realm boundary — a VM
  // context, a worker, jest's module registry — is a genuine Error whose
  // prototype comes from a DIFFERENT realm, so `instanceof` is false and the
  // real message was being discarded as 'unknown error'.
  //
  // That mattered twice over. It threw away the diagnostic an operator needs,
  // and it made this leak untestable: under jest the credentialed-URL
  // rejection reported 'unknown error', so an end-to-end test would have
  // passed with the sanitiser reverted. Found while writing exactly that test.
  const message =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : 'unknown error';

  return sanitizeErrorText(message);
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
