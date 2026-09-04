<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-024: A check's output must vary with the fact it reports

**Status:** Accepted (#652)

## Context

On 2026-09-04 this repository found five checks whose output did not depend on
what they were checking. They were found by five different routes, none of them
a guard, and most were self-disclosed by whoever wrote the defect.

| | what it printed | why the printing was unconditional |
|---|---|---|
| **#644** | `NO FILTER TRIPPED`, for every possible input | `tr -d " -'"` is the **range** `0x20`–`0x27`, which does not contain `-` (`0x2D`). Every parsed glob kept a leading dash and matched nothing |
| **`check-label-dependence.mjs`** | `Nothing was compared. This is NOT a pass.` | `main()` returns at `:206`, before the `violations` array at `:209`. `scanTree` can succeed on one directory while the other pushes a problem, so the sentence is **false** whenever a partial scan happened |
| **#575** | `41 before, 0 after` | the extracted test ran from `/tmp`, where its relative import does not resolve; a non-resolving query was read as the answer zero |
| **QA's shell** | `worktree clean`, beside a `git status` showing a modified file | the `echo` was not conditional on the check above it |
| **this ADR's own first commit** | a `Signed-off-by` trailer naming `dmitrys-mac-mini-8` | the value was written from memory of an earlier fix. It names a machine, and does not depend on the machine — the host had been rebuilt as `-9` |

The forces that make this a decision rather than an obvious step:

- **The repository already holds the correct principle, and states it well.**
  `check-runners.mjs` and `check-label-dependence.mjs` both carry the exit-2
  discipline in their headers: *"a guard that cannot read its input and exits 0
  is indistinguishable in a CI log from one that checked and found nothing"*.
  **Every one of these defects was written by someone who had that principle
  available** — the second was written into the very file that states it.
- **Most of them are not CI guards.** A shell fragment, a status line, an ad-hoc
  measurement, a commit trailer. The exit-code vocabulary that carries the
  principle in CI has no equivalent in those places, so the principle silently
  stopped applying at the boundary of the thing it was written for.
- **The failure is invisible by construction.** A check whose answer never
  changes reads exactly like a check that keeps passing. Nothing in a green log
  distinguishes them, which is why these were found by someone noticing an
  implausible number or re-reading their own work, and none by a mechanism.

## Decision

> **Before trusting a check, ask: can I make this report say something else by
> changing only the thing it is about?**
>
> **If not, the output is a constant wearing a verdict.**

That is the whole rule. It is a question to ask while writing, not a taxonomy to
classify against afterwards, and it is deliberately cheap enough to apply to a
two-line shell fragment or a commit trailer.

Three notes on applying it:

**The invariance must hold over the whole input domain.** This is what keeps the
test binary and therefore useful. A check that is constant *everywhere* is this
defect. A check that is merely **incomplete** — discriminating over most of its
domain and blind on a sub-region — is a different problem with a different
remedy, and is excluded deliberately. See *What was deliberately rejected*.

**A check that cannot fail and a check that cannot succeed are the same defect.**
#644 could only ever say "no"; `check-label-dependence` could only ever say
"nothing was compared" once any directory was unreadable. Both are outputs pinned
by their implementation rather than by their subject. The direction of the
constant does not matter.

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
  real verification and overstates its reach. `check-label-dependence`'s message
  does not overstate; it is simply **false** — it says nothing was compared when
  one directory was scanned successfully.

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
- `ci-coverage-status.test.mjs:155` and `:168` assert `errors.length` is `1`. The
  fixture is built so that exactly one rule can refuse it, so **the count is the
  property**, and the correct response to a red is to fix the fixture. The file
  says so itself: *"if another rule starts firing here, the message assertion
  above would still pass while no longer proving which branch ran."*

**Neither is an instance of this ADR** — both outputs vary with their subject, so
both pass the test above. The tally trap is a real and adjacent defect, and it is
about a *true* assertion on an *incidental* property. Distinguish them by asking
**"is the number the property, or a by-product of it?"**, and note that the tally
trap is diagnosed by the response it invites rather than by the assertion itself.

**A guard that detects this class.** It would have to decide whether an output
depends on a subject, which is the halting problem wearing a lint rule. The
tractable subset — mutation testing, which this repository already runs — covers
guards with self-tests and does not reach shell fragments, status lines or commit
trailers, where most of these instances lived.

**Folding it into ADR-023.** Q1 of that record says shared principle is not
shared work; the same applies to records. Three axes in one document, each with
its own worked examples, would blur the distinction that makes any of them
usable at the moment of writing.

**#646's symlink probe — excluded, and the reasoning is the boundary of the
test.** An earlier draft carried it as the sharpest instance. It is not an
instance at all. The probe is **not** a constant: it discriminates over most of
its domain, and was demonstrated on #643 to turn red on a reverted guard *and
name it*. It is blind only on a sub-region — basename-sensitive entry checks —
because it symlinks the containing directory, so the basename survives.

That is **incomplete coverage, not a constant wearing a verdict**, and the
distinction is exactly ADR-023's Q3: different remedy, different record. The
instances above need a **structural** fix — make the output depend on its
subject. #646 needs a **domain** fix — widen the probe's inputs. The same
criterion that justifies this ADR existing separately from ADR-023 excludes #646
from this ADR.

**It is recorded here because the exclusion is load-bearing.** Under the broad
reading that would admit #646, every incomplete test suite qualifies, and the
test stops being binary — which is the only property that makes it worth asking
while writing.

## Consequences

**Good.** The test is one question and applies to a shell fragment or a commit
trailer as readily as to a guard, which is where most of these instances were.

> Applied prospectively once, while writing this record: a `git var
> GIT_AUTHOR_IDENT` read was about to stand in for the commit's author, and its
> output varies with the **config**, not with the author it purports to report.
> The question caught it before the commit — the same wrong artifact as the
> trailer instance above, in a third form, from the same author on the same day.

**Good.** It gives the exit-2 discipline a form that survives outside CI. The
principle was already right and already written down; it had no vocabulary in
the places it kept escaping.

**Bad, and accepted.** The test's sharpness depends on holding the
whole-domain line. The pressure to admit near-misses is real — the first draft
of this record admitted one — and each admission makes the question less
answerable at a glance.

**Bad, and accepted.** Nothing enforces this. It is applied by whoever writes the
check, which is exactly the population that wrote every instance above. The
honest claim is that a one-question test is cheaper to remember than a principle
stated in a header the writer has already read and not applied.

**Bad, and NOT mitigated.** A check already in the tree with an invariant output
looks green and will keep looking green. This record does nothing for the
existing population, and no audit of it has been done — these were found
incidentally, over one day, which is not evidence that they are the only ones.

## Provenance

Written at the time, from the 2026-09-04 session. **The distinction between what
was verified here and what was reported by others is load-bearing, since the
subject of this record is checks that were trusted without being exercised.**

**Verified independently for this ADR:**

- **#644** — measured, not restated. `printf '%s' "-abc def'ghi-jkl" | tr -d " -'"`
  yields `-abcdefghi-jkl`; both dashes survive, and the escaped form `" \-'"`
  removes all three characters. The range reading is confirmed by observation.
- **`check-label-dependence.mjs`** — read on `main`. The cannot-check branch
  prints and returns at `:206`; the `violations` array is declared at `:209` and
  never reached. `scanTree` returns `{ found, problems }` from one call, so a
  partial scan's `found` is discarded along with the return.
- **`check-runners.test.mjs:638`** and **`ci-coverage-status.test.mjs:155,:168`**
  — both counter-example assertions read on `main`.
- **The trailer instance** — its own DCO check refused the commit, naming the
  mismatch between the remembered value and the actual author.

**Reported by others and NOT reproduced here:** #575's `41 before, 0 after`
measurement and its `/tmp` cause; QA's own status-line defect, which is not in
this repository; and **#649**, whose subject is
`check-release-registry-reconcile.mjs` — **not on `main`**, so unreadable from
here. QA demonstrated its mechanism empirically on the #648 branch: the loop
*runs*, divergences *are* computed, and `main()` returns from the cannot-check
branch without printing them.

> **An earlier draft of this record attributed the `check-label-dependence`
> finding to #649.** They are two different files with two different mechanisms —
> one returns before computing, the other computes and then discards — and the
> mistake was verifying a claim by reading a *different* guard than the one the
> claim was about. It is recorded rather than quietly corrected because this
> document's entire subject is claims trusted without being exercised, and the
> error is that failure committed inside the record describing it. It was caught
> by review, not by the author.

## Retirement trigger

Revisit if mutation coverage ever extends past guards with self-tests to the
shell fragments, reporting paths and commit metadata where most of these
instances lived. At that point the class becomes mechanically detectable for the
population that actually carries it, and a test applied by hand is the weaker
control.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
