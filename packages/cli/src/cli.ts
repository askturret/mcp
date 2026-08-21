#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * AskTurret MCP CLI entry point
 */

import { doctorCommand } from './commands/doctor.js';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case 'doctor':
      await doctorCommand(args.slice(1));
      break;

    case '--help':
    case '-h':
    case undefined:
      console.log(`
AskTurret MCP CLI

Usage:
  npx @askturret/mcp doctor <path-to-spec-or-config>   Analyze API readiness
  npx @askturret/mcp doctor --url <mcp-endpoint>       Analyze remote server

Options:
  --json                Output machine-readable JSON
  --help, -h            Show this help message
      `);
      process.exit(0);

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run with --help to see available commands');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
