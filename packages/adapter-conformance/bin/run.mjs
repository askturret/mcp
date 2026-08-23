#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * `npm run test:conformance [-- --adapter <name>]` (§42 "Running the suite").
 *
 * Exists because Jest REJECTS unknown CLI flags: passing `--adapter express`
 * straight through produces `Unrecognized option "adapter"` and a non-zero exit
 * before a single test runs. Verified, not assumed — it is what happens.
 *
 * So the flag is translated into an environment variable here and read back by
 * `selectedAdapters()`. The documented invocation keeps working; Jest only ever
 * sees flags it knows.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const flagIndex = argv.indexOf('--adapter');
let adapter;
if (flagIndex !== -1) {
  adapter = argv[flagIndex + 1];
  if (adapter === undefined || adapter.startsWith('--')) {
    console.error('--adapter requires a value, e.g. --adapter express');
    process.exit(2);
  }
  argv.splice(flagIndex, 2);
}

const result = spawnSync('npx', ['jest', ...argv], {
  cwd: packageDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --experimental-vm-modules`.trim(),
    ...(adapter === undefined ? {} : { CONFORMANCE_ADAPTER: adapter }),
  },
});

process.exit(result.status ?? 1);
