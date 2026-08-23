// SPDX-License-Identifier: Apache-2.0
/**
 * Building the support bundle (§13).
 *
 * Everything that reaches an entry goes through #49's central pipeline at
 * `surface: 'diagnostic-bundle'`. Nothing here implements redaction of its
 * own — #49 exists to be the single point of truth for what leaves the
 * process, and a support bundle growing a second, parallel implementation is
 * precisely how that claim stops being true.
 */

import { basename } from 'node:path';
import { redactValue } from '@askturret/mcp-core';

import type { TarEntry } from './diagnostics-tar.js';

/** How much of each schema survives without `--full-schemas`. */
export const SCHEMA_TRUNCATE_CHARS = 400;

export interface BundleInputs {
  readonly generatedAt: string;
  readonly versions: Record<string, string>;
  /** Preset expansion, if a preset was named. */
  readonly preset?: unknown;
  readonly registry?: { readonly hash?: string; readonly summary?: unknown };
  readonly tools?: readonly unknown[];
  readonly health?: unknown;
  readonly doctor?: unknown;
  readonly runtimeState?: unknown;
  readonly logTail?: readonly string[];
  /** Absolute paths seen; only basenames are emitted. */
  readonly paths?: readonly string[];
  /** Environment variable NAMES. Values are never accepted here. */
  readonly envNames?: readonly string[];
  readonly fullSchemas?: boolean;
  /** Sections that could not be collected, and why. */
  readonly unavailable?: Record<string, string>;
}

/**
 * Redact for the bundle surface.
 *
 * A named wrapper rather than an inline call at eight sites: it is the one
 * place the surface id is written, so it cannot be typo'd into a surface with
 * different rules at one call site and not another.
 */
export function redactForBundle<T>(value: T): T {
  return redactValue('diagnostic-bundle', value) as T;
}

/**
 * Credential-shaped SUBSTRINGS, for free-text lines.
 *
 * ## Why this exists alongside #49 rather than inside it
 *
 * #49 matches whole VALUES: a field either is a JWT or it is not. That is the
 * right semantics for structured data, and deliberately so — a substring
 * matcher over structured values is how you end up redacting half a URL.
 *
 * A log LINE is not structured. `GET /pets auth=eyJhbGci...` is one string
 * whose credential sits in the middle, so a whole-value rule cannot see it,
 * and §13 asks specifically for the tail to be scrubbed of "residual
 * leakage". Applying substring matching to free text only — never to the
 * structured sections — keeps both properties.
 *
 * Only the ANCHORED, high-precision patterns are used. The entropy heuristic
 * is deliberately absent for the reason #49 documented: as a substring rule
 * it would eat ordinary log content.
 */
const FREE_TEXT_PATTERNS: readonly RegExp[] = [
  // JWTs.
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Authorization headers, however they are spelled in a log line.
  /\b(bearer|basic)\s+\S{8,}/gi,
  // PEM blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Mask credential-shaped substrings, preserving the rest of the line.
 *
 * In-place masking rather than dropping the line: a support engineer needs
 * the surrounding request context, and a line replaced wholesale tells them
 * nothing about what was happening when it was written.
 */
export function scrubFreeText(line: string): string {
  let out = line;
  for (const pattern of FREE_TEXT_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

/**
 * Environment variables, by NAME only.
 *
 * The values are never read — not read-then-redacted, never read. §13 asks
 * for names only, and the difference matters: a redaction rule can be wrong,
 * whereas a value that was never loaded cannot leak however wrong the rules
 * are. This is the one place in the bundle that does not rely on #49 being
 * correct.
 */
export function environmentNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).sort();
}

/** Paths appear as basenames — directory layout is an information leak of its own. */
export function pathBasenames(paths: readonly string[]): string[] {
  return paths.map((path) => basename(path));
}

function truncateSchemas(tools: readonly unknown[], full: boolean): unknown[] {
  if (full) return [...tools];

  return tools.map((tool) => {
    if (tool === null || typeof tool !== 'object') return tool;
    const record = { ...(tool as Record<string, unknown>) };

    for (const key of ['inputSchema', 'outputSchema']) {
      const schema = record[key];
      if (schema === undefined) continue;

      const serialized = JSON.stringify(schema);
      if (serialized !== undefined && serialized.length > SCHEMA_TRUNCATE_CHARS) {
        // Replaced with a NOTE, not silently shortened. A truncated JSON blob
        // that no longer parses is worse than an honest marker: a support
        // engineer who sees this knows to ask for --full-schemas, whereas a
        // clipped object looks like a malformed schema on the server.
        record[key] = {
          truncated: true,
          originalBytes: serialized.length,
          note: 'Schema omitted for size. Re-run with --full-schemas to include it.',
        };
      }
    }
    return record;
  });
}

/**
 * One-line description per bundle file, keyed by the filename itself.
 *
 * Data rather than prose so the README can be generated FROM the entries a
 * run actually produced. See `bundleReadme` for why that matters.
 */
const FILE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'metadata.json': 'generation time, tool versions, what was collected.',
  'versions.json': 'package, Node, OS/arch and MCP protocol versions.',
  'configuration.json': 'expanded preset, env var names, path basenames.',
  'registry.json': 'registry hash and operation summary.',
  'tools.json': 'tool definitions as `tools/list` returns them, principal-agnostic.',
  'health.json': 'live/ready endpoint responses.',
  'doctor.json': 'readiness analysis against the supplied OpenAPI spec.',
  'runtime-state.json': 'breaker and bulkhead state.',
  'logs.txt': 'tail of the supplied log file, re-redacted.',
  'README.md': 'this file.',
};

/**
 * The bundle's own README (§13, acceptance).
 *
 * ## The Files list is generated from the ACTUAL entries
 *
 * It used to be a static enumeration of all nine §13 items, printed whatever
 * a run produced. QA caught it: a realistic run emits five files while the
 * README promised nine, which contradicted this bundle's own line three
 * paragraphs down — "an absent section should never be mistaken for an empty
 * one" — and #47's rule that "could not check" must never read as "nothing to
 * report".
 *
 * It also falsified the claim this doc-comment used to make. Taking the
 * filenames from `entries` is what makes "what it claims and what is present
 * cannot drift" true rather than merely stated: the list cannot mention a
 * file the archive does not contain, because it is derived from the archive.
 */
export function bundleReadme(inputs: BundleInputs, filenames: readonly string[] = []): string {
  const unavailable = Object.entries(inputs.unavailable ?? {});

  return [
    '# AskTurret MCP diagnostic bundle',
    '',
    `Generated: ${inputs.generatedAt}`,
    '',
    '## What this bundle IS',
    '',
    'A point-in-time snapshot, produced locally, intended to be attached to a',
    'support request. Nothing was uploaded anywhere: this tool does not call home.',
    '',
    '## Redaction guarantees',
    '',
    '- Every string in every file below was passed through the central redaction',
    "  pipeline at `surface: 'diagnostic-bundle'` — the same pipeline that guards",
    '  logs, spans, metrics, audit records, the Explorer and serialized errors.',
    '- Environment variables appear by NAME ONLY. Their values are never read by',
    '  this tool, so they cannot leak even if a redaction rule is wrong.',
    '- File paths appear as basenames. Directory layout is not included.',
    '',
    '## Redaction LIMITS — please read before sharing',
    '',
    '- Redaction matches known key names and credential-shaped values. A secret',
    '  with no recognisable name and no recognisable shape (for example a short',
    '  opaque token under a field called `note`) may NOT be detected.',
    '- **Review this bundle before you send it.** These guarantees reduce risk;',
    '  they do not replace a look.',
    '',
    '## What is NOT included',
    '',
    '- Request or response payloads.',
    '- Audit records — those stay in their sink.',
    '- Any live capture of traffic. This is a snapshot, not a packet trace.',
    '- Environment variable values (see above).',
    '',
    '## Files in THIS bundle',
    '',
    ...filenames.map(
      (name) => `- \`${name}\` — ${FILE_DESCRIPTIONS[name] ?? 'see contents.'}`,
    ),
    ...(filenames.includes('tools.json')
      ? [
          inputs.fullSchemas === true
            ? '  Schemas are included in full (`--full-schemas`).'
            : `  Schemas over ${SCHEMA_TRUNCATE_CHARS} bytes are replaced with a marker; re-run with \`--full-schemas\`.`,
        ]
      : []),
    '',
    ...(unavailable.length === 0
      ? []
      : [
          '## Sections that could not be collected',
          '',
          'Listed explicitly rather than omitted silently — an absent section',
          'should never be mistaken for an empty one.',
          '',
          ...unavailable.map(([section, reason]) => `- \`${section}\`: ${reason}`),
          '',
        ]),
  ].join('\n');
}

/**
 * Assemble every bundle entry.
 *
 * The redaction pass is applied HERE, once, to each section's finished value
 * — not at each collector. One place to audit, and no collector can forget.
 */
export function buildBundleEntries(inputs: BundleInputs): TarEntry[] {
  const entries: TarEntry[] = [];

  const json = (name: string, value: unknown): void => {
    entries.push({ name, content: `${JSON.stringify(redactForBundle(value), null, 2)}\n` });
  };

  json('metadata.json', {
    generatedAt: inputs.generatedAt,
    fullSchemas: inputs.fullSchemas === true,
    sections: {
      versions: true,
      configuration: true,
      registry: inputs.registry !== undefined,
      tools: inputs.tools !== undefined,
      health: inputs.health !== undefined,
      doctor: inputs.doctor !== undefined,
      runtimeState: inputs.runtimeState !== undefined,
      logs: inputs.logTail !== undefined,
    },
    unavailable: inputs.unavailable ?? {},
  });

  json('versions.json', inputs.versions);

  json('configuration.json', {
    preset: inputs.preset ?? null,
    environmentVariableNames: inputs.envNames ?? [],
    paths: pathBasenames(inputs.paths ?? []),
  });

  if (inputs.registry !== undefined) json('registry.json', inputs.registry);
  if (inputs.tools !== undefined) {
    json('tools.json', truncateSchemas(inputs.tools, inputs.fullSchemas === true));
  }
  if (inputs.health !== undefined) json('health.json', inputs.health);
  if (inputs.doctor !== undefined) json('doctor.json', inputs.doctor);
  if (inputs.runtimeState !== undefined) json('runtime-state.json', inputs.runtimeState);

  if (inputs.logTail !== undefined) {
    // Re-redacted even though the emitting process already redacted these
    // lines. A log file can predate the redaction pipeline, can come from a
    // differently-configured process, or can have been hand-edited — and §13
    // is explicit that the tail is sanitised for "residual leakage".
    const redacted = inputs.logTail.map((line) =>
      // Both passes: the structured pipeline first (so a key-shaped log line
      // is handled identically to everywhere else), then the free-text
      // scrubber for credentials embedded mid-line.
      scrubFreeText(redactForBundle({ line }).line),
    );
    entries.push({ name: 'logs.txt', content: `${redacted.join('\n')}\n` });
  }

  // README last, and built FROM the entries above plus its own name — so the
  // Files list it prints is the archive's actual contents by construction,
  // not a parallel enumeration that can drift from them.
  const filenames = [...entries.map((entry) => entry.name), 'README.md'];
  entries.push({ name: 'README.md', content: `${bundleReadme(inputs, filenames)}\n` });

  return entries;
}
