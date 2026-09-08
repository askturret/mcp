<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-026: A brief's premise is the receiver's to verify, not the dispatcher's to guarantee

**Status:** Accepted (#780)

## Context

Between 2026-09-05 and 2026-09-08, **at least ten task briefs in this repository
carried a premise that did not survive a source read**, and in every case the
correction changed the work rather than merely tidying it.

Seven were corrected by the architect on receipt:

| Issue | The brief said | The source said |
|---|---|---|
| **#696** | *"nothing local can add a DCO sign-off"* | a trailer typed into the message passes; the checker compares strings against author or committer and has no notion of provenance |
| **#676** | *"a corpus row recording five notices in one file"* | no such row. 234 files, 239 rows; the five is the arithmetic surplus |
| **#741** | *"twenty-five `check-*.mjs` guards"* | 34 non-test guards, 26 of them PR-lane-only |
| **#780** | *"`.operum/knowledge/decisions.md` is a protected path"* | that file does not exist here; ADRs live in `docs/adr/`, which is not protected |
| **#747** | the protected-file lane applied | it did not, for the paths in question |
| **#687** | shipped work needed re-designing | it had merged the previous day |
| **#739** | a detector count | the count was wrong, and the routing followed from it |

Three more were corrected by the Engineer on receipt (#726, #795, #784) —
#726 closed as a **non-defect** on the Engineer's own refutation of the filing.

Two things about that table matter more than its length:

- **The briefs were written in good faith and were often nearly right.** Each was
  a reasonable reading of a real observation. #676's "five" was a real number
  about a real corpus — it was the *surplus*, not a file's contents.
- **Every correction was cheap, and every one was only available downstream.**
  The dispatcher had not read the file; the receiver was about to. The
  information asymmetry runs one way, and it runs toward the receiver.

## Decision

> **The premise of a dispatch is the RECEIVER's to verify, before building
> against it. A dispatcher's framing carries information, not authority.**
>
> Test the premise against source first. If it does not hold, say so plainly and
> rule on what is actually true — **a well-evidenced refutation is a complete
> answer, not a failure to do the task.**

Two conventions follow, and both are in use:

**The dispatcher marks what they checked.** Claims are labelled `VERIFIED` or
`UNVERIFIED`, and unmarked claims are treated as premises to test. This is the
cheap half: it costs the dispatcher a sentence and tells the receiver where to
spend the read.

**The receiver states what they did not read.** A ruling names the files it
rested on and the ones it did not, so the dispatcher knows which claims are
provisional. Without it, a refutation is just a competing assertion.

## What this is not

**It is not distrust, and it is not a licence to ignore the brief.** The brief is
the best available account of why the work matters, and it is usually right about
that even when it is wrong about a fact. Refuting a premise does not discharge
the task — #696's refutation was only useful because it went on to find what the
real gap was.

**It is not an invitation to re-scope.** Testing *"is this true?"* is in scope.
Deciding *"is this worth doing?"* is the dispatcher's call unless the answer
falls out of the evidence.

## What was deliberately rejected

**"The dispatcher verifies before dispatching."** This is the obvious
alternative and it fails on cost and on capability. The dispatcher would have to
read the same source the receiver is about to read, which doubles the read to
prevent an error the receiver would have caught anyway — and a dispatcher
routing ten tasks cannot hold ten codebases. **The asymmetry is structural, not a
discipline problem**, so the remedy has to sit where the reading already happens.

**Requiring a refutation to come with a full replacement plan.** Tempting,
because a bare *"your premise is wrong"* is unsatisfying. But it would make the
cheapest correction the most expensive to deliver, and the correction is the part
with the value: #726 was closed as a non-defect, and no plan was needed or
wanted.

**Treating a refuted brief as a dispatcher error worth tracking.** Rejected
deliberately. The briefs above were good-faith readings that happened to be
wrong, and a record that scores them would suppress the confident framing that
makes briefs useful. **The desired end state is more refutations, not fewer
briefs.**

## Consequences

**Good.** The correction happens before the build rather than during it. Three of
the ten would have produced work against a false premise — #687's would have
re-designed something already merged.

**Good.** It puts the verification where the reading already happens, so the
marginal cost is close to zero: the receiver was going to open the file anyway.

**Bad, and accepted.** Every task now starts with a read that usually confirms
the brief. That is real cost paid on the majority case to catch the minority one,
and it is slower than trusting the framing.

**Bad, and accepted.** **The receiver can be wrong too**, and a refutation
carries more authority than it has earned unless its evidence is stated. This
author has twice reported a false finding from re-deriving the wrong artifact —
once re-reading an issue's *label* rather than the work behind it, and nearly
escalating over a decision that had merged the day before.

**Bad, and NOT mitigated.** Nothing distinguishes a premise that was tested and
held from one that was never tested. A brief that survives contact looks
identical to one nobody checked.

## Why this record lives here

`.operum/knowledge/decisions.md` does not exist in this repository, so
`docs/adr/` is the decision log. This record is about how work arrives rather
than about the product, which puts it alongside
[ADR-023](ADR-023-remedy-test-and-the-two-axes.md) and
[ADR-024](ADR-024-output-must-vary-with-the-fact.md) rather than the
product-architecture records — a small, established minority of this directory.

## Provenance

Written at the time, from the 2026-09-08 session.

**Verified independently for this ADR:** the seven architect-side rows in the
table above are this author's own rulings, each posted with the source read
recorded on its issue. #696's, #676's, #741's and #780's corrections were
re-derived from source during this session; **#747's, #687's and #739's are
this author's own earlier reports and were not re-read while writing this.**

**Verified by QA, from its own work, during review of this record:**

- **#795** — the brief said GraphQL and gRPC *"appear nowhere in the
  repository."* They are at `README.md:275-276`. Confirmed while QA-ing PR #796.
- **#784** — the brief hypothesised an admin-credentialled read; the read was
  **unauthenticated**. Confirmed against `origin/main` while QA-ing PR #802.

**Reported and NOT reproduced here:** the Engineer's refutation on **#726** and
its closure as a non-defect. That is **one** claim taken on report, not three, so
the count of ten rests on a single unverified input.

> An earlier draft said three. **That overstated the record's own uncertainty** —
> a smaller fault than understating it, but still a wrong value, and it undersold
> the claim. Corrected from QA's verification rather than from a re-reading of
> the issues, which is itself this record's thesis running the other way: the
> reviewer held the evidence the author did not.

> **#780 — the task that produced this record — was itself an instance.** Its
> brief specified the protected-file lane for a file that does not exist in this
> repository. Had it not been tested, this ADR would have shipped with a
> gratuitous `no_verify` override and an audit row recording a bypass of a guard
> that was never going to fire.

## Retirement trigger

Revisit if briefs stop carrying unverified premises — if, over a comparable
period of comparable volume, the refutation rate approaches zero. At that point
the read is pure cost and the convention should be relaxed to spot-checking.
Revisit also if refutations begin to be wrong at a material rate, since the
receiver's read would then need the same scepticism this record applies to the
dispatcher's.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
