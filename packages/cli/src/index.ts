// SPDX-License-Identifier: Apache-2.0
/**
 * AskTurret MCP - CLI Tools
 *
 * Doctor, inspect, diff, and diagnostics commands.
 */

export * from './types.js';
export * from './commands/doctor-types.js';
export * from './commands/inspect-types.js';
export { doctorCommand } from './commands/doctor.js';
export { inspectCommand } from './commands/inspect.js';
export { diagnosticsCommand, collectBundleInputs, parseDiagnosticsArgs } from './commands/diagnostics.js';
export {
  buildBundleEntries,
  bundleReadme,
  environmentNames,
  pathBasenames,
  redactForBundle,
} from './commands/diagnostics-bundle.js';
export type { BundleInputs } from './commands/diagnostics-bundle.js';
export { createTarGz, TarNameTooLongError } from './commands/diagnostics-tar.js';
export type { TarEntry } from './commands/diagnostics-tar.js';
