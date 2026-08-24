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

// `import.meta.url` comparison rather than `require.main === module`: this is an
// ES module, and the check must not fire when a test imports this file.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
