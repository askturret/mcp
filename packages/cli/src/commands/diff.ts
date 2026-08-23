// SPDX-License-Identifier: Apache-2.0
/**
 * `diff` command — compare two registry snapshots (§13).
 *
 * Turns the MCP surface into a governed contract: a non-zero exit is what lets
 * CI refuse a release whose tool surface broke without a major version bump.
 */

import { readFile } from 'fs/promises';
import { stat } from 'fs/promises';
import {
  deserializeSnapshot,
  diffSnapshots,
  SnapshotFormatError,
  type DiffReport,
  type EffectClassification,
  type RegistrySnapshot,
} from '@askturret/mcp-core';
import { formatHumanReadable, formatJson } from './diff-output.js';

/**
 * Exit codes, matching the convention `inspect` established:
 *
 * - `0` — no breaking changes (or breaking changes explicitly allowed).
 * - `1` — at least one breaking change, and `--allow-breaking` was not passed.
 *   This is the release gate.
 * - `2` — usage error, or a snapshot that could not be read or parsed.
 *
 * The 1/2 split matters more here than anywhere else in the CLI: a gate that
 * exits non-zero for BOTH "the surface broke" and "I could not read the file"
 * teaches operators to treat every failure as a config problem, and the first
 * real breaking change gets waved through. "I could not check" is not "it
 * passed", and it is not "it failed" either.
 */
export const EXIT_OK = 0;
export const EXIT_BREAKING = 1;
export const EXIT_USAGE = 2;

interface DiffFlags {
  before?: string;
  after?: string;
  json: boolean;
  allowBreaking: boolean;
  renameHints?: string;
  confirmFor?: string;
  help: boolean;
}

export async function diffCommand(args: string[]): Promise<void> {
  const flags = parseArgs(args);

  if (flags.help) {
    printDiffHelp();
    process.exit(EXIT_OK);
  }

  if (!flags.before || !flags.after) {
    console.error('Error: diff requires both --before and --after');
    console.error('');
    console.error('Usage: npx @askturret/mcp diff --before <snapshot.json> --after <snapshot.json>');
    console.error('Run `npx @askturret/mcp diff --help` for the classification rubric.');
    process.exit(EXIT_USAGE);
  }

  let before: RegistrySnapshot;
  let after: RegistrySnapshot;
  try {
    before = await loadSnapshot(flags.before, '--before');
    after = await loadSnapshot(flags.after, '--after');
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_USAGE);
  }

  let renames: Record<string, string> | undefined;
  if (flags.renameHints !== undefined) {
    try {
      renames = await loadRenameHints(flags.renameHints);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(EXIT_USAGE);
    }
  }

  const confirmFor = flags.confirmFor
    ?.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as readonly EffectClassification[] | undefined;

  const report: DiffReport = diffSnapshots(before, after, {
    ...(renames === undefined ? {} : { renames }),
    ...(confirmFor === undefined ? {} : { confirmFor }),
  });

  console.log(flags.json ? formatJson(report) : formatHumanReadable(report));

  if (report.hasBreaking && !flags.allowBreaking) {
    if (!flags.json) {
      console.error('');
      console.error(
        `Breaking changes detected (${report.summary.breaking}). ` +
          'Pass --allow-breaking to accept them, or bump the major version.',
      );
    }
    process.exit(EXIT_BREAKING);
  }

  process.exit(EXIT_OK);
}

/**
 * Resolve a `--before`/`--after` argument to a snapshot.
 *
 * ## Supported: a file path, or an http(s) URL
 *
 * ## NOT supported, and why — flagged for QA
 *
 * §13's usage examples also show `--before <hash>` and `--before v1.2.3`. Both
 * resolve an identifier against a STORE of past snapshots, and no such store
 * exists in this repository — there is no snapshot registry, no content-address
 * lookup, and no tag index. Implementing them would mean inventing that
 * storage layer, which is a separate deliverable with its own design.
 *
 * `--after ./` (compile the working tree) is likewise not supported: the CLI
 * has no spec-to-snapshot path today. `doctor` parses OpenAPI with its own
 * parser and never builds a `RegistrySnapshot`, and the CLI package does not
 * depend on `@askturret/mcp-sources-openapi` or the compiler.
 *
 * These fail with an explicit message naming what is missing, rather than being
 * quietly misread as a filename that does not exist.
 */
async function loadSnapshot(reference: string, flag: string): Promise<RegistrySnapshot> {
  if (/^https?:\/\//i.test(reference)) {
    const response = await fetch(reference);
    if (!response.ok) {
      throw new Error(`${flag}: fetching ${reference} failed with HTTP ${response.status}`);
    }
    return parse(await response.text(), reference, flag);
  }

  if (looksLikeVersionTag(reference)) {
    throw new Error(
      `${flag}: '${reference}' looks like a version tag, which is not supported yet. ` +
        'Resolving a tag needs a snapshot store, and none exists yet. ' +
        'Pass a path to a snapshot JSON file, or an http(s) URL.',
    );
  }

  let isDirectory = false;
  try {
    isDirectory = (await stat(reference)).isDirectory();
  } catch {
    // Fall through to readFile, whose ENOENT message names the path.
  }

  if (isDirectory) {
    throw new Error(
      `${flag}: '${reference}' is a directory. Compiling a live project into a snapshot is not ` +
        'supported yet — the CLI has no spec-to-snapshot path. Pass a snapshot JSON file.',
    );
  }

  let text: string;
  try {
    text = await readFile(reference, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // The store hint is attached here rather than behind a hash-shape test.
      // A content hash is just an opaque token — any pattern tight enough to
      // recognise one would also reject legitimate filenames, and any pattern
      // loose enough not to would fire on ordinary typos. Since a hash and a
      // mistyped path are indistinguishable at this point, say both (#40 QA).
      throw new Error(
        `${flag}: no such file '${reference}'. ` +
          'Expected a path to a snapshot JSON file, or an http(s) URL. ' +
          'If you meant a content hash or a version tag, resolving one needs a ' +
          'snapshot store, and none exists yet.',
      );
    }
    throw new Error(`${flag}: could not read '${reference}': ${String(error)}`);
  }

  return parse(text, reference, flag);
}

function parse(text: string, reference: string, flag: string): RegistrySnapshot {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${flag}: '${reference}' is not valid JSON: ${String(error)}`);
  }

  try {
    return deserializeSnapshot(json);
  } catch (error) {
    if (error instanceof SnapshotFormatError) {
      throw new Error(`${flag}: '${reference}' is not a valid snapshot — ${error.message}`);
    }
    throw error;
  }
}

/** `v1.2.3`, `1.2.3` — a semver-shaped token, not a path. */
function looksLikeVersionTag(reference: string): boolean {
  return /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(reference);
}

async function loadRenameHints(path: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    throw new Error(`--rename-hints: could not read '${path}'`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`--rename-hints: '${path}' is not valid JSON: ${String(error)}`);
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(`--rename-hints: '${path}' must be a JSON object.`);
  }

  // §13 shows `renamed: { oldId: newId }`. A bare `{ oldId: newId }` map is
  // accepted too, because that is what most people write on the first try and
  // rejecting it teaches nothing.
  const record = json as Record<string, unknown>;
  const source = 'renamed' in record ? record['renamed'] : record;

  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error(`--rename-hints: '${path}' must map old operation ids to new ones.`);
  }

  const out: Record<string, string> = {};
  for (const [oldId, newId] of Object.entries(source as Record<string, unknown>)) {
    if (typeof newId !== 'string') {
      throw new Error(`--rename-hints: value for '${oldId}' must be a string operation id.`);
    }
    out[oldId] = newId;
  }
  return out;
}

function parseArgs(args: string[]): DiffFlags {
  const flags: DiffFlags = { json: false, allowBreaking: false, help: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === '--before') {
      const value = args[++i];
      if (value !== undefined) flags.before = value;
    } else if (arg === '--after') {
      const value = args[++i];
      if (value !== undefined) flags.after = value;
    } else if (arg === '--rename-hints') {
      const value = args[++i];
      if (value !== undefined) flags.renameHints = value;
    } else if (arg === '--confirm-for') {
      const value = args[++i];
      if (value !== undefined) flags.confirmFor = value;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--allow-breaking') {
      flags.allowBreaking = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    }
  }

  return flags;
}

/**
 * §13 Acceptance: "Snapshot classification rubric documented in the CLI's
 * `--help`."
 *
 * The rubric is here rather than in a doc file because the acceptance criterion
 * is specifically about `--help`: the person deciding whether a red build is a
 * real break is at a terminal, and sending them to a website is how the gate
 * gets overridden without being read.
 */
export function printDiffHelp(): void {
  console.log(`
Compare two registry snapshots and classify what changed.

Usage:
  npx @askturret/mcp diff --before <snapshot.json> --after <snapshot.json> [options]

Options:
  --before <path|url>     Baseline snapshot (file path or http(s) URL)
  --after  <path|url>     Candidate snapshot
  --json                  Machine-readable output for CI
  --allow-breaking        Exit 0 even when breaking changes are found
  --rename-hints <path>   JSON file of known renames: { "oldId": "newId" }
                          (a { "renamed": { ... } } wrapper is also accepted)
  --confirm-for <list>    Comma-separated effect classifications that require
                          confirmation under your policy.
                          Default: financial,destructive
  -h, --help              Show this rubric

Exit codes:
  0   No breaking changes, or --allow-breaking was passed
  1   At least one breaking change
  2   Usage error, or a snapshot could not be read or parsed

CLASSIFICATION RUBRIC

  BREAKING — an existing agent workflow stops working
    operation-removed                    an operation is gone
    operation-renamed                    its id changed (callers use the id)
    input-required-field-added           a request that was valid now is not
    input-type-narrowed                  accepted types reduced
    input-enum-reduced                   accepted values reduced, or an enum
                                         introduced where any value was allowed
    input-constraint-tightened           a bound got stricter (minimum raised,
                                         maxLength lowered, and so on)
    input-additional-properties-removed  extra properties no longer permitted
    output-field-removed                 a promised field is gone
    output-type-widened                  a promised type may now be something
                                         the caller cannot handle
    effects-tightened                    readOnly/idempotent/retryable true->false,
                                         or idempotencyKeyRequired false->true
    confirmation-now-required            gained a classification that triggers a
                                         confirmation challenge (see --confirm-for)

  DOUBLE-CHECK — nothing breaks, but the declared intent changed
    effects-loosened                     readOnly/idempotent false->true. Agents
                                         can retry, so nothing breaks — but a
                                         mutation mislabelled read-only is how
                                         that goes wrong.
    effects-classification-removed       declares less risk than before
    confirmation-no-longer-required      no longer prompts for acknowledgement

  AMBIGUOUS — diff declines to classify
    operation-possibly-renamed           a removed and an added operation have
                                         identical contracts. Diff does NOT
                                         assume a rename: the removal is still
                                         reported as breaking. Supply
                                         --rename-hints to classify deliberately.

  NON-BREAKING
    operation-added, input-optional-field-added, input-field-removed,
    output-field-added, effects-classification-added, name-changed,
    description-changed, annotations-changed

  NOT COMPARED
    provenance    Records where a field came from during compilation. It moves
                  whenever the pipeline is touched and never affects a caller.

TWO RULES THIS COMMAND CANNOT FULLY EVALUATE

  Architecture doc §13 lists six breaking categories. Two are not functions of
  two snapshots, and diff says so rather than reporting a clean result it did
  not actually establish:

  * Visibility change (an operation now requiring a new permission) is NOT
    evaluated at all. Permissions are not in a snapshot — they come from
    permissionPolicy(...) in the server's runtime configuration, and
    OperationDefinition has no permission field. Comparing two snapshots
    cannot see a permission change of any kind.

  * Confirmation change is evaluated ONLY under the assumption you supply via
    --confirm-for. Whether a tool prompts is (its classifications) intersected
    with (the policy's confirm-for set); only the first half is in the
    snapshot. Diff detects a tool GAINING a triggering classification. It
    cannot detect the POLICY changing which classifications trigger.
`);
}
