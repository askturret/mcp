<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-018 — Plugins receive scoped, typed setters — never a mutable runtime handle

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

Epics 1–3 built a set of runtime invariants: a sealed execution envelope
([ADR-010](ADR-010-sealed-execution-envelope.md)), an immutable registry
snapshot ([ADR-004](ADR-004-no-mutable-global-registry.md)), a redaction
pipeline whose built-ins win ties
([ADR-016](ADR-016-one-central-redaction-pipeline.md)), and an audit path that
cannot be skipped.

Every one of those holds **because the runtime owns the only handle** to the
thing being protected. A plugin API is a request to hand something out.

## Decision

> A plugin receives **SCOPED, TYPED SETTERS** — never a handle on anything
> mutable that the runtime owns.

`registerSource`, `registerExecutor` and friends on `PluginContext`, each
capability-gated in `host.ts`. A plugin declares what it needs and receives a
narrow function; it never receives the registry, the envelope, or the redaction
config.

The module header states the stakes plainly: *"That is the difference between an
ecosystem and a liability."*

## Consequences

- **The invariants survive third-party code**, because a plugin has no
  expressible way to violate them. Not "must not" — cannot.
- **Capability gating makes the surface auditable.** What a plugin can do is
  determined by what it was granted, not by what it can reach.
- **Legitimate extensions get refused.** Anything needing mid-pipeline control
  has nowhere to go and must argue for a change in core. That is a real cost,
  and it is the same trade [ADR-010](ADR-010-sealed-execution-envelope.md) makes.
- **Every new capability is a considered addition to the setter surface**, not
  an emergent consequence of exposing an object.
- **Readiness criterion 12 rests on this** — a new source or executor addable as
  a plugin without touching core control flow. Its evidence is currently unit
  tests plus an exporter example; a source/executor example is tracked as
  adoption work in #270.

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record:

- `packages/core/src/plugin/types.ts:3` — *"The stable plugin API (§6 'Plugin
  author API', ADR-018, #53)"*, plus the one-sentence design and the Epics 1–3
  reasoning quoted above
- `packages/core/src/plugin/host.ts:4` — capability gating (§6)
- `packages/core/src/plugin/index.ts:3`, `plugin/__tests__/plugin.test.ts:3` —
  the same subject
- `docs/plugin-api.md` — the adopter-facing statement of the same boundary

Consistent across all five citations, which makes this reconstruction one of the
more reliable here.
