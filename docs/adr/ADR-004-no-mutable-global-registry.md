<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-004 — No mutable global registry; snapshots are immutable and atomically swapped

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

The registry has to change at runtime: specs are re-read, overlays are edited,
operations appear and disappear. The obvious implementation is a mutable
collection that reload updates in place.

That breaks two things at once. `tools/list` and `tools/call` can disagree — a
call can arrive for an operation that listing showed a moment ago and that
mutation has since removed. And an audit record cannot name *what the registry
was* when a call ran, because there is no such thing to name.

## Decision

No mutable global registry. Instead:

- The registry is an **immutable snapshot**, deep-frozen once constructed.
- A single `AtomicRegistryReference` holds the current snapshot.
- Reload builds a new snapshot and `swap()`s the reference.
- **The dispatcher captures the snapshot at entry**, so an in-flight call keeps
  the exact snapshot it started with even if a reload lands mid-execution.
- Each snapshot carries a deterministic content-addressed hash.

Atomicity comes free from JavaScript's single-threaded execution: the reference
swap cannot be observed half-done.

## The hash contract

Deliberately narrower than "hash the snapshot":

| | Fields |
|---|---|
| **Included** | `id`, `name`, `description`, `input`, `output`, `effects`, `executor`, `annotations` |
| **Excluded** | `provenance` (metadata, not contract), `createdAt` (timing, not content) |
| **Format** | SHA-256 truncated to 16 hex chars |

Determinism is a requirement, not an accident: keys sorted alphabetically,
operations sorted by id, no `Date.now()` or `Math.random()`, stable across Node
versions and processes. Two processes compiling the same input must agree, or
the hash cannot serve as audit evidence.

Excluding `provenance` is the subtle half. Provenance records *where a field
came from*; two registries with identical contracts and different provenance are
the same contract, and hashing provenance would make them look different.

## Consequences

- **Reload is coherent by construction.** Listing and invocation cannot diverge,
  because both read one snapshot reference and in-flight work holds its own.
- **Audit gets a nameable registry state** — `registryHash` on the command.
- **Memory holds more than one snapshot** while calls from the previous
  generation drain. That is the cost, and it is bounded by in-flight duration.
- **Nothing may mutate a snapshot.** The freeze pass enforces it; a `Map`
  handed out is proxied so `set`/`delete` throw rather than silently succeeding.

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record:

- `packages/core/src/registry-reference.ts:5` — *"ADR-004: No mutable global
  registry"* plus the atomicity guarantee (the definitional statement)
- `packages/core/src/compiler/passes/freeze-and-hash.ts:78` — the hash contract,
  quoted above
- `packages/core/src/reload/types.ts:3`, `reload/index.ts:3` — atomic reload with
  in-flight snapshot retention (§7.4)
- `packages/core/src/__tests__/registry-reference.test.ts:72` — *"This test
  proves ADR-004: in-flight calls retain their snapshot"*

Readiness criterion 2 (deterministic snapshot, stable hash across processes) is
this decision's live evidence.
