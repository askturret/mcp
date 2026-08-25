<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-002 — The canonical `OperationDefinition` is source-agnostic

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

Operations arrive from several places: an OpenAPI document, an Express or
Fastify route table, an explicit definition written by hand, or a plugin-supplied
source. Each of those carries its own vocabulary — an OpenAPI path template, a
route handler reference, a spec-level `operationId`.

The tempting shape is one model per source, or one model with a slot for
whatever the source happened to know. Both make the model's meaning depend on
where an operation came from.

## Decision

One canonical `OperationDefinition`, with **no source-specific fields**. Every
source compiles into it; every compiler pass transforms it; every executor
consumes it.

Source-native data that still matters goes in one of two sanctioned places:

- `annotations` — an open `Record<string, unknown>` for metadata that does not
  fit a canonical field
- `provenance` — the chain recording which source set which field

The type's own invariant list states it: *"No source-specific fields — use
annotations or provenance instead."*

## Consequences

**The behaviour contract stops depending on discovery.** This is the payoff, and
it is load-bearing in a way that is easy to under-rate until it bites. From
`types.ts`:

> the same endpoint would return `NOT_FOUND` when compiled from OpenAPI and
> `INTERNAL_ERROR` when registered as an explicit definition. The error contract
> would depend on where the operation was DISCOVERED, which is exactly what
> ADR-002's source-agnostic model exists to prevent.

**It constrains fixes that would otherwise be easy.** The same comment records a
case where richer error mapping was wanted at execution time and was *not*
taken, because reaching it meant threading spec-derived data through
`executor.config`. The decision cost a feature there rather than being free.

**`annotations` and `executor.config` are deliberately open records.** They are
the escape hatch, and they are documented as opaque to the canonical model. The
closed shape is the TOP-LEVEL definition only — a distinction worth keeping in
mind, since it is easy to over-read this ADR as "nothing anywhere is open".

**It is enforced by the compiler, not by review.** `packages/core/src/__tests__/types.test.ts`
carries an `@ts-expect-error` asserting a source-native field cannot be added to
`OperationDefinition`; readiness criterion 1 cites it. Before #298 that check sat
inside a block comment and enforced nothing.

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record:

- `packages/core/src/types.ts:9` — *"ADR-002: Canonical OperationDefinition -
  source-agnostic model"* (the definitional statement)
- `packages/core/src/types.ts:447` — the `NOT_FOUND` / `INTERNAL_ERROR`
  reasoning quoted above
- `packages/core/src/executor/__tests__/via-http.test.ts:415` — a test pinning
  that the two paths agree

The decision is inferred from code and comments that cite it. Where this
document states a motive not written in those sources, it is an inference and
should be read as one.
