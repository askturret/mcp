<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-015 — Telemetry is a port in core; OpenTelemetry lives in the adapter

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

The dispatcher must emit spans (§9.1) and metrics (§9.2). OpenTelemetry is the
obvious vehicle, and the obvious implementation is for core to depend on the
OTel SDK directly.

## Decision

Core defines **ports** — the span and metric shapes the dispatcher emits
against. `@askturret/mcp-observability` adapts those onto a real OTel SDK.

Same split as logging: **core owns the contract, the adapter owns the
dependency.**

## The split is structural, not stylistic

`telemetry/types.ts` is unusually direct about this, and it is worth quoting
because it forecloses the obvious objection:

> The split is not stylistic. The dispatcher lives in core and must emit spans;
> if the span type came from the observability package, core would depend on its
> own adapter.

That is a dependency cycle, not a preference. Core → observability → core. The
port exists because the alternative does not compile into a sane graph, and any
future proposal to "simplify" by importing OTel types into core runs into the
same wall.

## Consequences

- **Core has no OTel dependency**, so an adopter who does not want it does not
  carry it — and one on a different backend adapts the port instead of forking.
- **The port must be maintained.** It is a second surface that can drift from
  what OTel actually models, and widening it to expose an OTel-specific concept
  is the drift to watch for.
- **Telemetry may drop, and that is allowed.** The contrast is stated in the
  audit module: telemetry sheds samples under overload and nobody is harmed,
  which is precisely why audit does **not** reuse this path. The two channels
  are separate by design — see the ambiguity note in
  [ADR-014](ADR-014-executors-are-interchangeable.md#the-adr-014-ambiguity).

## Provenance

Reconstructed from the surviving citations, not from a contemporaneous record —
only two exist:

- `packages/core/src/telemetry/types.ts:3` — *"Telemetry ports (§9.1 spans, §9.2
  metrics, ADR-015)"*, plus the "not stylistic" reasoning quoted above
- `packages/core/src/telemetry/index.ts:4` — the same subject (#39)

Thin evidence, but unusually clear: the module header states both the decision
and its rationale, so little here is inferred beyond the framing.
