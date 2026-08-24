# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
scoped by **[`docs/compatibility-policy.md`](docs/compatibility-policy.md)** —
that document defines which surfaces semver actually applies to, and is what
every entry below is classified against.

## How to write an entry

Group changes under the standard headings: **Added**, **Changed**,
**Deprecated**, **Removed**, **Fixed**, **Security**.

Two project-specific rules on top of Keep a Changelog:

**1. A `Changed` or `Removed` entry states which covered surface it touches.**
Not as ceremony — it is what makes the version bump checkable by a reader rather
than trusted. If a change touches no covered surface, say that too:

```markdown
### Changed
- `OperationResult.error` is now a discriminated union.
  **Breaking — core public types** (compatibility-policy §1), returned value,
  so an exhaustive `switch` must be updated.
- Reworded the `EXECUTOR_MISCONFIGURED` message to name the missing field.
  Not a covered surface — error wording is explicitly excluded; the `code` is
  unchanged.
```

**2. A `Deprecated` entry names its earliest possible removal.**

```markdown
### Deprecated
- `expressMcp({ enableExplorer })` in favour of `{ explorer: { enabled } }`.
  Emits a `deprecation`-tagged log record. Removable no earlier than `2.0.0`;
  supported for at least one further MINOR regardless.
```

A deprecation must appear here in the release that **introduces** it, never for
the first time in the release that removes it.

**3. A breaking entry links its migration.** Every `Removed` entry, and every
`Changed` entry that breaks a covered surface, links the corresponding snippet
in [`docs/migrations/`](docs/migrations/README.md) — which is generated from the
rules `npx @askturret/mcp migrate` actually executes, so the link cannot point
at a guide describing a change the tool does not make.

```markdown
### Removed
- `audit.durability` on `PresetConfiguration`, replaced by `audit.sink.durable`.
  **Breaking — core public types** (compatibility-policy §1).
  Migration: [0.x → 1.0](docs/migrations/README.md#0x--10) —
  `npx @askturret/mcp migrate --from 0.x --to 1.0`
```

---

## [Unreleased]

Nothing released yet. The project is at `0.1.0` and **pre-1.0, so no
compatibility guarantee is in force** — see the policy document for what changes
when `1.0.0` ships.

### Added
- `docs/compatibility-policy.md` — the semver, compatibility and deprecation
  policy for the 1.0 contract, and this changelog format. Not a covered-surface
  change: it publishes the rules that will govern them.
- `docs/ownership.md` and `.github/CODEOWNERS` — repository ownership boundaries.
- `.gitattributes` — `merge=union` for append-only audit logs.
- `npx @askturret/mcp migrate` and `docs/migrations/` — version-to-version
  migration tooling. No published migration exists yet, because no release has
  broken a published surface; the tooling ships first so the first breaking
  change arrives with its migration rather than after it.

### Changed
- A policy denial carrying `UNAUTHENTICATED` now reaches the caller as
  `UNAUTHENTICATED` rather than being collapsed into `FORBIDDEN`. Every other
  denial — unrecognised policy codes and the engine's own internal ones
  included — still normalises to `FORBIDDEN`.
  **Covered surface — error `code` values** (compatibility-policy §6). §6 makes
  "changing which condition produces it" MAJOR, and this changes which condition
  produces `FORBIDDEN`. It would therefore be a MAJOR change once `1.0.0` ships,
  and lands now precisely because no guarantee is in force yet.
  A client switching on `FORBIDDEN` to mean "any denial" needs an
  `UNAUTHENTICATED` arm. The two call for different behaviour — obtain
  credentials and retry, versus do not retry with this identity — which is the
  distinction callers previously could not make.

[Unreleased]: https://github.com/askturret/mcp/compare/main...HEAD
