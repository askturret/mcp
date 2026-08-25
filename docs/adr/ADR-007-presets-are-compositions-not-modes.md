<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-007 — A preset is a configuration composition, not a mode

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

Shipping named safety levels — Light, Production, Regulated — has an obvious
implementation: a mode flag the runtime branches on. `if (preset === 'regulated')`
scattered wherever behaviour differs.

That produces code paths only some deployments ever execute. The Regulated path
is the least exercised and the most consequential, and an operator cannot see
what it does without reading the source.

## Decision

A preset **expands to ordinary configuration**. It is a composition, not a mode.

Three properties follow, and all three are load-bearing:

1. **No behaviour lives in a preset file.** `production.ts` and `regulated.ts`
   contain configuration values and nothing else. The comment in `production.ts`
   says so directly: *"this file contains no [behaviour]"*.
2. **No divergent code paths.** The runtime consumes a preset's composed policy
   the same way it consumes any hand-written policy. There is no branch on which
   preset produced it.
3. **It is inspectable.** `describePreset()` returns the expansion, and the
   requirement is specifically that an operator can **inline the expansion and
   change one field** — not that they can read a prose summary of it. `doctor`
   prints it as JSON for exactly that reason: a summary reads better and cannot
   be pasted back.

All three presets share one shape, even where a field is only meaningful to one
of them — `types.ts:96` notes Regulated needs a second field and all three carry
it, rather than the shape varying by preset.

## `pending` is part of the contract

`describePreset()` reports controls a preset **declares but does not yet
enforce**, separately and prominently. A preset that silently promised a control
it did not apply would be worse than one that lacked it: the operator would
believe they were covered.

## Consequences

- **A preset can be audited without running it.** The expansion is data.
- **A preset can be forked.** Inline it, change one field, stop using the named
  preset. No fork of the runtime is needed.
- **Adding a control means touching all three presets**, since they share a
  shape. That is friction, and it is the mechanism preventing drift.
- **`describePreset`'s output is a public surface.** A rename inside it is a
  breaking change for adopters — `docs/migrations/README.md` records exactly
  such a migration (`configuration.audit.durability` →
  `configuration.audit.sink.durable`) as *reported rather than rewritten*,
  because the consumer is the adopter's code.

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record.
Nineteen citations, the most of any number here:

- `packages/core/src/preset/types.ts:5` — *"ADR-007: a preset is a configuration
  COMPOSITION, not a mode. It expands to..."* (the definitional statement)
- `packages/core/src/preset/types.ts:128` — *"the ADR-007 'no divergent code
  paths' requirement"*
- `packages/core/src/preset/production.ts:5`, `regulated.ts:5` — no behaviour in
  preset files
- `packages/cli/src/__tests__/doctor-preset.test.ts:52` — *"ADR-007's actual
  requirement: inline the expansion, change one field"*
- `packages/cli/src/commands/doctor-output.ts:242` — why the expansion prints as
  JSON rather than prose
- `docs/migrations/README.md:32` — `describePreset` as an adopter-facing surface

This number has the richest surviving evidence, so this reconstruction is the
most reliable of the fourteen.
