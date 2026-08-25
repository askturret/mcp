<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-014 — Executor strategies are interchangeable (golden-output contract)

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).
**⚠ This number is cited for two different subjects.** See [The ADR-014 ambiguity](#the-adr-014-ambiguity).

## Context

The same operation can execute in more than one way: `viaHandler` calls an
in-process function, `viaHttp` makes a network call. An adopter may move an
operation between them — starting in-process and later extracting a service.

If the two differ in what they return, that move becomes a breaking change to
every agent using the operation, discovered in production.

## Decision

Executor strategies **must be interchangeable**. `viaHandler` and `viaHttp`
produce *identical golden output* for the same operation definition.

The executor contract states what that requires of each:

- respect `AbortSignal` cancellation, propagating it downstream
- **enforce the deadline independently of the client timeout**
- map exceptions to `OperationError` at the boundary
  ([ADR-011](ADR-011-typed-operational-errors.md))
- never leak internal exception stacks or type names
- switching executors must produce identical output

## The deadline clause is the sharp one

`via-handler.ts:47` records it explicitly:

> ADR-014: executors must enforce deadlines, not rely on handler checking signal

An in-process handler *could* be trusted to check the signal itself, and doing
so would be less code. It is not permitted, because then `viaHandler` would
honour a deadline only for well-behaved handlers while `viaHttp` honoured it
always — and the two would diverge exactly when a handler misbehaves, which is
when the deadline matters.

Interchangeability has to hold under failure, not just on the happy path.

## Consequences

- **An operation can be relocated between executors without agent-visible
  change.** That is the property the decision buys.
- **Every executor re-implements deadline and cancellation enforcement**, rather
  than delegating to the thing it calls. Duplicated effort, deliberately.
- **It is testable as a parity property**, and is tested that way — readiness
  criterion 5 covers per-executor cancellation, and
  `architecture-overview.md:171` states the requirement as *identical* output.

## The ADR-014 ambiguity

**Two unrelated subjects cite this number, and reconstruction cannot say which
one it originally designated.**

| Subject | Citation |
|---|---|
| Executor interchangeability | `executor/types.ts:5` — *"ADR-014: Executor strategies must be interchangeable"* |
| Audit mandatory-delivery | `audit/types.ts:3`, `audit/index.ts:3` — *"Audit sink with mandatory-delivery semantics (§9.3, §8.6, ADR-014)"* |

This document covers the **executor** subject, on the narrow ground that it is
the one written in the definitional `ADR-014: …` form; the audit citations
reference the number in passing alongside section numbers.

That is a tie-break, not evidence. Either the number was reused by mistake, or
one decision once covered both under a heading now lost. Per #223, this is
recorded rather than resolved by invention.

**The audit decision is real and is documented** — it simply has no ADR number
that can be confidently assigned. Its own module header states it well:

> Telemetry is allowed to drop. […] An audit record is a claim about what
> happened to somebody's data, and a gap in it is indistinguishable from the
> event never occurring.

If the original allocation resurfaces, split this into two ADRs and give the
audit decision the next free number rather than renumbering the citations.

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record:

- `packages/core/src/executor/types.ts:5` — the definitional statement
- `packages/core/src/executor/via-handler.ts:47` — the deadline clause, quoted
- `docs/architecture-overview.md:171` — *"ADR-014 requires that `viaHandler` and
  `viaHttp` produce identical…"*
- `CHANGELOG.md:522` — one `ExecutorBinding` bound per operation at compile time
- `packages/core/src/audit/types.ts:3`, `audit/index.ts:3` — the conflicting
  audit citations
