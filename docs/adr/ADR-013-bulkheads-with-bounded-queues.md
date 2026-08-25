<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-013 — Bulkheads with bounded queues, never an unbounded one

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

One slow dependency can consume every worker. Calls to the healthy remainder of
the system then queue behind calls to the sick part, and a single degraded
upstream becomes a total outage.

The standard mitigation is a bulkhead: cap concurrency per dependency. The
question this decision actually turns on is what happens to the calls that
arrive once the cap is reached.

## Decision

A bulkhead bounds **both** the in-flight calls and the calls willing to wait.
Both limits, not just the first. From `bulkhead/types.ts`:

> A bulkhead bounds BOTH the in-flight calls and the calls willing to wait, so
> overload is rejected in constant time instead of accumulating in memory — an
> unbounded queue does not prevent an outage, it postpones it and makes the
> eventual failure a heap exhaustion rather than a fast error.

Implemented as a bounded-queue semaphore, one per bulkhead. Rejection surfaces
as `QUEUE_FULL`.

## Why the queue bound is the real decision

Capping concurrency alone feels like the whole mitigation, and it is not. With
an unbounded queue the process still accepts every arriving call — it just
stops finishing them. Load lands in memory instead of in the worker pool.

The failure mode that produces is strictly worse than rejection: heap
exhaustion, at an unpredictable moment, taking down work unrelated to the sick
dependency, with no clean signal to the caller. A fast `QUEUE_FULL` is a worse
outcome for one caller and a much better one for the system.

## Consequences

- **Overload is rejected in constant time**, with a typed code a caller can act
  on rather than a timeout they must infer from.
- **Callers must handle `QUEUE_FULL`.** Load shedding is visible in the API
  surface, which is the honest place for it.
- **The caps need tuning per deployment.** Set too low they shed load that
  could have been served; there is no universally right value, and the presets
  carry deployment-shaped defaults ([ADR-007](ADR-007-presets-are-compositions-not-modes.md)).
- **Bounded memory becomes assertable.** Readiness criterion 10 covers sustained
  load with bounded memory and graceful overload, which this makes possible to
  state.

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record:

- `packages/core/src/bulkhead/types.ts:3` — configuration and permits (§8.2),
  plus the rationale quoted above
- `packages/core/src/bulkhead/semaphore.ts:3` — *"A bounded-queue semaphore —
  one bulkhead"*
- `packages/core/src/bulkhead/index.ts:3` — bulkheads with bounded queues (#43)
- `packages/core/src/dispatcher/index.ts:187` — bulkhead configuration wiring

No citation uses the "ADR-013: …" definitional form; the decision is assembled
from the module headers, which are unusually explicit about the reasoning.
