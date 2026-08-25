<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-012 — Retry is gated on semantic idempotency, and the decision is pure

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

Retrying a transient failure is standard practice and usually right. Retrying a
non-idempotent write is how one payment becomes two.

Transport-level signals are not enough to tell the cases apart. A timeout does
not say whether the request arrived. An `OUTCOME_UNKNOWN` says explicitly that
it might have.

## Decision

Retry eligibility is decided from **the operation's declared effect metadata**
(§5.8) rather than from the error alone, and the decision is **separated from
the loop that acts on it**.

Every function in `retry/policy.ts` is pure:

> The decision is separable from the loop that acts on it, which is what lets
> the matrix be tested exhaustively without standing up a dispatcher — and what
> lets the loop be read as "ask, then act" rather than as a pile of inline
> conditions.

The rules that fall out, per readiness criterion 6:

- `OUTCOME_UNKNOWN` **never** retries, under any effects combination.
- A **non-idempotent mutating** operation never retries, under any error code.
- A retry is returned only for a transient code the effects matrix permits.

## Purity is the testability decision

Worth separating from the policy itself, because it is what makes the policy
checkable. `idempotent-retryable-fuzz.test.ts` drives the real `decideRetry` and
`isRetryEligible` across **all 14 error codes × all 16 effect combinations —
224 cases**. That is exhaustive rather than sampled, and it is only affordable
because no dispatcher has to be constructed to ask the question.

A retry decision tangled into the execution loop would be testable only through
the loop, and 224 cases would not have been written.

## Consequences

- **The dangerous direction is closed by construction**, not by remembering to
  check. The fuzz test asserts it across the whole matrix.
- **Retry depends on effect metadata being right**, which pushes weight onto
  [ADR-006](ADR-006-safety-first-effect-defaults.md)'s conservative defaults.
  The two decisions are load-bearing together: a permissive default there would
  undo the guarantee here.
- **A retry re-enters the sealed envelope** rather than adding a stage —
  see [ADR-010](ADR-010-sealed-execution-envelope.md).

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record:

- `packages/core/src/retry/types.ts:3` — retry configuration types (§8.4)
- `packages/core/src/retry/policy.ts:3` — decision rules (§8.4, §5.8) plus the
  purity rationale quoted above
- `packages/core/src/retry/index.ts:3` — *"Retry rules with semantic
  idempotency"* (the closest thing to a definitional statement)
- `packages/core/src/dispatcher/index.ts:203` — retry policy wiring (#45)

No citation states the decision in "ADR-012: …" form, so the framing here is
assembled from the module headers and the behaviour the tests pin.
