<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-023: An issue is a unit of remedy, and a claim states exactly what it verified

**Status:** Accepted (#566)

## Context

On 2026-09-04 a single review pass produced five defects that read as the same
bug told five ways:

- **#587** — the tarball guard asserts `NOTICE` is PRESENT, never that it is
  CURRENT.
- **#592** — `check-tarball-compliance` passes on a tarball containing no
  `dist/`.
- **#591** — the root manifest's publish-safety holds only by a choice made
  somewhere else.
- **#598** — every README import resolves, and resolves for nobody outside this
  monorepo.
- **#593** — the label-dependence detector under-covers, and its own artifact
  says it checks "both directions".

The pull toward one big remedy was strong, and two different instincts were
pulling. The first said *these are one defect, merge them*. The second said
*these are five files, five diffs, five issues*. **Both are wrong, and they are
wrong about different questions** — which is the observation this record exists
to preserve.

The forces that make this a decision rather than an obvious step:

- **Consolidation is cheap to propose and expensive to reverse.** Merging five
  issues takes one comment; recovering the four requirements that were folded
  away takes an incident.
- **The same evidence supports both instincts.** Every pair above shares
  *something* — a cause, a file, a principle, a deadline — and each of those
  four feels like grounds for merging. Only one of them ever is.
- **The failure is silent in both directions.** An over-merged issue reports one
  verdict for several guarantees; an over-split one produces an issue that can
  only sit blocked. Neither announces itself.

## Decision

Two rules, and they are the same rule seen from two distances. The first governs
**what a check may claim**. The second governs **how many issues a set of
observations becomes**. They are recorded together because the second is the
first generalised from writing a guard to filing a report about one, and
separating them would divide a principle from its own worked examples.

---

## Part 1 — The two axes of a verified claim

### Axis 1 — Verify the property that matters

> A check must verify the property that matters, not the adjacent property it
> happens to be able to see.

The adjacent property is always cheaper, and the check that asserts it always
passes. #587 can see that `NOTICE` exists; whether it is *current* costs a
regeneration. #592 can see that a tarball unpacks; whether it contains built
code costs a build. #598's import test can see that a specifier resolves *here*;
whether it resolves for a reader costs a clean install against a published
tarball.

Four sub-shapes, kept distinct because they have different remedies:

| Sub-shape | Instance |
|---|---|
| asserts an adjacent property | #587, #592 |
| passes on an artifact with nothing in it | #592 |
| holds only by a choice made elsewhere | #591 |
| verifies in an environment the user is not in | #598 |

The fourth is the one that hides longest. #598's README imports had survived
three separate rounds of review and repair, because the root package is named
`@askturret/mcp` and declares `exports`, so **package self-reference makes every
one of them resolve inside this repository.** The test was honest, the reviewers
were careful, and the environment was the wrong one.

### Axis 2 — State exactly what you verified, and no more

> A check must describe its own reach accurately. Understating it is a cost;
> overstating it is a defect.

#593 is the instance. Its detector enforces a registry in two directions; one
direction is solid and the other is a pattern matcher with at least eight known
blind spots. Neither the guard's header nor the registry's own prose says so —
both state that it "compares it against the tree in BOTH directions".

**The asymmetry is what makes this an axis rather than a style note.** An
understated bound costs a reader one unnecessary check. An overstated one costs
them the check they needed, because a claim of breadth is exactly what stops
someone looking further. A narrow guard that reports narrowly is honest; a
narrow guard whose artifact claims breadth actively suppresses its own
discovery.

Where the overstatement sits matters as much as that it exists. #593's claim
appears twice: once in the script header, read by whoever maintains the guard,
and once in `.github/label-dependent-checks.json`, read by the contributor
adding an entry — four lines above the sentence *"When the population grows, add
the entry."* The second is targeted false assurance at the moment of maximum
consequence.

### Axis 2 has a time dimension, and it is not solved by writing more carefully

This is the least obvious consequence in this record and the one most likely to
be lost, so it is stated as its own rule:

> **An honestly-stated bound decays into a false claim the moment the thing it
> bounds ships. The remedy for a decaying claim is not a more careful claim — a
> more careful claim decays identically.**

The evidence is a single file. `docs/compatibility.md` contains two support
notes four lines apart, written with equal care:

- Line 57 marks Express 5.x **"⚠️ Declared, untested"**, and the note beneath it
  names the exact mechanism — *"CI installs Express 4 and `@types/express` is
  pinned to v4 types"*. It is the best-calibrated claim examined in the whole
  sweep, and it states its own remedy: *"until a CI job covers it."*
- Line 58 marks Fastify **"🔜 Planned"**, and the note beneath asserts *"no
  adapter package, no `fromFastify` export, and no implementation."* **Two of
  those three clauses are false, and the third is the interesting one.**
  `@askturret/mcp-adapters-fastify` is built, tested, exported at
  `@askturret/mcp/fastify` and published at `0.1.1` — so *no adapter package*
  and *no implementation* are both wrong. But **`fromFastify` genuinely does not
  exist, and never did.** The package exports `mcpFromOpenApi` and `fastifyMcp`;
  a repo-wide search finds the identifier nowhere outside the note itself.

**Nothing distinguishes the author's diligence between those two notes. What
differs is that the world moved under one of them.** The Fastify note was true
when written; shipping the adapter is what made it a lie, and no amount of care
at writing time would have prevented that.

**The mixture is a sharper illustration than a uniformly-false note would be.**
The clause that survives names something that never shipped; the two that failed
name the things that did. So the note did not simply rot — it is a description of
a world that moved out from under exactly the claims the world touched, and left
the one it never touched standing. A reader checking only `fromFastify` would
have confirmed the note and moved on.

> **An earlier draft of this record said "every clause is false", and that was
> itself an overstatement — asserted three clauses false where the source issue
> had rebutted two.** Recorded rather than quietly corrected, because of where it
> sat: an overstated claim inside the section defining overstatement as the
> defect. That is the Axis-2 failure committed by the document cataloguing it,
> which is precisely the trap Q4 names one level up. It was caught by review, not
> by the author.

So Axis 2 is not only *"state your bound"*. It is *"state your bound, and give
something the job of noticing when it expires."* A bound that names its own
expiry condition — as the Express note does, in the words *until a CI job covers
it* — is checkable. A bound that merely describes today's state is not, and it
will go stale with nothing watching.

This is the same mechanism as #587 one level up: a claim that asserts *present*
where it needed to assert *current*, applied to prose rather than to a guard.

---

## Part 2 — The remedy test

> **Two observations are one issue when ONE change retires both. Otherwise they
> are two — no matter how much they share.**

Shared cause, shared file, shared principle and shared deadline are each
sufficient to make two issues *feel* like one, and none of them is evidence for
it. Only the remedy counts.

The one-line form, for the moment of filing:

> **Ask "does one change fix both?", not "are these the same kind of thing?"
> The second question has a good answer, and it is called an ADR.**

Four qualifiers. Each is here because it was learned rather than reasoned out,
and each names the case that taught it.

### Q1 — Shared principle is not shared work

**Test:** *if I remedy one, is the other still broken?* If yes, they are
separate, however identical the lesson.

#599 cites the Axis-1 family and does not belong to it. Those guards **run** and
assert an adjacent property; #599 is the **absence of any check at all** — no
mechanism anywhere compares the GitHub Releases to the npm registry. Same
principle exactly; opposite remedy. The family members need *better assertions*;
#599 needs *a new observer over a system nothing has ever looked at*.

**The ADR carries the principle. The issue carries the change.** Five issues
citing this record remain five issues. That is what an ADR is for, and it is why
the answer to "these are all the same kind of thing" is to write one of these
rather than to merge a backlog.

### Q2 — A cheap half may be split out only if it can land independently

**Test:** *could the cheap half MERGE TODAY with the expensive half unstarted?*
If not, it is not a split; it is a wish, and filing it produces an issue that
can only sit blocked.

This qualifier exists because the same instinct was applied twice in one session
and was right once and wrong once.

- **#593 → #602 succeeded.** The false "both directions" claim is prose with no
  dependency on the detector work, so it lands alone. Leaving it inside #593
  would have queued a minutes-long correction behind a rewrite — and raising
  #593's priority to carry it would have bought urgency for the cheap half by
  overstating the expensive one.
- **`express`/`qs` on #585 failed.** The bump reads as two changes bundled by a
  bot: a major framework upgrade and an unrelated minor. It is not.
  `express@4.22.2` and `body-parser@1.20.6` both declare `qs: ~6.15.1`, and the
  tilde caps below `6.16.0`. **`qs@6.16.0` is unresolvable while Express 4 is
  installed** — not by policy, but because npm will not resolve it.

**The discriminator is mechanical reachability, not conceptual separability.**
Both pairs looked separable, and looking separable is worth nothing. The
question is whether the cheap half can reach `main` on its own.

### Q2's verdict is time-indexed, and must be recorded with its expiry

The pair above is not a fixed fact about `express` and `qs`. `express@5.2.1`
declares `qs: ^6.14.0`, which **admits** `6.16.0` — so the constraint that makes
them one issue today **dissolves the moment the Express 5 upgrade lands.** The
same two observations are one issue before #585 and two issues after it, with
nothing about either observation having changed.

So Q2 does not read a property of the pair. **It reads the dependency graph at a
point in time**, and a merge justified that way inherits an expiry date whether
or not anyone writes it down.

> **A Q2 merge must record the constraint together with its expiry condition.**
> Not *"one issue"*, but *"one issue while `express@4` pins `qs: ~6.15.1`"*.

This is Axis 2's time dimension applied to the remedy test itself. A merge
justified by a constraint decays into a **wrong** merge when the constraint
lifts, and — exactly as with the Fastify note — there is no diff at the moment it
becomes wrong, so nothing prompts a re-examination. The Express compatibility
note is exemplary because it names *"until a CI job covers it"*; a Q2 merge owes
the reader the same sentence.

**This record initially failed to say so**, presenting the coupling as though it
were permanent. It was found in review, which the author had invited to attack
this qualifier — and the review also disposed of the objection the author had
offered against it. *n = 2* is **not** the weakness: the two cases are a
**minimal pair demonstrating dissociation** — one where conceptual separability
and mechanical reachability agree, one where they come apart — and two is the
correct size for that, not a thin sample. The real weakness was time-indexing,
and it was somewhere else entirely.

### Q3 — A review discovery becomes a new issue when it has its own remedy and its own reader

**Test:** *would this still need doing if the parent were retired today?*

#603 and #604 both surfaced while reviewing #585 and neither depends on it. The
stale Fastify row is wrong regardless of which Express version CI installs; the
dependabot DCO question recurs on every future dependency PR. Both passed the
test, and both were filed rather than appended.

The failure this prevents is the *omnibus issue* — a parent that accumulates
every observation made while reading it, until no single change can retire it
and it stops being routable at all.

### Q4 — A shared file is a sequencing constraint, never a merge argument

**Test:** none. This one is unconditional.

Two issues touching one file remain two issues. What the shared file changes is
the **order** they may be dispatched in, never the count.

**This is the qualifier that makes grouping-by-change-surface safe, and without
it that exercise causes harm.** "Group the backlog by shared change surface"
reads naturally as an instruction to consolidate. Followed that way, #587 and
#592 become one issue — and that issue then reports **one verdict for two
independent guarantees**, which is precisely the Axis-1 defect, committed by the
person cataloguing it.

The correct handling of #587 and #592 is *two issues, one PR, dispatched
sequentially*. They edit the same guard, so parallel dispatch conflicts; they
assert different properties, so a single verdict is a lie. Both facts are true
at once, and only Q4 keeps them from collapsing into each other.

**Grouping answers "in what order?". The remedy test answers "how many?".
Conflating those two questions is what this qualifier exists to stop.**

---

## Worked examples, including the ones that went wrong

An ADR of principles with no scars is one nobody applies.

**#576 and #581 — genuinely one defect, and neither issue's evidence was ever
strong enough to say otherwise.** `check-test-execution.test.mjs` copies the
Node binary into a temp directory and immediately execs it; that intermittently
fails to start, yielding a null exit status. The mutation audit runs that same
self-test when auditing the guard, so the flake surfaces there as an integrity
failure instead. One ladder, two observation points, one remedy → **one issue**.

The instructive part is the arithmetic. #581 argued it was distinct because
#576 *"does not reproduce in isolation"* — but the isolated audit makes about
four invocations of a fault that fires roughly one time in ten, so **three clean
runs have about a 29% chance of occurring by luck.** "Reproduces in isolation"
versus "only under load" is not a difference of mechanism when the mechanism is
probabilistic; it is a difference of sample size. Neither issue's exclusion
evidence was ever strong enough to separate them, and both said so in the
language of certainty.

**The author of this record was wrong twice in the session that produced it,
and both corrections changed a recommendation.**

- Sizing #585 from its nature rather than its source produced four predictions,
  of which **three were wrong**: the adapter's Express-5 blast radius is
  essentially nil, the peer range already accepted both majors so there was
  nothing to re-decide, and the compatibility matrix did not claim what it was
  assumed to claim.
- On #598 the recommendation leaned toward publishing an umbrella package,
  on the reasoning that it would make the README correct as written. Reading the
  source overturned it: two of the README's three defects survive that change
  untouched, and one imports a binding that exists nowhere in the tree.

Both are recorded because **an unread source produces confident, well-formed,
wrong architecture**, and because a record whose author only ever documents
conclusions is less usable than one that shows where the method caught him.

## What was deliberately rejected

Recorded so nobody re-derives them as obvious simplifications.

**Merging the Axis-1 family into one issue.** They share a principle and nothing
else — four files, four remedies. Q1.

**Splitting Axis 2 into its own ADR.** A record titled *"do not overstate
coverage"* reads as a documentation-style rule, loses its connection to the
mechanical family, and would be applied by nobody. Q1 *is* the two-axis
distinction generalised from writing a guard to filing a report about one; the
principle and its worked examples belong in one document.

**Carrying the 2026-09-04 backlog grouping into this record.** It was already
stale when written: #566's own title says *"the 14 un-routed issues"* and the
set was six of different composition by the time it was analysed. **The rule
does not decay; the list does**, and a stale list inside an ADR is an Axis-2
defect in the document that defines Axis 2.

**A guard enforcing the remedy test.** It would have to know which issues *ought*
to be one, which is the judgement the test exists to inform. Q4's sequencing
constraint is likewise a dispatch-time concern, not a CI one.

## Consequences

**Good.** Grouping the backlog by change surface becomes safe to ask for. The
output is a dispatch order, and Q4 stops it being read as a merge list.

**Good.** "These are all the same kind of thing" now has somewhere to go that is
not the issue tracker. The recurring pull toward consolidation was really a
missing ADR.

**Bad, and accepted.** The remedy test needs the remedy to be known, and at
filing time it often is not. #576 and #581 could only be ruled one defect after
someone read two scripts. **The honest default when the remedy is unknown is two
issues** — over-splitting produces a duplicate that is cheap to retire, while
over-merging loses a requirement silently. Applied to #576, that means the
surviving issue must first absorb the other's full-tree acceptance criterion;
retiring a duplicate without transplanting what it uniquely carried is how the
requirement disappears.

**Bad, and accepted.** Q2 requires knowing whether a change can land alone,
which sometimes means reading a lockfile before filing. The `qs` case was only
settled by finding `~6.15.1`. Filing is now occasionally more expensive than it
was.

**Bad, and NOT mitigated.** Nothing detects a violation of either axis. These
are review criteria applied by whoever reads the diff, and the Axis-1 family is
five instances of what happens when careful reviewers apply them
inconsistently. The time dimension is worse still: a claim that was true when
written has no diff at the moment it becomes false, so **there is no review
event at which anyone would catch it.** `check-platform-claims.mjs` closes this
for *declared* platform claims and cannot make anyone declare one; every other
claim in the tree decays unwatched. Recording that as unmitigated is the point —
an unmitigated risk that is written down can be scheduled.

## Provenance

Written at the time, from a single Architect session on 2026-09-04 covering
#595, #598, #593, #585 and #566. Every structural claim was read from source
before being recorded here: the self-reference mechanism from
`packages/adapters-fastify/src/__tests__/readme-imports.test.ts`, the `qs` cap
from `package-lock.json`, the ladder and its audit invocation from
`.github/scripts/check-test-execution.test.mjs` and
`check-mutation-audit.mjs`, and the two compatibility notes from
`docs/compatibility.md`.

The two recorded errors are the author's own and were caught by reading source
that the earlier claim had skipped. Neither was reported by review.

The framing that separates *"in what order?"* from *"how many?"* came from PM's
observation that #566 was asking for a grouping and a rule as though they
answered the same question.

**Two corrections came from QA review of this document before it merged**, and
both are recorded above where they apply rather than only here. The
*"every clause is false"* overstatement about the Fastify note was QA's finding;
`fromFastify` was confirmed absent repo-wide, and the source issue had rebutted
two clauses while this record asserted three. Q2's time-indexing was also QA's,
from checking the registry rather than the lockfile: `express@5.2.1` declares
`qs: ^6.14.0`. Both were re-verified here against the registry and the tree
before being written down.

The footer below reads *Operum Engineer* on every record in this directory,
including those written by other roles. **It is a directory-wide convention
rather than an authorship claim** — noted because this document argues for
stating things exactly, and a reader who notices the mismatch should not have to
wonder whether it is one.

## Retirement trigger

Revisit if issue granularity ever stops being a human judgement — if dispatch
becomes automated enough that a wrongly-merged issue is detected mechanically
rather than by someone noticing the board has stalled. Until then the remedy
test is applied by whoever files, and this record is what they apply.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
