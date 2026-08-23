// SPDX-License-Identifier: Apache-2.0
/**
 * Adapter conformance contract (§12.2, §12.4).
 *
 * Importing this module registers every in-repo adapter, so a consumer gets a
 * populated registry rather than an empty one that silently tests nothing.
 */

import './adapters.js';

export {
  registerAdapter,
  registeredAdapters,
  getAdapter,
  clearAdapters,
  selectedAdapters,
  type AdapterFactory,
  type ConformanceServer,
} from './registry.js';

export {
  CATEGORIES,
  runBank,
  renderTable,
  rpc,
  callTool,
  type Category,
  type CategoryContext,
  type CategoryResult,
} from './bank.js';

export { MOUNT_PATH } from './adapters.js';
