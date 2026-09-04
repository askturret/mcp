// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway version, for `--version` and the MCP Registry entry.
 *
 * A literal rather than a read of `package.json`: the built `dist/` is what
 * `npx` runs, and resolving the manifest from there needs a path that differs
 * between the source tree and the published tarball. A constant the release
 * bump touches alongside `package.json` cannot resolve to the wrong file.
 */
export const GATEWAY_VERSION = '0.1.2';
