#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * `npx @askturret/mcp-gateway` (#57, §11.3).
 *
 * Everything decidable lives in `config.ts`, `preset.ts` and `server.ts`; this
 * file is the process shell — read argv, read the file, start, wire signals.
 * Keeping it thin is what lets the tests drive the gateway in-process through
 * `startGateway` rather than by spawning a child and parsing its stdout.
 */

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  GatewayConfigError,
  HELP_TEXT,
  parseArgs,
  parseConfigFile,
  resolveConfig,
  type PartialGatewayConfig,
} from './config.js';
import { startGateway, type RunningGateway } from './server.js';
import { GATEWAY_VERSION } from './version.js';

/**
 * Resolve argv into a running gateway.
 *
 * Split out from `main` so a test can exercise the whole argv → listening path
 * without touching `process.exit`.
 */
export async function runFromArgv(argv: readonly string[]): Promise<RunningGateway> {
  const parsed = parseArgs(argv);

  let fileLayer: PartialGatewayConfig = {};
  if (parsed.configPath !== undefined) {
    const text = await readFile(parsed.configPath, 'utf8');
    fileLayer = parseConfigFile(text, parsed.configPath);
  }

  return startGateway(resolveConfig(fileLayer, parsed.config));
}

/**
 * Process entry point.
 *
 * A configuration error exits 2, not 1: an operator scripting a deployment can
 * then tell "you typed something wrong" from "it started and then died", which
 * a single failure code collapses.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${describe(error)}\n`);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${GATEWAY_VERSION}\n`);
    return 0;
  }

  let gateway: RunningGateway;
  try {
    gateway = await runFromArgv(argv);
  } catch (error) {
    // A RegulatedPresetRefusal lands here with its own message, which already
    // names the control and the fix. It is printed verbatim rather than
    // summarised — see preset.ts for why the gateway does not paraphrase it.
    process.stderr.write(`${describe(error)}\n`);
    return error instanceof GatewayConfigError ? 2 : 1;
  }

  // SIGTERM is what a container runtime sends; SIGINT is Ctrl-C. Both run the
  // §8.6 sequence, so an audit record written just before the stop is flushed
  // rather than lost with the process.
  const stop = (signal: string): void => {
    process.stderr.write(`Received ${signal}, shutting down\n`);
    void gateway.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  // Resolve never: the process stays up until a signal arrives.
  return new Promise<number>(() => {});
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Is this module the process entry point?
 *
 * `import.meta.url` compared against argv[1], because this is an ES module and
 * the check must not fire when a test imports the file.
 *
 * `import.meta.url` is a percent-encoded, symlink-resolved URL; a hand-built
 * `file://${argv[1]}` is neither. So argv[1] has to be normalised TWO ways, and
 * both fail SILENTLY when missed — the process starts, does nothing, exits 0:
 *
 *   1. **Percent-encoding** — `import.meta.url` is a URL, so any space in the
 *      install path breaks the comparison: a file under `/opt/my app/` arrives
 *      as `file:///opt/my%20app/...` while the template literal keeps the space.
 *   2. **Symlinks** — node reports the RESOLVED path in `import.meta.url`, so
 *      launching through a symlinked directory (an agent worktree, a
 *      `node_modules/.bin` shim, `/tmp` on macOS) mismatches unless argv[1] is
 *      realpath'd too.
 *
 * A relative INVOCATION is not a third mode, though an earlier version of this
 * comment claimed it was (#184). Node resolves argv[1] to an absolute,
 * normalised path before the module runs, so `node dist/cli.js`,
 * `node ./dist/cli.js` and `node ../pkg/dist/cli.js` all compare EQUAL under
 * the old idiom. Dropping the claim strengthens the argument rather than
 * weakening it: the real trigger is a space in the install path, which is far
 * easier to hit by accident than anything about how the command was typed.
 *
 * That correction also revises what shipped. This was wrong in #57 and fixed in
 * #128, but it did NOT break the container: `/app` holds no space and no
 * symlink, so neither mode above can fire there, and a rebuilt pre-fix image
 * runs fine (#184). What it broke is any checkout whose path contains a space —
 * which is where it actually surfaced.
 *
 * The unit tests could not see any of it: they import `main` and `runFromArgv`
 * directly, so this branch was never the thing under test. `cli.test.ts` now
 * spawns the built file to close exactly that gap.
 */
function isProcessEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    // argv[1] does not resolve to a real file. Not the entry point, and not
    // worth crashing over — the caller is doing something unusual.
    return false;
  }
}

const invokedDirectly = isProcessEntryPoint();

if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
