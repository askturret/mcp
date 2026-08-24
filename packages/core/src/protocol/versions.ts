// SPDX-License-Identifier: Apache-2.0
/**
 * MCP protocol versions — one source of truth (#61, §12.3).
 *
 * ## Why this module exists
 *
 * The version lived in two places and they disagreed. The transport returned
 * `2024-11-05` from `initialize` — matching `docs/compatibility.md`, which is a
 * published versioned contract — while the dispatcher stamped a hardcoded
 * `2025-06-18` onto `mcp.protocol.version` on **every span**.
 *
 * So the observability attribute named after the protocol version reported a
 * version the server had never spoken to anyone. That is worse than a missing
 * attribute: a missing one prompts a question, and a wrong one gets aggregated,
 * dashboarded and believed.
 *
 * One constant, imported by both, is the fix. The transport cannot report a
 * version the telemetry does not know about, because there is now only one to
 * know.
 *
 * ## Why the list is separate from the default
 *
 * `MCP_PROTOCOL_VERSION` is what we ANNOUNCE. `SUPPORTED_MCP_PROTOCOL_VERSIONS`
 * is what we ACCEPT. They are usually the same and are not the same kind of
 * thing: adding backwards compatibility for an older client widens the second
 * without touching the first, and that asymmetry is exactly what a negotiation
 * needs to express.
 */

/**
 * The protocol version this server announces in `initialize`.
 *
 * Matches `docs/compatibility.md`, which is a versioned contract — changing
 * this without changing that document makes one of them a lie.
 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * Every protocol version this server will accept from a client.
 *
 * A single entry today. Kept as a set rather than an equality check so that
 * accepting a second version later is a data change rather than a control-flow
 * change — the negotiation logic below does not have to be revisited.
 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = [MCP_PROTOCOL_VERSION];

export function isSupportedProtocolVersion(version: string): boolean {
  return SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(version);
}

/** What `negotiateProtocolVersion` decided. */
export type ProtocolNegotiation =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly requested: string; readonly reason: string };

/**
 * Decide which protocol version a session speaks.
 *
 * ## Absent means "accept", not "reject"
 *
 * A client that omits `protocolVersion` gets our announced version rather than
 * a refusal. Omission is common in practice and is not a statement of
 * incompatibility — refusing it would break clients that work perfectly well.
 *
 * ## An unsupported version is REFUSED, and refusal is a return value
 *
 * §61 is explicit that an unsupported version must not call `process.exit()`,
 * and the reason is worth stating: this runs inside an adopter's server
 * process. Exiting would take down every unrelated route in their application
 * because one MCP client asked for the wrong protocol version — a remote
 * client would be able to halt the host process by sending one field.
 *
 * So this returns a decision. The caller turns it into a JSON-RPC error, the
 * session does not start, and nothing else in the process notices.
 */
export function negotiateProtocolVersion(requested: unknown): ProtocolNegotiation {
  if (requested === undefined || requested === null) {
    return { ok: true, version: MCP_PROTOCOL_VERSION };
  }

  if (typeof requested !== 'string') {
    return {
      ok: false,
      requested: String(requested),
      reason:
        `protocolVersion must be a string, got ${typeof requested}. ` +
        `This server speaks ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(', ')}.`,
    };
  }

  if (!isSupportedProtocolVersion(requested)) {
    return {
      ok: false,
      requested,
      reason:
        `Unsupported MCP protocol version '${requested}'. ` +
        `This server speaks ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(', ')}. ` +
        `See docs/compatibility.md for the supported range.`,
    };
  }

  return { ok: true, version: requested };
}
