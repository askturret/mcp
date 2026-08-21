#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * AskTurret MCP CLI entry point
 */

import { doctorCommand } from './commands/doctor.js';
import { inspectCommand } from './commands/inspect.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case 'doctor':
      await doctorCommand(args.slice(1));
      break;

    case 'inspect':
      await inspectCommand(args.slice(1));
      break;

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      process.exit(0);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('');
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  console.log('');
  console.log('AskTurret MCP CLI');
  console.log('');
  console.log('Usage:');
  console.log('  npx @askturret/mcp <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  doctor <spec>           Analyze OpenAPI spec for MCP readiness (offline)');
  console.log('  doctor --url <url>      Analyze remote MCP server readiness');
  console.log('  inspect --url <url>     Inspect a running MCP server (live)');
  console.log('  help                    Show this help message');
  console.log('');
  console.log('Examples:');
  console.log('  npx @askturret/mcp doctor ./openapi.yaml');
  console.log('  npx @askturret/mcp doctor --url http://localhost:7000/mcp');
  console.log('  npx @askturret/mcp inspect --url http://localhost:7000/mcp');
  console.log('  npx @askturret/mcp inspect --url ... --tool createOrder --dry-run');
  console.log('');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
