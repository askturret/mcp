<!-- SPDX-License-Identifier: Apache-2.0 -->
# Testing

How this repository decides whether a test is worth having.

## The one rule

**A test must go RED when the fix it guards is reverted.**

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
nothing.

---

## The five antipatterns

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
| 5 | assertion passes under the mutation | the property holds | the assertion is satisfied by the named thing being **absent** | run every predicate against an **empty** source |

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
| 3 | Fault-injection scaffolding left in place during a second mutation reddened an unrelated assertion, so two failures looked like isolation and were not (#371) |
| 4 | A fixture written for one refusal exited via a different, already-asserted refusal — correct exit code, nothing new tested (#354) |
| 5 | `indexOf(a) < indexOf(b)` ordering assertions passed **vacuously** when the guard was deleted, because `indexOf` returns `-1` and `-1` precedes any real position (#371); and a 17-character hex asserted to *survive* redaction, which passed under a widening mutation because no rule fires on it at all (#266) |

### Two habits that pay for themselves

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
