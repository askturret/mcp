#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { runCli } from '../dist/cli.js';

// The REPORT is written by runCli through the captured stdout handle, inside
// the window where stdout is owned. `log` here carries only the things emitted
// outside that window — help and --version — so nothing is printed twice.
const code = await runCli(process.argv.slice(2), {
  log: (text) => console.log(text),
  error: (text) => console.error(text),
});

process.exitCode = code;
