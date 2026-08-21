// SPDX-License-Identifier: Apache-2.0
/**
 * AskTurret MCP - Explorer UI
 *
 * Local, dev-only web interface for browsing the effective tool surface and
 * safely trying calls. It reads the same RegistrySnapshot the transport serves
 * and invokes tools through the same `/mcp` endpoint — no side channel.
 *
 * Adapters render it with:
 *
 *   renderExplorerHtml(buildExplorerViewModel(registry.current(), basePath))
 *
 * Disabled by default when NODE_ENV=production (§10.1 invariant 9); enabling it
 * there is an explicit operator opt-in and is expected to log a startup warning.
 */

export * from './types.js';
export { buildExplorerViewModel } from './view-model.js';
export { renderExplorerHtml } from './html.js';
