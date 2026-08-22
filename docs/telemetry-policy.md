# Telemetry Policy

**AskTurret MCP collects nothing. There is no telemetry, no analytics, no
usage reporting, and no phone-home — not on install, not on first run, not
in production.**

This page states the policy that governs telemetry **if we ever ship it**. It is
a **versioned contract**, not a roadmap: the constraints below bind any future
implementation, and loosening them is a breaking change.

> **Nothing on this page is implemented.** The configuration shown is a
> *specification* for a feature that does not exist. `telemetry` is not a real
> config key today — setting it does nothing. We are publishing the rules
> **before** building anything, so the rules cannot be quietly shaped to fit an
> implementation someone already wrote.

---

## 1. Zero telemetry by default

The package makes **no outbound network calls** unless you configure one
yourself — an executor calling your API, an adapter you mounted, or an
observability exporter you pointed at your own collector.

Every byte that leaves your process goes somewhere **you** chose. There is no
AskTurret endpoint, because there is no AskTurret ingest.

This is enforced mechanically, not just promised: a CI guard fails the build if
any file under `packages/*/src` imports a network-capable module
(`http`, `https`, `undici`, `node-fetch`, …) outside a small allowlist of files
whose entire job is to make network calls on your behalf. See
[Enforcement](#enforcement).

## 2. What is never collected — even if you opt in

The following are **never** transmitted, under any configuration, opt-in or
otherwise. There is no flag that enables them. A build that collects any of them
is a bug, and a security bug at that — please
[report it](../SECURITY.md).

- **Tool arguments and tool responses.** This is your business data. It is the
  single most sensitive thing passing through this library and it never leaves.
- **Principal identifiers.** User IDs, tokens, session identifiers, email
  addresses, tenant names, or anything else that identifies *who* made a call.
- **API schemas you have not explicitly marked shareable.** Your operation names,
  paths, parameter names and schema shapes describe your product. They are not
  ours to gather.
- **Response bodies, and error messages that may embed user data.** Stack traces
  and error strings routinely carry record IDs, query fragments and payload
  excerpts. Treated as user data throughout.

The list is deliberately phrased as **categories, not fields**. A field-level
list invites the reading that anything unlisted is fair game; the categories say
what the boundary *is*.

## 3. What opt-in telemetry MAY collect

If telemetry ever ships, it may collect **only** the following — and only after
you have explicitly opted in:

| Item | Example | Why it is safe |
|---|---|---|
| Package version | `0.1.0` | Ours, not yours |
| Node version | `20.11.0` | Environment, not data |
| OS family | `linux` | Family only — never hostname, arch detail, or username |
| Operation count | `42` | An **integer**. Never names, paths or schemas. |
| Preset name | `production` | One of three fixed strings |
| Installation ID | random UUID | Per-installation, **not** per-user; resettable and purgeable on request |

That is the complete list. It is a **maximum**, not a starting point: adding a
field to it requires a major version bump and a release-notes entry, because it
widens what adopters agreed to.

**The installation ID is not an identity.** It is generated locally, tied to an
installation rather than a person, resettable at will, and purgeable on request.
It exists to stop one busy CI pipeline from looking like ten thousand adopters —
not to follow anyone.

## 4. Opt-in mechanism

Opt-in must be an **explicit, affirmative act by the adopter, recorded in
configuration they control**:

```ts
// SPECIFICATION ONLY — this key does not exist today.
createMcpServer({
  preset: 'production',
  sources: [...],
  telemetry: { optIn: true },   // absent or false => nothing is collected
});
```

Three rules bind the mechanism, and each exists because it is a known way for
"opt-in" to quietly become opt-out:

- **It must be a config field.** Written by the adopter, reviewable in their
  repository, visible in code review, and diffable over time.
- **Never an environment-variable default.** An env var that defaults to enabled
  is opt-out wearing an opt-in label. If an env var is ever supported it may only
  *disable*, never enable.
- **Never a first-run prompt that pre-selects yes.** A pre-ticked box is not
  consent, and a prompt in CI is answered by whoever holds the terminal — which
  is nobody.

**Absence means no.** An unset `telemetry` key, a malformed value, or a config
the library could not parse all mean *do not collect*. Failing closed is the only
safe default: "I could not determine consent" must never resolve to "consent
given".

## 5. Inspectability

You can see exactly what would be sent, before it is sent:

```ts
// SPECIFICATION ONLY — this key does not exist today.
telemetry: { optIn: true, debug: true }
```

With `debug: true`, the **complete payload is written to stdout immediately
before transmission** — the real payload, not a summary and not a sample.

This matters more than the promises above it. Sections 2 and 3 are claims; this
is the mechanism that lets you *check* the claims yourself, on your own
infrastructure, without trusting us. A policy nobody can verify is a marketing
statement.

`debug: true` is also valid **without** `optIn` — you can inspect what *would* be
sent while sending nothing at all.

## Enforcement

Policy that depends on everyone remembering it will eventually be broken by
someone who never read it. So the first clause is enforced by CI:

**`.github/scripts/check-network-imports.mjs`** fails the build when a file under
`packages/*/src` imports a network-capable module outside the allowlist. The
allowlist covers exactly the files whose purpose is to make calls you asked for —
HTTP executors, transports, and framework adapters.

The point is not that the guard is impossible to get around. It is that **adding
a network call outside those files becomes a visible, deliberate diff** — a
code-review conversation rather than an accident. Silent telemetry stops being
something that can arrive by inattention.

The guard is itself covered by tests (`check-guards.test.mjs`), because a guard
that silently stops working is the failure it was written to prevent, one level
up.

## Stability of this contract

This page is a **versioned contract**:

- **Any change requires a semver bump and a release-notes entry.**
- **Widening what may be collected — adding a field to §3, relaxing a rule in
  §4, or narrowing §2 — is a breaking change** requiring a **major** version bump.
- Tightening the policy (collecting less, forbidding more) may ship in a minor
  release.
- Shipping telemetry at all, even fully opt-in, requires a **minor** version bump
  at minimum and a prominent release-notes entry. It will never arrive in a patch.

## Related

- [`SECURITY.md`](../SECURITY.md) — reporting a vulnerability, including any collection that violates this policy
- [`.github/scripts/check-network-imports.mjs`](../.github/scripts/check-network-imports.mjs) — the guard that enforces §1
