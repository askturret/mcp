<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-019 — Overlays edit the model without editing the source, and carry provenance

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

An adopter needs to change how an operation appears to an agent — its
description, its effect classifications, its visibility — but the OpenAPI spec
or route table it was generated from is often owned by another team, or
regenerated on every build. Editing the source is either impossible or gets
overwritten.

## Decision

**Overlays** (§5.3): a layer that modifies the compiled model without touching
the source it came from. Applied as compiler pass 3.

And, inseparably, **provenance**. From `overlay/types.ts`:

> Once several things can define the same field, "why is this value here?" stops
> being answerable by reading any one file.

So every field records which layer set it. `ProvenanceEntry` carries the field,
the kind of source, and its location.

## Provenance is the point, not a feature of it

The module header says exactly that, and the ordering matters. Overlays are the
capability; provenance is what keeps the capability from being a debugging
disaster.

Without it, a description an agent sees might come from the spec, from an
overlay, or from a compiler enhancement, and the only way to find out is to
re-run the compiler in your head. That cost lands on whoever is debugging
production behaviour, not on whoever wrote the overlay — which is the shape of
problem that does not get fixed later, because the person paying is not the
person deciding.

Making provenance part of the same decision is what stops overlays shipping
without it.

## Consequences

- **Adopters change agent-facing behaviour without forking the spec**, and their
  changes survive regeneration.
- **"Why is this value here?" stays answerable** by reading the provenance chain.
- **Provenance is metadata, not contract.** It is deliberately excluded from the
  registry hash ([ADR-004](ADR-004-no-mutable-global-registry.md)) — two
  registries with the same contract and different provenance are the same
  contract. It is also excluded from the hash *because* including it would make
  overlay-only edits look like contract changes.
- **Layering must resolve deterministically.** Several things can now define one
  field, so precedence has to be defined rather than emergent.

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record:

- `packages/core/src/overlay/types.ts:3` — *"Overlays and provenance (§5.3,
  ADR-019, #55)"*, plus the "provenance is the point" reasoning quoted above
- `packages/core/src/overlay/index.ts:3`, `overlay/__tests__/overlay.test.ts:3`
- `packages/core/src/compiler/passes/apply-overlays.ts:3` — *"Pass 3: Apply
  overlays and code enhancements"*
- `docs/overlays.md:3` — the adopter-facing document, headed *"§5.3, ADR-019"*

All five citations agree on subject, and `docs/overlays.md` already exists as
the how-to; this ADR records the decision behind it rather than restating usage.
