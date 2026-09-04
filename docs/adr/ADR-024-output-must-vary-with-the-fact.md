<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-024: A check's output must vary with the fact it reports

**Status:** Accepted (#652)

## Context

On 2026-09-04 this repository found five checks whose output did not depend on
what they were checking. They were found by five different routes, none of them
a guard, and four of the five were self-disclosed by the agent that wrote the
defect.

| | what it printed | why the printing was unconditional |
|---|---|---|
| **#644** | `NO FILTER TRIPPED`, for every possible input | `tr -d " -'"` is the **range** `0x20`–`0x27`, which does not contain `-` (`0x2D`). Every parsed glob kept a leading dash and matched nothing |
| **#649** | `Nothing was compared. This is NOT a pass.` | `main()` returns from the cannot-check branch before the divergence loop, discarding a partially-successful scan |
| **#575** | `41 before, 0 after` | the extracted test ran from `/tmp`, where its relative import does not resolve; a non-resolving query was read as the answer zero |
| **QA's shell** | `worktree clean`, beside a `git status` showing a modified file | the `echo` was not conditional on the check above it |
| **#646** | a passing symlink probe | the probe symlinks the containing **directory**, so the basename survives — and the one guard still carrying the defect is a suffix-matcher |

The forces that make this a decision rather than an obvious step:

- **The repository already holds the correct principle, and states it well.**
  `check-runners.mjs` and `check-label-dependence.mjs` both carry the exit-2
  discipline in their headers: *"a guard that cannot read its input and exits 0
  is indistinguishable in a CI log from one that checked and found nothing"*.
  **Every one of the five defects above was written by someone who had that
  principle available.** So a decision that merely restates it would not have
  prevented any of them.
- **Four of the five are not CI guards.** They are a shell fragment, a status
  line, an ad-hoc measurement and a test probe. The exit-code vocabulary that
  carries the principle in CI has no equivalent in those places, so the
  principle silently stopped applying at the boundary of the thing it was
  written for.
- **The failure is invisible by construction.** A check whose answer never
  changes reads exactly like a check that keeps passing. Nothing in a green log
  distinguishes them, which is why all five were found by a human noticing an
  implausible number or re-reading their own work, and none by a mechanism.

## Decision

> **Before trusting a check, ask: can I make this report say something else by
> changing only the thing it is about?**
>
> **If not, the output is a constant wearing a verdict.**

That is the whole rule. It is a question to ask while writing, not a taxonomy to
classify against afterwards, and it is deliberately cheap enough to apply to a
two-line shell fragment.

Three notes on applying it:

**Change the fact, not the fixture.** The question is whether the *subject*
moves the output. #646 is the instructive case: its probe does vary — with the
symlink, with the path, with the filesystem — just not with **the defect it
exists to catch**. Vary the thing the check claims to detect, and nothing else.

**A check that cannot fail and a check that cannot succeed are the same defect.**
#644 could only ever say "no"; #649 could only ever say "nothing was compared"
once one directory was unreadable. Both are outputs pinned by their
implementation rather than by their subject. The direction of the constant does
not matter.

**Absence of a result is a third value, and it must print as one.** #575 read a
non-resolving query as the number zero. Wherever a check can *fail to obtain* an
answer, that state needs its own output, distinct from both answers. This is the
exit-2 discipline generalised past exit codes: **the vocabulary needs three
words, whatever the medium.**

## Why this is not already covered by ADR-023

[ADR-023](ADR-023-remedy-test-and-the-two-axes.md) records two axes, and this is
neither of them. Stated precisely, because a third restatement of one principle
would be worse than no record:

- **Axis 1 — verify the property that matters.** Presumes the check verifies
  *some* property and the wrong one was chosen. #644's lane check names exactly
  the right property; its output is attached to nothing.
- **Axis 2 — state exactly what you verified.** Presumes the report tracks a
  real verification and overstates its reach. #649's message does not overstate;
  it is simply **false** — it says nothing was compared when one directory was
  scanned successfully.

Both axes assume an output that tracks *something*. **This one is about outputs
that track nothing**, and it is the axis under which a check can be
simultaneously well-aimed and well-described and still worthless.

## What was deliberately rejected

Recorded so nobody re-derives them as obvious simplifications.

**"Never pin a count."** This is the rejection that matters most, because the
rule is tempting and would delete a load-bearing assertion. Two pinned counts in
this repository look alike and are not:

- `check-runners.test.mjs:638` pins `'23 on the approved self-hosted pool'`. The
  population **grows**, the number is **incidental**, and the correct response to
  a red is to update the number — which guarantees it reddens again forever, and
  guarantees the update becomes reflexive.
- `errors.length === 1` in the coverage-status self-test is the opposite. The
  fixture is built so that exactly one rule can refuse it, so **the count is the
  property**, and the correct response to a red is to fix the fixture.

**Neither is an instance of this ADR** — both outputs vary with their subject, so
both pass the test above. The tally trap is a real and adjacent defect, and it is
about a *true* assertion on an *incidental* property. Distinguish them by asking
**"is the number the property, or a by-product of it?"**, and note that the tally
trap is diagnosed by the response it invites rather than by the assertion itself.

**A guard that detects this class.** It would have to decide whether an output
depends on a subject, which is the halting problem wearing a lint rule. The
tractable subset — mutation testing, which this repository already runs — covers
guards with self-tests and does not reach shell fragments or status lines, where
four of the five instances lived.

**Folding it into ADR-023.** Q1 of that record says shared principle is not
shared work; the same applies to records. Three axes in one document, each with
its own worked examples, would blur the distinction that makes any of them
usable at the moment of writing.

## Consequences

**Good.** The test is one question and applies to a shell fragment as readily as
to a guard, which is where four of the five instances were.

**Good.** It gives the exit-2 discipline a form that survives outside CI. The
principle was already right and already written down; it had no vocabulary in
the places it kept escaping.

**Bad, and accepted.** The test is only as good as the reader's imagination about
what "the fact" is. #646 passes a naive reading — the probe demonstrably varies —
and fails only when the reader asks specifically whether it varies *with the
defect*. That is a judgement, and it will sometimes be made wrongly.

**Bad, and accepted.** Nothing enforces this. It is applied by whoever writes the
check, which is exactly the population that wrote all five instances. The honest
claim is that a one-question test is cheaper to remember than a principle stated
in a header the writer has already read and not applied.

**Bad, and NOT mitigated.** A check already in the tree with an invariant output
looks green and will keep looking green. This record does nothing for the
existing population, and no audit of it has been done — the five above were found
incidentally, over one day, which is not evidence that they are the only five.

## Provenance

Written at the time, from the 2026-09-04 session. **The distinction between
what was verified here and what was reported by others is load-bearing, since
the subject of this record is checks that were trusted without being exercised.**

**Verified independently for this ADR:**

- **#644** — measured, not restated. `printf '%s' "-abc def'ghi-jkl" | tr -d " -'"`
  yields `-abcdefghi-jkl`; both dashes survive, and the escaped form `" \-'"`
  removes all three characters. The range reading is confirmed by observation.
- **#649** — read in `check-label-dependence.mjs`. The cannot-check branch prints
  and returns before the violations loop. **One refinement to how it was reported
  to me:** the violations are not computed and then discarded, because the return
  precedes the loop. What is computed and discarded is `scanTree`'s `found` — a
  partial scan can succeed on one directory while the other pushes a problem, so
  the printed sentence *"Nothing was compared"* is **literally false** in that
  case. The defect is real and slightly different from its description.
- **`check-runners.test.mjs:638`** — the pinned `23` exists as described.

**Reported by others and NOT reproduced here:** #575's `41 before, 0 after`
measurement and its `/tmp` cause; QA's own status-line defect, which is not in
this repository; #646's symlink-probe analysis; and the `errors.length === 1`
assertion, which **is not on `main`** — it lives on the PR #650 branch, so the
counter-example above rests on QA's reading of code this record's author has not
seen.

## Retirement trigger

Revisit if mutation coverage ever extends past guards with self-tests to the
shell fragments and reporting paths where four of these five lived. At that point
the class becomes mechanically detectable for the population that actually
carries it, and a test applied by hand is the weaker control.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
