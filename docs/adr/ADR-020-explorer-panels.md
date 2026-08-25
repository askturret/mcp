<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-020 — The Explorer is six fixed panels, and no panel bypasses redaction

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).
**⚠ This number is also cited by the gateway.** See [A second citation](#a-second-citation).

## Context

Operators need to see what the runtime is doing: which operations exist, what a
policy decided, what the registry hash is. That surface renders real operation
definitions, real policy decisions and real snapshot state — which is to say,
it is one more place data leaves the process.

## Decision

Six fixed panels (§13), forming the primary operator diagnostic surface. And one
rule governing the whole module:

> **No panel bypasses the redaction pipeline.**

Enforced twice, deliberately: each builder returns its model through
`redactExplorerModel`, and `buildExplorerPanels` applies it **again** at the top.

## Why redact twice

Belt and braces, with each layer doing a different job — the module header is
explicit that this is deliberate rather than accidental duplication:

- The **per-panel** call is where the intent lives. A reader of one builder can
  see that its output is redacted without holding the whole module in their head.
- The **top-level** call is the backstop, so a panel added later cannot escape
  simply by forgetting.

The second is the one that survives contact with future contributors. The first
is the one that makes the code readable now. Dropping either looks like a
harmless simplification and is not.

This is [ADR-016](ADR-016-one-central-redaction-pipeline.md) applied at a
surface, not a second redaction policy — the Explorer calls the one pipeline.

## Consequences

- **A new panel is redacted whether or not its author remembered.**
- **Redaction defects surface here.** #266 found redaction eating snapshot
  hashes on this surface, which could silence panel 6's mismatch warning — a
  case where redacting too much was the bug. Worth stating: the double
  application makes over-redaction *more* likely to bite here, and that is the
  accepted side of the trade.
- **The panel set is fixed.** A seventh is a change to core, matching the sealed
  posture of [ADR-010](ADR-010-sealed-execution-envelope.md) and
  [ADR-018](ADR-018-plugins-get-scoped-typed-setters.md).

## A second citation

`packages/gateway/README.md:4` cites **§11.3, ADR-020, #57** for the standalone
compatibility gateway — a different section and a different issue from the
Explorer's **§13, ADR-020, #56**.

Reconstruction cannot say whether the number was reused by mistake or once
covered a broader "operator-facing surfaces" decision. This document covers the
**Explorer**, which holds four of the five citations and the only definitional
statement of a rule. The gateway reference is recorded here rather than
resolved by invention, per #223.

Same shape as the [ADR-014 ambiguity](ADR-014-executors-are-interchangeable.md#the-adr-014-ambiguity),
and the same recommendation: if the original allocation resurfaces, split rather
than renumber the citations.

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record:

- `packages/explorer/src/panels.ts:3` — *"The six Explorer panels (§13, ADR-020,
  #56)"*, plus the no-bypass rule and the belt-and-braces reasoning quoted above
- `packages/explorer/src/types.ts:90`, `panels.test.ts:3` — the same subject
- `docs/explorer-panels.md:3` — *"§13, ADR-020. The primary operator diagnostic
  surface"*
- `packages/gateway/README.md:4` — the conflicting citation above
