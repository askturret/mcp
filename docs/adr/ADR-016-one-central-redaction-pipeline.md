<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-016 — Exactly one central redaction pipeline

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

Data leaves the process through several surfaces: logs, telemetry, audit
records, the Explorer, error payloads. Each is a place a secret can escape.

Redaction implemented per surface means several implementations of one policy,
diverging quietly. The surface added last is the one that forgets, and nothing
about that surface's code looks wrong.

## Decision

**One central redaction pipeline** (§9.4). Every observable exit passes through
it before data leaves the process.

The module header names the property precisely, and the emphasis is the point:

> the interesting property is not that redaction happens, but that there is
> exactly ONE place it happens.

The observable exits are a **closed union rather than a string**, which is
load-bearing: *"adding a seventh surface is a compile error everywhere the set
is enumerated"*. A new exit cannot be added quietly — the type system makes
adding one a conversation about redacting it.

## Consequences

- **Adding an exit surface is a compile error until handled.** The strongest
  form of "don't forget", because it does not rely on remembering.
- **One place to audit, and one place to get wrong.** A defect here affects
  every surface at once. That concentration is accepted deliberately: one
  well-reviewed implementation beats six inconsistent ones, and the blast radius
  is the price.
- **Belt-and-braces at the call sites anyway.** The Explorer applies redaction
  per panel *and* again at the top, so a panel added later cannot escape by
  forgetting — see [ADR-020](ADR-020-explorer-panels.md).
- **It is assertable.** Readiness criteria 7 and 8 both lean on a redaction
  snapshot test proving no secret appears.

A live example of why single-implementation matters: redaction was found eating
snapshot hashes on the Explorer surface (#266), which could silence a mismatch
warning. One pipeline means one fix — and, honestly, one place where a bug
reaches every surface at once.

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record —
only two exist:

- `packages/core/src/redaction/types.ts:3` — *"Central redaction pipeline (§9.4,
  ADR-016)"*, plus the "exactly ONE place" reasoning and the closed-union note
- `packages/core/src/redaction/index.ts:3` — the same subject

The consequences section draws on `packages/explorer` and the readiness matrix,
which do not cite ADR-016 by number; those connections are this document's
inference.
