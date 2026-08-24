# Compatibility Matrix

What AskTurret MCP supports, and — just as importantly — what it does not.

**Applies to release `0.1.0`. Matrix version `1.0.0`.**

This page is a **versioned contract**. See [Stability of this contract](#stability-of-this-contract).

> **Machine-readable version:** [`compatibility.json`](compatibility.json) carries the
> same data for tooling to consume. **That file is the source of truth** — if this
> table and the JSON ever disagree, the JSON governs.

---

## Status vocabulary

The distinction between "we test this" and "we merely allow this" is the whole
point of the matrix, so it is stated explicitly rather than implied by a tick.

| Status | Meaning |
|---|---|
| ✅ **Supported** | Declared as supported **and** exercised by CI on every pull request. |
| ⚠️ **Declared, untested** | Declared in `peerDependencies` and expected to work, but **no CI job exercises it**. Use at your own risk; report breakage as a bug. |
| 🔜 **Planned** | **Not implemented.** Tracked by the linked issue. Do not depend on it. |
| 🚫 **Unsupported** | Explicitly rejected, and not planned. |

---

## Node.js

Declared: `engines.node` = **`>=20.0.0`**

| Version | Track | Status | Notes |
|---|---|---|---|
| 20.x | LTS | ✅ Supported | The version CI runs on. |
| 22.x | LTS | ⚠️ Declared, untested | Satisfies `engines.node`, but no CI job runs on it. |
| 24.x | Current | ⚠️ Declared, untested | Satisfies `engines.node`, but no CI job runs on it. |
| 18.x | Maintenance | 🚫 Unsupported | Below `engines.node`. Installation warns; behaviour is untested. |

> **Only Node 20 is actually exercised.** Every CI job pins `node-version: '20'`;
> there is no version matrix. 22.x and 24.x are permitted by `engines` and expected
> to work, but that expectation is not currently backed by a test run. Closing this
> gap is [Epic #5](https://github.com/askturret/mcp/issues/5)'s continuous-test matrix.

## TypeScript

| Version | Status | Notes |
|---|---|---|
| ≥ 5.5 | ✅ Supported | Build targets ES2022; `moduleResolution: NodeNext`. |
| 5.0 – 5.4 | 🚫 Unsupported | Not tested; shipped type definitions assume 5.5+. |

## Framework adapters

| Framework | Versions | Status | Entry point |
|---|---|---|---|
| **Express** | 4.18.x – 4.x | ✅ Supported | `@askturret/mcp/express` |
| **Express** | 5.x | ⚠️ Declared, untested | `@askturret/mcp/express` |
| **Fastify** | 4.x, 5.x | 🔜 Planned — [#41](https://github.com/askturret/mcp/issues/41) | — |

> **Express 5 is allowed but not verified.** The `peerDependencies` range accepts
> `^4.18.0 || ^5.0.0`, but CI installs Express 4 and `@types/express` is pinned to
> v4 types. Treat Express 5 as best-effort until a CI job covers it.

> **Fastify does not work today.** There is an optional `fastify` peer-dependency
> range in `package.json`, but **no adapter package, no `fromFastify` export, and no
> implementation.** The presence of the peer range is not a support claim. Track
> [#41](https://github.com/askturret/mcp/issues/41).

## Sources

### OpenAPI

| Version | Status | Notes |
|---|---|---|
| 3.0.x | ✅ Supported | |
| 3.1.x | ✅ Supported | |
| 2.0 (Swagger) | 🚫 Unsupported | Convert to OpenAPI 3.x first. |

> **Write a full three-part version.** Detection matches the dotted prefixes
> `3.0.` and `3.1.` against the document's `openapi` field, so `"3.0.0"` and
> `"3.1.0"` are accepted while a bare `"3.0"` or `"3.1"` is **rejected**. This is a
> known sharp edge, not an intentional restriction.

## MCP protocol and SDK

| Item | Value | Status |
|---|---|---|
| MCP protocol version | `2024-11-05` | ✅ Supported |
| `@modelcontextprotocol/sdk` | `^0.5.0` (tested against `0.5.0`) | ✅ Supported |

> **The protocol version is reported, not negotiated.** `2024-11-05` is returned in
> the `initialize` result regardless of what version the client asks for. A client
> requesting a different protocol version will not be rejected, and will not be
> served a different one.

> **SDK isolation.** The MCP SDK is imported by `packages/transports` alone and does
> not appear in any public API surface, so an SDK upgrade is contained to one
> package. This boundary is enforced separately by
> [#61](https://github.com/askturret/mcp/issues/61).

## Deprecations

**None.** No version is currently deprecated, and no removals are scheduled.

When a version is deprecated it will be listed here with its removal release
before that removal ships — a deprecation never appears for the first time in the
release that removes it.

---

## Stability of this contract

This matrix is a **versioned contract**, not a snapshot of what happens to work:

- **Any change requires a semver bump and a release-notes entry.**
- **Removing a listed version, or narrowing a supported range, is a breaking
  change** and requires a **major** version bump.
- **Adding newly supported versions** ships in a **minor** release.
- Promoting a cell from ⚠️ *Declared, untested* to ✅ *Supported* is a minor
  release. Demoting in the other direction is **breaking** — it withdraws a
  claim adopters may have relied on.

The matrix is updated **on every release**.

### What this matrix is not

It is a **published statement of intent**, not a CI-enforced guarantee. Only the
✅ cells are backed by a test run today, and even those run on a single Node
version. Building CI that exercises every cell is a separate
[§17 readiness criterion](https://github.com/askturret/mcp/issues/5).

That gap is stated deliberately: a matrix that implies coverage it does not have is
worse than no matrix, because it converts an unknown into a false assurance.

## Related

- [`compatibility.json`](compatibility.json) — the same matrix, machine-readable and authoritative
- [Compatibility and deprecation policy](compatibility-policy.md) — this page says *which versions* are supported; that one says *which parts of the API* are promised to be stable, and what happens when one must change
- [Generated-output licensing](generated-output-license.md) — who owns what AskTurret produces, also a versioned contract
- [Roadmap](roadmap.md) — what is planned for future releases
