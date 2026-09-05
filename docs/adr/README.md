<!-- SPDX-License-Identifier: Apache-2.0 -->
# Architecture Decision Records

A decision worth an ADR is one where the reasoning outlives the diff — where a
future reader will otherwise ask *"why on earth is it like this?"* and have to
reconstruct the answer from commit archaeology.

## The records

| # | Decision | Origin |
|---|---|---|
| [002](ADR-002-canonical-source-agnostic-model.md) | The canonical `OperationDefinition` is source-agnostic | reconstructed |
| [004](ADR-004-no-mutable-global-registry.md) | No mutable global registry; snapshots immutable and atomically swapped | reconstructed |
| [006](ADR-006-safety-first-effect-defaults.md) | Effect metadata is inferred safety-first from the HTTP method | reconstructed |
| [007](ADR-007-presets-are-compositions-not-modes.md) | A preset is a configuration composition, not a mode | reconstructed |
| [010](ADR-010-sealed-execution-envelope.md) | The 12-stage execution envelope is sealed | reconstructed |
| [011](ADR-011-typed-operational-errors.md) | Typed operational errors; no raw exception crosses a transport boundary | reconstructed |
| [012](ADR-012-retry-requires-semantic-idempotency.md) | Retry is gated on semantic idempotency, and the decision is pure | reconstructed |
| [013](ADR-013-bulkheads-with-bounded-queues.md) | Bulkheads with bounded queues, never an unbounded one | reconstructed |
| [014](ADR-014-executors-are-interchangeable.md) | Executor strategies are interchangeable (golden-output contract) | reconstructed ⚠ |
| [015](ADR-015-telemetry-ports-not-an-otel-dependency.md) | Telemetry is a port in core; OpenTelemetry lives in the adapter | reconstructed |
| [016](ADR-016-one-central-redaction-pipeline.md) | Exactly one central redaction pipeline | reconstructed |
| [018](ADR-018-plugins-get-scoped-typed-setters.md) | Plugins receive scoped, typed setters, never a mutable runtime handle | reconstructed |
| [019](ADR-019-overlays-carry-provenance.md) | Overlays edit the model without editing the source, and carry provenance | reconstructed |
| [020](ADR-020-explorer-panels.md) | The Explorer is six fixed panels, and no panel bypasses redaction | reconstructed ⚠ |
| [021](ADR-021-two-logger-types.md) | Two logger types in `core`, and when the older one retires | written at the time (#133) |
| [022](ADR-022-concealment-allowlist-is-evidence-bound.md) | The concealment allowlist is evidence-bound: no template without a captured message | written at the time (#276) |
| [023](ADR-023-remedy-test-and-the-two-axes.md) | An issue is a unit of remedy, and a claim states exactly what it verified | written at the time (#566) |
| [024](ADR-024-output-must-vary-with-the-fact.md) | A check's output must vary with the fact it reports | written at the time (#654) |

⚠ = the number is cited for more than one subject; the ADR records that
ambiguity rather than resolving it by invention.

## Numbering, and what "reconstructed" means

This directory was created by [ADR-021](ADR-021-two-logger-types.md) (#133),
which numbered itself 021 rather than 001 to avoid colliding with fourteen
numbers that source comments already cited but that nobody had written down.

**#223 backfilled those fourteen.** Each keeps its original number, because the
citations in the source are the only record of what each one was about —
renumbering would break the link between a comment and its rationale.

**A reconstructed ADR is not a contemporaneous record, and says so.** Each
carries a `Provenance` section listing the citations it was assembled from, and
separates what is quoted from the source from what is inferred. That distinction
is the point: a reader must be able to tell a decision that was written down
from one reassembled afterwards from its consequences.

If you find the original rationale for any of them — in a commit message, a PR
body, an old design document — correct the ADR and say what the new evidence
was. Where two numbers (014, 020) are cited for two different subjects, **split
rather than renumber the citations** if the original allocation resurfaces.

Numbers 001, 003, 005, 008, 009 and 017 are unused. No source comment cites
them, so there is nothing to reconstruct and no gap to explain. Do not reuse
them for new decisions: a future reader finding an ADR-003 would reasonably <!-- adr-citation-exempt: deliberate hypothetical, and the number is unused on purpose -->
assume it was one of the originals.

## Format

One file per decision, `ADR-NNN-kebab-title.md`, with:

- **Status** — Accepted / Superseded by ADR-NNN. Say which.
- **Context** — the forces. What is true that makes this a decision rather than
  an obvious step?
- **Decision** — what was chosen, in the active voice.
- **Consequences** — including the ones you dislike. An ADR listing only
  benefits is a sales document.
- **Retirement trigger**, when the decision is a deferral. A deferral without a
  named condition is not a decision; it is a decision postponed indefinitely,
  and it hardens into permanence precisely because nobody wrote down what would
  end it.

Amend an ADR only to fix an error. A decision that changes gets a new ADR that
supersedes the old one, because the reason the old one was made is still the
reason the code looked that way for a while.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
