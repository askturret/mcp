<!-- SPDX-License-Identifier: Apache-2.0 -->
# Architecture Decision Records

A decision worth an ADR is one where the reasoning outlives the diff — where a
future reader will otherwise ask *"why on earth is it like this?"* and have to
reconstruct the answer from commit archaeology.

## Numbering, and a caveat about it

**This directory was created by [ADR-021](ADR-021-two-logger-types.md) (#133),
and does not backfill.**

Source comments across this repository already cite fourteen ADRs by number —
ADR-002, -004, -006, -007, -010, -011, -012, -013, -014, -015, -016, -018, -019
and -020 — and **none of them is written down anywhere.** Every one of those
citations is dangling.

So the numbering starts at 021 rather than 001: reusing a number that a source
comment already attaches to a different decision would be worse than the gap
it appears to fill. Writing up the fourteen is real work against merged code
and belongs in its own issue, not smuggled into an unrelated PR.

If you write one of the missing ones, keep its original number — the citations
are already in the source and are the only record of what each was about.

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
