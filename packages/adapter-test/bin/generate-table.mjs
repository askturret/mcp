#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Regenerate the adapter rows of docs/adapters.md from real conformance runs.
 *
 *   npm run conformance:table -w @askturret/mcp-adapter-test > ../../docs/table.md
 *
 * Uses the SAME `withOwnedStdout` helper as the CLI. The first version of this
 * script did not, and had the identical bug the CLI fix had just closed: 518
 * lines of compiler progress ahead of the table, so the document this script
 * exists to produce was not obtainable by redirecting its stdout.
 *
 * That is why the helper is shared rather than reimplemented — a second copy is
 * a second thing to forget.
 */
import { IN_REPO_ADAPTERS, renderConformanceTable, runConformance, withOwnedStdout } from '../dist/index.js';

const stamp = process.env['TABLE_TIMESTAMP'] ?? new Date().toISOString().slice(0, 10);

const reports = await withOwnedStdout(async (out) => {
  const collected = [];
  for (const adapter of IN_REPO_ADAPTERS) {
    // Progress goes to stderr deliberately: stdout is the document.
    process.stderr.write(`running ${adapter.name}…\n`);
    collected.push(await runConformance(adapter));
  }

  // Emitted INSIDE the window, through the captured handle, so it precedes any
  // write an adapter scheduled to land later.
  out(`${renderConformanceTable(collected, stamp)}\n`);
  return collected;
});

if (reports.some((r) => !r.passed)) process.exitCode = 1;
