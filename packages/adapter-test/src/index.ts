// SPDX-License-Identifier: Apache-2.0
/**
 * `@askturret/mcp-adapter-test` — the adapter conformance kit (§12.2, #54).
 *
 * The assertions live in `@askturret/mcp-adapter-conformance` and are imported,
 * never copied: §54 asks for the bank "verbatim", and an import is the only way
 * to keep that true past the day it is written.
 */

export {
  AdapterContractError,
  KIT_VERSION,
  RESULT_SCHEMA_VERSION,
  assertAdapterUnderTest,
  generateBadge,
  knownCategoryNames,
  renderReport,
  runConformance,
  type AdapterUnderTest,
  type ConformanceCategoryReport,
  type ConformanceReport,
  type RunConformanceOptions,
  type TestServerConfig,
} from './kit.js';

export {
  loadAdapter,
  parseArgs,
  runCli,
  usage,
  withOwnedStdout,
  type CliFlags,
  type CliIo,
} from './cli.js';

export {
  IN_REPO_ADAPTERS,
  expressAdapterUnderTest,
  fastifyAdapterUnderTest,
} from './in-repo-adapters.js';

export { renderConformanceTable } from './table.js';
