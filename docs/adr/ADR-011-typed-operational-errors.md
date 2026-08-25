<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-011 — Typed operational errors; no raw exception crosses a transport boundary

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

An operation fails for many reasons: bad input, an unauthenticated caller, a
deadline, an upstream outage. The path of least resistance is to let the
underlying exception propagate and serialise whatever it happens to be.

Two problems. An `Error` carries `name`, `message` and `stack` — internal type
names and file paths, handed to an agent that should not see them. And a caller
cannot branch on a failure whose shape is "whatever threw".

## Decision

Failures cross boundaries as a **typed `OperationError`**, never as a raw
exception:

```ts
{ code: OperationErrorCode, message: string, details?: Record<string, unknown> }
```

`code` is a closed union of fourteen values, so a caller can branch
exhaustively. `message` is redacted and safe for transport. Executors *"must map
exceptions to `OperationError` at the boundary"* and *"must never leak internal
exception stacks or type names"* — both stated in the executor contract.

The same shape reaches into policy: `policy/authorization.ts:86` returns a
**result object rather than a sentinel string**, *"per ADR-011"*. The decision is
about typed outcomes generally, not only about the error envelope.

## Consequences

- **A raw `Error` is not assignable to `OperationError`**, and the compiler says
  so. `packages/core/src/__tests__/types.test.ts` carries an `@ts-expect-error`
  pinning it, alongside a runtime test asserting a serialised `OperationError`
  has no `stack` or `name`. Both halves of one claim.
- **The code list is exhaustive and enumerable**, which is what lets the retry
  matrix be tested across all fourteen codes rather than sampled.
- **Adding a code is a deliberate act.** A new code asserts a caller remedy;
  `types.ts` records declining to add codes for 409 and 405 precisely because
  *"inventing a code for each would assert a caller remedy we do not know"* —
  they carry `INTERNAL_ERROR` with `details.upstreamStatus` instead.
- **Detail is pushed into `details`.** Coarse codes plus structured details, not
  a code per upstream status.

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record:

- `packages/core/src/types.ts:10` — *"ADR-011: Typed operational errors - no raw
  exceptions cross transport boundary"* (the definitional statement)
- `packages/core/src/policy/authorization.ts:86` — *"A result object rather than
  a sentinel string, per ADR-011"*
- `packages/core/src/executor/types.ts` — the executor contract clauses quoted
- `packages/core/src/types.ts:447` onward — the 404/410 and 409/405 reasoning

Only two citations name this number directly; the executor-contract clauses are
attributed here by subject rather than by an explicit ADR-011 reference.
