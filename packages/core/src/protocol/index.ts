// SPDX-License-Identifier: Apache-2.0
/**
 * MCP protocol constants and negotiation (#61, §12.3).
 */

export {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
  type ProtocolNegotiation,
} from './versions.js';
