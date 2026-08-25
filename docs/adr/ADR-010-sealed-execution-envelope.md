<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-010 — The 12-stage execution envelope is sealed

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

Every invocation passes through the same sequence: validation, policy checks,
confirmation, bulkhead admission, execution, redaction, audit, and the rest —
twelve stages in all.

A plugin API creates pressure to make that sequence extensible. Let an
integration insert a stage, or reorder two, or wrap the pipeline. Every one of
those is a way to end up with a deployment whose audit stage runs before its
redaction stage, or not at all.

## Decision

The envelope is **fixed and sealed at twelve stages**. Plugins may not add a
stage, remove one, reorder them, or bypass the envelope. `docs/plugin-api.md`
lists *"Bypass the execution envelope or reorder its stages"* among the things
the API does not permit.

Plugins extend the system at the seams the envelope already exposes — sources,
executors, exporters — never in the control flow between stages.

## A retry is not a thirteenth stage

The clearest statement of what "sealed" means in practice, from
`dispatcher/index.ts:916`:

> ADR-010 seals the envelope at twelve stages. A retry is not a new step in
> [the pipeline]

A retry re-enters the existing envelope rather than extending it. That keeps
"how many stages ran" answerable, and keeps a retried call subject to the same
policy and audit as the first attempt — rather than to a shortcut that skipped
back in partway.

## Consequences

- **The invariants hold by construction.** Redaction cannot be skipped, audit
  cannot be bypassed, and policy cannot be reordered after execution, because
  there is no mechanism through which a plugin could do any of it.
- **The stage list is a stable vocabulary.** `dispatcher/index.ts:241` uses it
  for log labelling — every stage has a name, so a log line can say where it was.
- **Some legitimate extensions have nowhere to go.** An adopter wanting genuinely
  new behaviour mid-pipeline must argue for a thirteenth stage in core rather
  than adding one locally. That is deliberate friction, and it is a real cost —
  it makes core a bottleneck for a class of change.

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record:

- `packages/core/src/dispatcher/types.ts:5` — *"ADR-010: Fixed execution
  envelope - the 12-stage pipeline is sealed"* (the definitional statement)
- `packages/core/src/dispatcher/index.ts:5` — *"ADR-010: 12-stage pipeline,
  sealed and immutable"*
- `packages/core/src/dispatcher/index.ts:916` — the retry clarification, quoted
- `packages/core/src/dispatcher/index.ts:241` — stages as log labels
- `docs/plugin-api.md:109` — bypass/reorder listed as forbidden (§5.6)
