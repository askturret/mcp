<!-- SPDX-License-Identifier: Apache-2.0 -->
# Testing

How this repository decides whether a test is worth having.

## The one rule

**A test must go RED when the fix it guards is reverted.**

**The same rule addressed to prose: a sentence asserting that something is
protected must name the assertion that goes RED when the protection is removed —
or state that none does.** The first sentence is said to test authors constantly;
the second is said to comment authors never, which is how a protection that
nothing observes gets written down and then believed. That is
[antipattern 6](#6-unobserved-guarantee), and it is the same rule, not a second
one.

That is the whole standard, and everything below is a way of failing it. Before
opening a PR that fixes a bug: comment out the fix, run the test, watch it fail,
restore the fix, watch it pass. If you cannot produce a deterministic
RED-on-revert, **say so in the PR and explain why** — an unverifiable test is
allowed, a silently unverified one is not. "I could not" and "I did not mention
it" must not be indistinguishable.

The reason this is a rule rather than a preference is that a test which cannot
fail is **indistinguishable in CI from one that works**. Both print a green tick.
Every antipattern below is a different way of arriving at that tick without
earning it.

## What the automated guards already cover

Two guards run in the `test-integrity` job on every PR:

| Guard | Question it answers |
|---|---|
| `check-test-execution.mjs` | Does this package's suite actually execute? |
| `check-placeholder-tests.mjs` | Did anything get asserted? (no `expect(`, `expect(true).toBe(true)`, stray `.only`) |

They are worth having and they are not enough. Every antipattern below **passes
both**. A test can execute, assert something specific and real, and still guard
nothing. Antipattern 6 is not even that: in four of its six recorded instances
there is **no test file for either guard to inspect** — the claim is a sentence.

---

## The six antipatterns

### 1. Transcribed Oracle

**Shape:** the test re-implements the logic it is checking, then asserts the
re-implementation against itself.

**Instance (#65, PR #199).** Two tests certifying architectural-readiness
criteria imported *no production function at all* — only types. One defined its
own `shouldNeverRetry` helper inside the test file and asserted against that. The
other "proved" that policy denies identically at discovery and invocation by
calling one test-local policy twice and checking it was deterministic; another
case asserted `expect(policy1.id).toBe(policy2.id)` where both names referred to
the same object.

Both passed with the retry policy and *both* policy engines deleted. They were
certifying two release criteria on no evidence.

**Why the guards miss it:** the assertions are real, specific and numerous.

**How to catch it:** ask *which production symbol does this test import?* If the
answer is "only types", the test cannot be measuring production behaviour. The
fix is not more assertions — it is to drive the real entry point.

### 2. Decorative Guard

**Shape:** a check that cannot fail by construction, usually because its input
set is empty or its scan window excludes the thing it scans for.

**Instance (#63).** The dashboard-metric guard walks a directory of dashboards
and verifies every metric they query is one the runtime emits. Run against an
**empty** directory it found no violations and reported success — "all clean" and
"there is nothing here" rendered identically. Caught before shipping, and the fix
is now an explicit assertion: the guard *refuses to run* against an empty metric
set, and its self-test fails if the shipped dashboards reference nothing.

**Why the guards miss it:** the guard is not a test file, and even as one it
asserts plenty.

**How to catch it:** for every check you write, ask *what input would make this
pass vacuously?* Then assert that input is impossible. Any guard with a scan
window needs a case proving the window is non-empty.

**Its sibling one level up:** the same question applies to the *mutation* that
verifies a test, not only to the test's own input — see
[Mutation-application traps](#mutation-application-traps), variant 5.

### 3. Frozen Snapshot

**Shape:** the test pins current behaviour rather than correct behaviour, so it
locks in whatever the code did on the day it was written — bug included. The
first failure after a genuine fix is the *test*, and the path of least
resistance is to update the snapshot.

**Illustrative rather than historical:** no instance is recorded in this repo,
and as of writing there are no `toMatchSnapshot` / `toMatchInlineSnapshot`
assertions and no `.snap` files anywhere in `packages/` — so treat this one as a
shape to recognise rather than a war story. It arrives with the first committed
`.snap`, golden file, or assertion whose expected value was obtained by running
the code and pasting the output.

**Why the guards miss it:** the assertion is maximally specific.

**How to catch it:** ask *where did this expected value come from?* If the answer
is "I ran it and pasted the result", the test encodes behaviour, not intent. That
is legitimate only when the output is separately known to be correct — and worth
a comment saying so. Note the difference from a *verified* transcript: pasting
real output is fine when a test independently re-derives it and fails on drift
(see `doctor-readme.test.ts`), and dangerous when nothing re-derives it.

### 4. Unreachable Scenario

> **Correct assertion, unreachable trigger condition.**

**Shape:** the test is well-formed and non-tautological — it makes a real,
specific assertion about real production code — but its **fixture never
constructs the scenario the assertion is about**. The assertion is fine. It is
simply never presented with the case that would break.

**Instance (#26, PR #115).** A regression test for a parsing bug — a greedy regex
mis-attributing an import across an earlier `export` line — used a fixture
containing no `from '...'` import clause at all. Both the buggy greedy regex and
the fixed bounded one matched nothing, returning 0 violations *identically*. The
test asserted something real about violation counts; it just never got a
violation to count. Reverting the fix left the suite fully green.

It was caught only because QA independently reverted the fix and reran the
suite — a revert-check, not static analysis.

**Variant: the harness never reaches the artifact (#110, PR #205).** The same
shape can come from the test harness rather than the fixture. A CI coverage
script was covered by 35 assertions against its exported `evaluate` function —
all correct, all passing — while the script's *entry point* never ran, because it
guarded itself with:

```js
if (import.meta.url === `file://${process.argv[1]}`)   // never matches a path with a space
```

`import.meta.url` percent-encodes; `process.argv[1]` does not. On a checkout path
containing a space the module loaded, the entry block was skipped, and the
process **exited 0 having evaluated nothing**. For a script that decides whether a
diff was tested, that is the worst available failure, and no amount of testing
`evaluate` would have found it. The fix was to invoke the real file as a
subprocess in the self-test and assert it is *never silent* — note that
`exit code === 0` still passed under the bug, which is exactly why the extra
assertion was needed.

**Why the guards miss it:** the test asserts, executes, and is not tautological.
Nothing currently verifies that a fixture *constructs the scenario the assertion
is named for*.

**How to catch it:** revert the fix and rerun. If the suite stays green, the
fixture never reached the code. As a habit: after writing a regression test,
confirm the fixture actually produces the symptom — count the violations, print
the intermediate value, assert it is non-zero before asserting what it equals.

### 5. Untested Branch Consensus

> **The fixture set covers real code paths, but never varies the one axis that
> would reach the bug — so every test's agreement is coincidental rather than
> protective.**

**Shape:** unlike an Unreachable Scenario, which is usually one test with one bad
fixture, this is a whole *suite* agreeing with the implementation because none of
its cases differ along the dimension that matters. The tests are individually
sound. Collectively they are a consensus that proves nothing about the untested
branch.

**Instance (#35, PR #122).** `inputHash`'s fallback branch for unfingerprintable
inputs was untested because every binding test used ordinary JSON. The branch
existed, was reachable in production, and no fixture ever went near it.

**Instance (#34).** Cache-key tests all varied `principal` — the one field that
never varies on that path — and never varied `clientInfo`, which is what actually
differed between callers. Every test passed; the cross-client cache-poisoning bug
sat in the axis none of them moved.

**Instance (#110, PR #205) — masked by a second guard.** A coverage script had an
explicit "the `changes` job failed" guard. Disabling it turned only *one*
assertion red, because a second, independent rule refused the same input for a
different reason. The fixture set never varied the axis that separated the two
rules, so the suite could not tell which one was doing the work. The remedy was a
case constructed so that only the guard under test could satisfy it.

**Why the guards miss it:** every individual test is well-formed, and coverage
tooling may even report the branch as covered — by a *different* test, for a
different reason.

**How to catch it:** for each test group, name the axis it varies, then ask *what
axis does the bug live on?* If a mutation to production code turns fewer
assertions red than you expected — or turns red for the wrong reason — you have
found a consensus, not a guard. Two rules that both refuse an input are defence
in depth and worth keeping; they just need one case each that isolates them.

### 6. Unobserved Guarantee

> **A protection is stated where a reader trusts it, and nothing in the build
> fails when the protection is removed.**

**Shape:** a protection is asserted in an artifact a reader trusts — a code
comment, a docstring, an ADR, an assertion's own label, a PR body — and no test,
guard or check goes red if the protection is taken away. The system is correct
today. Nothing observes it ceasing to be.

**This one is not like the five above, and the difference is the point.** Those
are ways a test *that exists* fails to earn its green tick. Here, in four of the
six instances below, **there is no test at all** — there is a sentence. This
document opens by saying it is about *"whether a test is worth having"*, and a
sentence is outside that:

> `TESTING.md` governs artifacts that claim to **test**. This antipattern governs
> artifacts that claim to be **protected**.

It belongs here anyway, because the rule it needs is already written in
[The one rule](#the-one-rule) and was simply addressed to the wrong party.
*"A test must go RED when the fix it guards is reverted"* is exactly the missing
rule; until this section, nobody said it to the author of a comment.

**Operational test.** Name the mutation that would falsify the claim. Apply it.
Run the suite. **Green ⇒ instance — provided the mutation landed at the intended
site.**

**That proviso is load-bearing, not a hedge.** Green also means *the mutation
never reached the code*, which is
[variant 2](#variants-1-and-2-are-duals-and-that-pairing-is-the-point) of the
[Mutation-application traps](#mutation-application-traps) below. Without the
check, a reader following this test literally, whose mutation silently misses,
**records a false instance of this very antipattern** — a section about
protections nothing observes, manufacturing reports of protections nothing
observes. So: assert the mutation landed **at the intended site**, not merely
that the file changed.

**And this section is unusually good at creating that trap, which is the part
worth internalising.** A string-replace hits the FIRST textual match, and a
well-written explanatory comment about a regex — sitting directly above its own
declaration, quoting it — is that first match. **Documenting a thing well makes
its mutation more likely to hit prose, not less.** Two of the near-misses on
record arrived exactly that way, one of them a step from being filed as a
finding here.

That is determinate *given a candidate claim*. **Enumerating the claims is the
undecidable part** — and that is the tractability answer itself, not a caveat on
it. Nothing in the build reads prose, so nothing can hand you the list of
sentences to test.

#### Two variants — a definition covering only the first misses the worse one

- **Variant A — the absent witness.** The falsifying mutation is green **now**.
  Nothing was ever written to observe the property. Instances 1, 2, 3, 5, 6.
- **Variant B — the delayed fuse.** The falsifying mutation is **red now**, and
  the artifact carries an invitation to make it green — a correct, load-bearing
  assertion labelled *"belt to the braces"*. The claim that is false is not
  *"this is protected"* but *"this is redundant"*. Instance 4.

Variant B is the more dangerous of the two and **the only one no automated
technique can reach, because the defect is in the future**: today the assertion
is real and the mutation reddens it. The remedies differ accordingly — variant A
needs a witness added, variant B needs a label corrected.

#### The six instances

Cited so the definition can be checked against them rather than asserted. All
six are from a single session (2026-08-26, ~04:00–08:00Z), in unrelated
subsystems, found by three different agents — and **every one was found by a
human noticing, never by a check**.

| # | Claim, and where it was stated | Falsifying mutation | Build after | Variant |
|---|---|---|---|---|
| 1 | **#383** — the audit exemption is root-anchored (a data flag, described by the comment above it) | `anchored: true` → `false` | **862/862 green**, while materially widening what stays unredacted | A |
| 2 | **#388** — the invariant `factor_1: unverifiable ⇒ anomalous` is *"enforced by a schema checker"* | *none available* — **the named checker does not exist in this repository** | green | A |
| 3 | **#381** — guard scripts under `.github/scripts/` run in CI | remove the workflow step that invokes one | green — **and the guard's own self-test still passes**, which reads as confirmation | A |
| 4 | **#393** — a third assertion labelled *"belt to the braces"* | delete it | **RED** | **B** |
| 5 | **#383** — `SNAPSHOT_HASH` *"IS the truncation-length guard"* | change the truncation length | green **at every length**, because the only length-sensitive rule is excluded from the default rule set | A |
| 6 | **#389** — the generated position list that replaced instance 1's flag | drop one of the three positions | **863/863 and 87/87 green**, real hashes silently masked | A |

Two more from the same session are arguably this class one level out: **#387**, a
classifier whose inconsistent application concealed a large false-positive rate —
consistency would have made it visible; and **#392**, a finding recorded where
nobody searching for it would look.

**A seventh, recorded after this section was written, because it is not in code
at all.** Deliberately kept outside the six above so the measurements in this
document continue to refer to the same corpus.

PR #389 co-linked two issues with closing keywords, which deadlocks the merge
gate — one PR can record exactly one QA approval row, so the second stamp is
refused as a duplicate by construction. The handoff instructing the fix said to
replace the second keyword with *"a bare reference such as **Also fixes #395**"*,
and asserted the protection outright: **"a bare reference is deliberately not
close-intent"**. `fixes` is a GitHub closing keyword. The claim was true of the
concept and false of the example supplied with it, and **nothing observed which**
— so the fix re-created the defect it was fixing, and the merge gate was the only
thing that caught it.

It is variant A, in a **handoff** rather than in a comment, which is why it is
worth keeping: the artifact a reader trusts need not be in the repository. It
also demonstrates the corollary below twice over, because the correction went
wrong the same way twice more — the replacement wording was verified against the
real keyword list only after the second refusal, and a history note describing
the mistake **quoted the offending phrase in full**, re-arming it a third time.
Markdown emphasis does not stop GitHub parsing a reference.

**Where that matters, precisely — because the broad version of the rule would
suppress write-ups like this one.** GitHub links a pull request to an issue from
a **PR description** or a **commit message**, and from nowhere else. Its own
documentation is explicit: *"You can link a pull request to an issue by using a
supported keyword in the pull request's description or in a commit message."* On
those two surfaces, quoting a closing keyword is applying one and the quoting
marks buy nothing.

Three surfaces where it is **not** a closing link, and the second is worth
knowing rather than merely excluding:

| surface | what a keyword does there |
|---|---|
| PR description, commit message | **closes the issue on merge** |
| issue or PR **comment** | creates a **reference**, not a closing link — a cross-reference and a timeline event, so not wholly inert, but nothing closes |
| repository **file content** | nothing at all |

That last row is why the paragraph above can quote `Also fixes #395` in full, in
this `.md` file, safely — and why you should not hesitate to write such an
incident down.

So the rule is: *on a linking surface, a quoted keyword is a live one.* Stated
any wider it would cost in the wrong direction, making people reluctant to
document the very mistakes this section exists to collect — and a version that
included comments would discourage quoting keywords in **code review**, which is
exactly where these incidents get discussed.

**Settled by reading the vendor's documentation, not by experiment**, and
deliberately so: the only direct test is posting a live closing keyword and
watching an issue close, which is a real mutation with side effects on a shared
repository for the sake of a documentation check. *"What does this third-party
API do"* is a question for the vendor's docs.

The remedy is the operational test applied to prose, and it costs seconds: name
the mutation that falsifies *"this wording is not close-intent"* — the wording
itself — and check it against the actual keyword list rather than against the
intent behind it.

**Why the guards miss it:** `check-test-execution.mjs` and
`check-placeholder-tests.mjs` both pass, and in four of the six there is no test
file for them to inspect. Mutation testing — the systematic form of the
RED-on-revert check — reaches **three of the six**; see
[Is this systematically catchable?](#is-this-systematically-catchable) for the
measurement and why it cannot do better.

#### Why it is expensive

**It is invisible in the safe direction, and the point is sharper than "both are
green".** Green is the *correct* observation in both cases, so there is no
anomaly to investigate at any moment. Contrast a flaky test, which also passes
sometimes but **self-signals**; here there is no signal ever.

One refinement matters for design, because it is what makes some instances cost
more than others:

> The failure is **always** silent in the build. Whether it is silent **in the
> world** varies — and **the doubly-silent ones are the expensive ones.**

Instance 6 is loud in the world: real hashes start reading `[REDACTED]` and a
panel visibly fills with them. Instance 1 is silent in both — an exemption widens
and nothing anywhere looks different.

**The statement suppresses investigation** — a reader who meets *"this is guarded
by X"* stops looking, and an admitted gap gets watched where one believed closed
does not. But not uniformly, and the exception is the useful part: a claim that
is **checkable at a glance** invites a two-second verification instead of
suppressing it. *"Guarded by `check-audit-append-only.mjs`"* is confirmable
immediately. Suppression is strong for **unfalsifiable-looking** claims and weak
for **citable** ones — which is why requiring the citation below is not
bookkeeping. **It is what removes the suppression.**

#### Fail-closed design is the lever that is not a test

Fail-closed design **bounds this class even while the guarantee stays
unobserved.** It does not make the claim observed; it makes the *consequence* of
losing it observable somewhere. #383 is the worked example: anchoring
over-redacts **loudly**, suffix matching under-redacts **silently**, so for a
redaction control fail-closed means redact. Instance 6 became a loud-in-the-world
failure for the same reason.

This is worth recording as a mitigation in its own right, because it is the only
one that works **without anyone having to notice the claim** — every other
remedy here starts with someone reading the sentence.

#### How to catch it — the authorship rule

The review question is not new. This repository already writes it into acceptance
criteria — *"observed failing, not merely passing on a clean tree"* — and it
works: it found five of the six. **What is missing is a trigger.** So the rule
attaches the existing question to a determinate event:

> **When a diff adds or edits a sentence asserting that something is protected,
> the same diff must either (a) name the assertion that goes RED if the
> protection is removed, or (b) state that none does.**

**Where it fires:** at *authorship of the claim* — while the author is writing
the sentence and still has the mechanism in their head. It re-fires at review,
cheaply.

**What makes it fire rather than be forgotten**, three properties, and the third
is the load-bearing one:

1. **It triggers on an act the author is already performing deliberately.**
   Writing *"this is guarded by X"* is not incidental; it is a claim being made.
2. **Option (b) makes honesty cheaper than silence.** That disposition is already
   in this document, verbatim, for tests: *"an unverifiable test is allowed, a
   silently unverified one is not. 'I could not' and 'I did not mention it' must
   not be indistinguishable."* Extending that sentence to claims is the whole
   change.
3. **A reviewer needs no domain knowledge to ask it.** *"This says X is guarded —
   which test?"* costs nothing and requires understanding neither the subsystem
   nor the test framework. Compare *"is this protection real?"*, which requires
   expertise and therefore gets skipped. **Review questions survive in proportion
   to how little they cost the reviewer**, and this one converts a semantic
   question into a lookup — without pretending the lookup can find *unmarked*
   claims.

#### The corollary — a fix for this class relocates the guarantee

> **Name every input to the new mechanism, and for each, name the assertion that
> reddens if it changes.**

This is not a refinement; it is the observed failure mode of fixing this class.
**Instance 1's fix produced instance 6 within hours.** PR #389 replaced an
unobserved flag with a generated list, and nothing observed the list's *inputs* —
three positions and a flag, of which only the flag was witnessed. The same
defect, one field over, introduced by its own remedy.

That is also the argument for naming the class at all rather than fixing six
instances: the individual fixes do not generalise, and one of them manufactured a
seventh problem while closing a first.

#### What is deliberately not built

A marker convention (`@guarded-by <test>`) plus a linter checking the cited
assertion exists would be sound for what it checks — **and it would have found
zero of the six**, because every instance is an *unmarked* claim. Its coverage of
the class on the historical record is nil; its only value is preventing decay of
citations that already exist.

Shipping that under a name like *"unobserved-guarantee check"* would supply
reassurance without coverage. **That is this antipattern.** Refusing to build it
is an application of the finding, not a failure to deliver one — the same
refusal, for the same reason, as
[variant 5's](#is-this-mechanisable) syntactic sub-shape below.

---

## Mutation-application traps

**A mutation result that looks like evidence and is not.**

The five antipatterns above are defects in *tests*. These are defects in the
*procedure* that verifies a test — the manual RED-on-revert this document
recommends as its primary control. They are worth naming separately because
that control is what catches the antipatterns, so a silent failure here removes
the thing everything else leans on.

Mutation testing earns its keep because a failure count tells you an assertion
is load-bearing. Every variant below produces a **plausible count** from a
mutation that did not test what you thought.

> ### When a mutation figure surprises you, check the MUTATION before you check the code.
>
> Every instance below was found this way, and several were found by the person
> who had just fallen into them. A surprising count is far more often a broken
> mutation than a surprising codebase.

### The five variants

Easier to recognise than to define, so this table is symptom-first — someone
hunting a confusing result will match on what they are seeing, not on a name.

| # | Symptom | What it reads as | What actually happened | Instrument |
|---|---|---|---|---|
| 1 | mutation fails **everything** | broad, thorough coverage | the edit **broke the file**; nothing ran | compile-check after every edit (`node --check`, `tsc -b`) |
| 2 | mutation fails **nothing** | a coverage gap | the edit **never reached the code**; it landed elsewhere | assert the mutation landed **at the intended site**, not merely that the file changed |
| 3 | **more** assertions fail than expected | poor isolation between changes | the mutation changed **two things** — usually harness residue | read **which** assertions failed, by name |
| 4 | correct exit code, case looks pinned | the branch is asserted | the fixture left via an **already-asserted** path | assert the **message**, not just the status |
| 5 | assertion passes under the mutation | the property holds | the assertion is satisfied by the named thing being **absent** | construct the case that *should* make it fail and confirm it goes red |

### Variants 1 and 2 are duals, and that pairing is the point

One fails everything; the other fails nothing. **Neither ran the code you meant
to test.** A reader who knows only variant 1 will not recognise variant 2 when
it arrives, because it presents as the opposite symptom — and the opposite
symptom is the one that reads as an honest finding rather than an error.

Variant 2's specific fix is worth stating exactly, because the obvious guard
does not catch it: checking that the file *changed* is not enough. A
string-replace hits the **first** textual match, and a regex or identifier
quoted in a doc comment above its own declaration is that first match. The
mutation then edits **prose**, the file genuinely differs, a no-op guard passes
it, and the suite stays green — which reads as a missing assertion. Target the
**declaration**, and assert the mutated region is the one you meant.

### Recorded instances

Cited so the claims here can be checked rather than taken on trust.

| Variant | Instance |
|---|---|
| 1 | An instrumentation shim inserted **before the shebang** broke the file; three cannot-check paths reported as asserted were a syntax artefact (#354 review) |
| 2 | `String.replace` hit a regex quoted in a doc comment above its own declaration; two mutations edited prose and reported a clean pass (#266) |
| 3 | A mutation conflated two changes and produced 18 collateral failures, which read as breadth rather than as a broken mutation (#348); and fault-injection scaffolding left in place during a second mutation reddened an unrelated assertion, so two failures looked like isolation and were not (#371, PR #373 review) |
| 4 | A broken link masked a broken anchor: the exit code was `1` in **both** the masked and unmasked cases, so a status-only assertion could not see the bug at all (#337 item 2, PR #355) |
| 5 | `indexOf(a) < indexOf(b)` ordering assertions passed **vacuously** when the guard was deleted, because `indexOf` returns `-1` and `-1` precedes any real position (#371); and a 17-character hex asserted to *survive* redaction, which passed under a widening mutation because no rule fires on it at all (#266) |

### Three habits that pay for themselves

**Read which assertions failed, by name — not how many.** This is the
highest-value habit of the set: it is the only instrument that catches both
variant 3 and variant 4, and it costs nothing beyond reading the output you
already have.

**Pair a negative conjunct with a positive one.** A bare negative — *"the
offender list is empty"*, *"this value is not masked"* — is vacuously true on an
empty input. Pairing it with an assertion that the input was non-empty is what
separates "checked and found nothing" from "did not check". This is the same
question the Decorative Guard antipattern asks of a scan window, one level up:
there it is the guard's input, here it is the mutation's.

**Construct the failing case, rather than reaching for one recipe.** Variant 5's
instrument is deliberately general, because the shapes it has to reach have
nothing in common at the level of syntax:

| instance | what makes it vacuous | how you would reach it |
|---|---|---|
| `indexOf(a) < indexOf(b)` on a deleted guard | `-1` precedes any real position | run the predicate against an **empty** source |
| a 17-char hex asserted to *survive* redaction | no rule fires on it either way | supply a value a rule **would** redact |
| a 16-char uppercase hex, either direction | nothing can redact it at that length | **no case exists** — record a non-assertion |

Emptying the source is one specialisation, and it only fits scanners: a
redaction assertion has no source to empty. The general question is *"what
input would make this assertion fail?"* — and if the honest answer is **none**,
that is variant 5 confirmed rather than avoided, and the next section is what to
do about it.

### Sometimes the honest answer is a non-assertion

Not every property can be pinned. If a value cannot be affected by the code
under test *in either direction*, an assertion about it passes regardless and is
decorative — it is variant 5 wearing the clothes of thoroughness.

A worked example (#266): a 16-character **uppercase** hex is outside an
exemption's lowercase-only pattern, but no redaction rule can fire on it at that
length. "It is still redacted" and "it survives" both pass whether or not the
exemption covers it. The property is real and unobservable, so it was **recorded
as a deliberate non-assertion** in the test file rather than pinned by a test
that could not fail. Writing down why a case is absent is worth more than a
green tick that means nothing.

### Is *this* mechanisable?

The question is [#378](https://github.com/askturret/mcp/issues/378)'s, from the
acceptance list that produced this whole section — *"Consider whether the
empty-source check is mechanisable as a guard rather than a habit."* **This
subsection is the answer, and the issue does not carry it.** Named here because
the decision was cited from elsewhere as living in #378, where a reader
following the number finds the question rather than the answer.

Partially, and the honest split matters more than the total.

**Variants 1 and 2 are mechanisable inside the harness**, and cheaply: a
compile-check after each edit, and an assertion that the mutation landed at the
intended site. Both are properties of the harness's own actions, so it can check
them directly. Any mutation harness should do both.

**Variants 3 and 4 are not mechanisable** — they need a human to read which
assertions failed and decide whether that set is the expected one. There is no
signature distinguishing "these two failures are the isolation working" from
"these two failures include one I caused by accident".

**Variant 5 is the interesting refusal.** One sub-shape is trivially
detectable — an `indexOf(…) < indexOf(…)` comparison with no `!== -1` guard is a
syntactic pattern a guard could find, needs no new workflow step, and would fit
inside the already-wired `check-guards.test.mjs`. **It is deliberately not
proposed here**, because "satisfied by absence" is a *semantic* property with
many shapes, and a guard covering one syntactic sub-shape would read as covering
the class. That is variant 5's own failure mode applied to the guard meant to
catch it — a check that passes because the thing it looks for is absent from its
window. If it is wanted, it should be filed as its own issue and scoped
explicitly as "this one shape", not as coverage of the class.

The three instances in the table above are the evidence, and they are worth
counting: only the FIRST is an `indexOf` comparison. The second is an assertion
on a redacted value, the third has no failing case at all. A syntactic guard
would have caught one of three and reported clean on the other two — which is
worse than no guard, because it would also supply the reassurance.

**These are traps in verifying a fix, not defects in the fixes.** Every instance
above was caught **before it was acted on** — several by the person who had just
fallen into it — and the fix each was verifying turned out to be correct. The
cost was wasted cycles and, more importantly, the near-miss of recording a wrong
reason for a right answer.

That claim is deliberately narrow so it can be checked: each row cites the issue
it came from, and "caught before it was acted on" is falsifiable against those.
It is **not** a claim that this list is complete, or that the instruments here
are sufficient — only that these five have been seen and are worth recognising.

---

## Waiting for CI

**An empty pending list is not a completion signal.**

The section above is about defects in the procedure that verifies a *test*.
This one is the same shape at the next level out: a defect in the procedure that
verifies a *pull request*. It is here rather than in an agent's instructions
because anyone writing or reviewing a CI wait will be reading this document
already, and because the rule it states is this document's one rule wearing
different clothes.

### The trap

**Check creation is asynchronous.** A workflow's checks appear on a head over
time, not all at once. So there is a window in which:

- every check *present in the list* has completed;
- the pending count is **zero**;
- a check that will exist shortly **has not been created**, and is therefore not
  visible as missing.

A waiter keyed on *"nothing pending"* fires in that window and reports a
definitive green. Nothing in the list is wrong. The list is **short**.

| state | in the list | looks like |
|---|---|---|
| `queued` / `in_progress` | yes | correctly not-done |
| `completed` | yes | done |
| **not yet created** | **no** | **done** |

The third row is the whole defect: absence and completion are the same
observation to a counter.

### The rule, stated positively

> **Wait for NAMED checks to reach a terminal state.** A check is terminal when
> it is `completed` and carries a conclusion. Absent is not terminal. Absent is
> not anything.

An empty pending list is evidence that every check **currently known** has run.
Check creation is asynchronous, so *currently known* is not *required*.

### The instance — caught, not suffered (#399)

While waiting on CI for **PR #389**, QA observed that **`coverage-status` did
not exist in the check list at all** while the package suites ran. There was a
real window where every check present was complete, the pending count was zero,
and `coverage-status` had never been created. **A stamp applied in that window
would have covered a head whose coverage check did not exist.**

Nothing was mis-stamped. They armed a waiter on `coverage-status` specifically,
saw it appear queued, then pass, re-verified the head had not moved, and only
then stamped. The fix generalises, which is why it is written down rather than
left in that thread.

### The aggravating factor, and it is structural (#330)

The required set **is readable, and it is empty**. Check it rather than assume
it — one call settles it, and the answer has changed at least once:

| what to run | what it returns today |
|---|---|
| `gh_pr_checks` on any open PR | `required_known: true`, `required_checks: []` |
| `GET /repos/askturret/mcp/rulesets` | `200`, two rulesets, both `enforcement: active` |
| `GET /repos/askturret/mcp/branches/main/protection` | `404 Branch not protected` — rules live in rulesets, not legacy protection |

So the consequence is **not** that the list cannot be read. It is that the list
is **empty**: no check is required to merge, and a green board is a fact about
what ran rather than about what had to.

That leaves the waiter's own list as the practical source of truth for *what
should have run* — the same conclusion as before, reached for a different
reason, and still colliding with the same second failure: a set that grows
during the run.

> **This paragraph replaced a premise that had gone false, and the replacement
> is the point (#549).** It used to say branch protection and rulesets *"both
> return 403 on a free-plan private repo"*, so `required_known` was `false` and
> nothing could be enumerated. Every clause of that is now wrong — and the
> reason it matters more here than in the other stale-premise sites fixed under
> #330 is that **this file tells a reviewer what to do**. It told the next QA
> agent not to bother checking something they can check in one call.
>
> Note the response itself moved during a single day: the legacy protection
> endpoint returned `403` while the repository was private on the free plan, and
> `404` once it was public. A status word would have been wrong twice. The rows
> above are conditions with the call that settles each, so the next reader can
> re-check rather than believe.

### How to name the checks when nothing will name them for you

Derive the expected names from `.github/workflows/` rather than from the live
list. The workflow files are the only in-repo statement of what *should* run,
and unlike the live list they do not grow while you watch them.

**This narrows the gap; it does not close it,** and the difference matters. A
derived name is a *better* source than the live list and still **not** an
authoritative required set — for four reasons, and the fourth is a different
kind of item from the first three:

| mechanism | what it does to a derived list |
|---|---|
| conditional jobs | the name is **unknowable from the file** |
| matrix expansion | ″ |
| reusable workflows | ″ |
| **`needs:` ordering** | the name is perfectly derivable; the **check is temporally absent** until its dependencies resolve |

The first three stop you *predicting the name*. `needs:` leaves you with a name
you got right for a check that **does not exist yet** — and it is that timing
half, not the naming half, that produced the instance below. Filing it
unlabelled among the others blurs what the list is saying.

Treat a check you expected and never saw as *"I could not check"* — which is
never *"it passed"* — rather than as a name you got wrong.

**One observation, recorded rather than used to soften the caveat.** Of the
three naming mechanisms, this repository has **no** matrix jobs and **no**
reusable workflows, and its conditional jobs still materialise as `skipped`
rather than absent. So on *this* repo today a workflow-derived list **would**
have caught the observed instance. That is a claim about one case; the caveat
above is a claim about what the practice can *guarantee*. Both are true and they
do not collide — the label under-claims, which is the safe direction.

Before stamping, re-verify the head has not moved. A terminal check on a
superseded head is a fact about a different commit.

### No mechanical guard is proposed, and that is a finding

A guard verifying that a waiter waited for the right set would need to know the
required set. It can now read it — and reading it returns **nothing**, because
no check is required (see the table above). An empty authoritative list cannot
validate a waiter's coverage any better than an unreadable one could. A guard
built anyway would check the waiter against an incomplete list, agree with it,
and report clean.

**The reason is that NO IN-REPO LIST IS AUTHORITATIVE — not that the guard would
happen to reuse the waiter's one.** The distinction decides the obvious
counter-proposal. Derive the guard's set from `.github/workflows/` and it is a
*different* list, so "it would use the same list" reads as a fixable
coincidence and points straight at the fix. It is not one: a workflow-derived
guard is a **better** incomplete list checked against a **better** incomplete
list. Same class, higher-quality inputs, same clean report. The section above
says why no derivation closes the gap — this refusal is that fact applied to a
guard rather than to a waiter.

That is [Unobserved Guarantee](#6-unobserved-guarantee) — reassurance without
coverage — so building one here would be an instance of the class rather than a
control on it. The same refusal, for the same reason, as the syntactic
sub-shape declined in [Is *this* mechanisable?](#is-this-mechanisable).

### Why this belongs beside the antipatterns

The trap is an **Unobserved Guarantee, variant A**, arriving through a channel
none of this document's other machinery watches. *"CI is green at this head"* is
a protection asserted by the wait; nothing observes whether the set of checks it
waited on was complete. The absent witness is **the check that was never
created**.

Every mechanism in this repository built to catch *"I could not check"* wearing
the costume of *"it passed"* inspects **assertions**. None of them inspects the
**waiter**.

---

## Is this systematically catchable?

Issue #116 asks whether Unreachable Scenario can be caught by a guard — for
example one requiring each test file to have at least one revert-checked
assertion — or whether it stays in the class only human/QA revert-checking finds.

**Short answer: partially, and not by a guard of that kind.**

**The proposed guard cannot be built as stated.** "Revert-checked" is a property
of a *procedure*, not of source text. A static check can see that a file contains
assertions — which is exactly what `check-placeholder-tests.mjs` already does,
and exactly what the #115 test passed while guarding nothing. There is no textual
signature that distinguishes a fixture which reaches the scenario from one that
does not; determining that in general is equivalent to deciding whether two
program versions differ on a given input.

**The systematic form already has a name: mutation testing.** Tools such as
Stryker automate precisely the manual revert-check — mutate a line of production
code, rerun the suite, and report the mutant as *survived* if nothing went red. A
surviving mutant is, by definition, "no test reaches this". That catches both new
antipatterns by construction:

- **Unreachable Scenario** — mutate the fixed line; the suite stays green; the
  mutant survives.
- **Untested Branch Consensus** — the un-varied axis leaves survivors clustered
  on one branch, which is a sharper signal than coverage, since coverage would
  report that branch as executed.

**It does not catch [Unobserved Guarantee](#6-unobserved-guarantee) the same way,
and the reason is structural:**

> **Mutation testing cannot find an unobserved guarantee, because it does not
> know the claim exists.** It enumerates mutations of *code*. The claim lives in
> *prose*, and no build step reads prose.

Measured against that antipattern's six recorded instances — **3 of 6**:

| Instance | Result |
|---|---|
| 1, 5, 6 | **found** — a surviving mutant |
| 2 (#388) | **missed** — the mutation would be "delete the checker", and there is no checker to delete. Nothing to mutate |
| 3 (#381) | **missed, and worse** — mutating the guard reddens its own *self-test*, so the harness returns a false all-clear while nothing invokes the guard in CI |
| 4 (#393) | **missed by construction** — the assertion is load-bearing today; the defect is a future deletion |

The same shape as the 1-of-3 measured for variant 5's syntactic sub-shape above,
one level up. So even the systematic form is **half a detector**, and shipping it
as *the* answer to that class would be the class wearing a tool's clothes. It is
a real half, though, and the proportionate version recommended below covers
variant A on changed code — which is where most instances are.

**Three real limits, which is why this is "partially".**

1. **Equivalent mutants.** Some mutations cannot change observable behaviour, so
   no test can kill them and they must be triaged by hand. This repo has already
   hit that: [`reliability-suite.md`](reliability-suite.md#what-is-mutation-verified-and-what-is-not)
   records four edits that could not flip a scenario because the guarantee there
   is *structural* — the snapshot is immutable data, so there is no live
   reference to re-read. Its conclusion holds generally: **structural guarantees
   cannot be mutation-tested, and an assertion that cannot fail proves nothing
   about the code.**
2. **Cost.** Mutation testing runs the suite once per mutant. Against ~1,350
   tests across 12 packages, a repo-wide run is not a per-PR gate.
3. **It cannot see a wrong oracle.** A **Frozen Snapshot** survives every mutant,
   because the test agrees with the code by construction. Mutation testing asks
   "does any test notice this change?", never "is the expected value right?".

**Recommendation, not implemented here (this issue is documentation).** Keep the
manual RED-on-revert requirement as the primary control — it is cheap, it runs at
the moment the author still has the fix in their head, and it is what caught both
recorded instances. If we want the automated form later, the proportionate
version is a **scoped** mutation run over changed files only, reported as advisory
output rather than a merge gate, so the equivalent-mutant triage cost lands on the
author of the change rather than on everyone. Filing that as its own issue would
be the way to pick it up; nothing in this document depends on it.

**What stays human.** Frozen Snapshot, and Transcribed Oracle in its subtler
forms, are oracle problems — they are about whether the expected value is
*right*, which no amount of mutation can decide. Those remain review and QA
territory, and are the reason a reviewer asking "where did this number come
from?" is doing something a tool cannot.
