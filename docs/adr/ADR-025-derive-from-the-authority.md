<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-025: Derive from the authority, never from a reflection

**Status:** Accepted (#780)

## Context

On 2026-09-08 this repository fixed five defects that looked unrelated and were
not. Each obtained a value from something that *reflected* the authority instead
of from the authority itself.

| | the value | where it was taken from | why the reflection was wrong |
|---|---|---|---|
| **#768 / #804** | the cause of a dropped parameter | the downstream **symptom** — `!op.input` at `validate-invariants.ts:80-87` | a schema dropped for an unencodable media type reported `MISSING_INPUT_SCHEMA`. True in effect, false in fact: the schema was present and readable |
| **#804** | which codes are shared between `doctor` and the compiler | **one pass** — the file being edited | walking a subset of the **three** passes that call `context.warnings.warn` reported **four** shared codes; the answer is **five**. `resolve-identity` was missed |
| **#676** | how many notices a corpus row recorded | a **count** carried in a brief | the corpus held 234 files and 239 rows. The "five" was the arithmetic surplus, not any file's contents |
| **PR #605** | a `Signed-off-by` trailer | **memory** of an earlier commit's trailer | it named `dmitrys-mac-mini-8`; the host had been rebuilt as `-9`, so the trailer named a machine that no longer signed anything |
| **PR #804** | a `Signed-off-by` trailer | **an earlier commit** on the same branch | same failure, different reflection: the machine's identity had changed again, and the copied trailer was a snapshot of the old one |

The forces that make this a decision rather than an obvious step:

- **Every reflection was accurate when it was taken.** This is what makes the
  class hard to see. The trailer named the right host *yesterday*; the
  enumeration covered the right passes *for the file it walked*; the count was
  arithmetic performed correctly on the wrong quantity. **None of these is a
  carelessness failure**, and treating them as such is why they recur.
- **The reflection is almost always the cheaper read**, and often the only one
  visible from where the author is standing. Re-walking three passes costs more
  than copying a list from the file already open.
- **They do not look alike.** A commit trailer, a compiler diagnostic, an
  enumeration in a comment and a number in a brief share no surface. Four of the
  five were found by different people on different tasks, and the shape was only
  visible once they were laid beside each other.

## Decision

> **Obtain a value from the thing that DEFINES it, never from anything that
> merely REFLECTS it.**
>
> A copy, a subset, a downstream effect, a cached artifact and a remembered
> value are all reflections.

Applying it is one question: **what would I have to change to make this value
wrong?** If the answer is anything other than the thing the value is about, you
are reading a reflection.

Three notes on scope:

**A reflection is not a lie; it is a snapshot.** It was correct at the moment it
was taken, and it decays silently. So the failure has no moment of breakage to
notice — which is why none of the five was caught by the person who introduced
it.

**"The authority" is whatever would be updated if the fact changed.** For a
commit's author, the commit object. For a set of codes, every file that declares
one. For a corpus measurement, the corpus. If two candidate sources disagree,
the authority is the one the other one is derived *from*.

**Cost is a reason to be explicit, never a reason to substitute.** When
re-deriving is genuinely too expensive, the answer is the next section — not a
quiet reflection presented as an answer.

## When you cannot make the reader re-derive, say what you derived over

The mitigation is not a softener. **A note that admits doubt and a note that
enables re-derivation are different artifacts**, and only the second is useful:

- *"This list may be incomplete"* transfers the author's uncertainty to the
  reader and gives them nothing to act on.
- *"The set this was enumerated over is X, Y, Z"* lets the reader check whether
  the set is still right, which is the actual question.

#804's own comment is the worked example, and it earns its place by naming the
error it is correcting:

> *"THE SET THIS WAS ENUMERATED OVER, stated so the next reader can judge whether
> it was **closed over the right thing**: every pass under
> `packages/core/src/compiler/passes/` that calls `context.warnings.warn` —
> `apply-overlays`, `resolve-identity` and this file … THAT SCOPE IS THE
> CORRECTION. The first version of this note walked only THIS pass — the one
> being edited — and reported four shared codes **as though that were the whole
> set**."*
>
> — `validate-invariants.ts:74-82`, quoted from one file rather than spliced.

**State the set, not the doubt.** A reader who knows what you walked can re-walk
it; a reader told only that you might be wrong can do nothing but distrust you.

Note what the source asks, because an earlier draft of this record paraphrased it
away: *"closed over the **right thing**"* — not *"long enough"*. **The question
is whether the predicate was right, not whether the list was complete.** A list
can be exhaustive over the wrong set, which is exactly what happened there.

## Why this is not ADR-023 or ADR-024

Stated precisely, because a fourth restatement of one principle would be worse
than no record.

- **[ADR-023](ADR-023-remedy-test-and-the-two-axes.md) Axis 1 — verify the
  property that matters.** Presumes you verified *something* and chose the wrong
  property. Here the property is right and the *source* is wrong: #804's
  enumeration was asking exactly the right question of exactly the wrong set.
- **ADR-023 Axis 2 — state exactly what you verified.** Closest, and the
  re-derivation section above is deliberately built on it. Axis 2 governs the
  *claim*; this record governs the *read that produced it*. A claim can state its
  bound impeccably and still have taken its value from a stale copy — the trailer
  instances did exactly that.
- **[ADR-024](ADR-024-output-must-vary-with-the-fact.md) — output must vary with
  the fact.** Presumes the output is attached to nothing. Every value here *did*
  vary with its source; the source was the wrong one. A copied trailer varies
  perfectly with the commit it was copied from.

## What was deliberately rejected

**"Never copy anything."** Too broad to act on, and it would forbid the correct
case: copying a value *from its authority* is exactly what this record asks for.
The rule is about the **source**, not the mechanism.

**A guard.** Deciding whether a value's source is authoritative requires knowing
what the value is about, which is not recoverable from the text. The one
tractable corner — a `Signed-off-by` trailer that does not match its commit's
author — is **already** guarded by `dco-check.sh`, and it caught two of the five
instances above. That guard is the existence proof for the narrow case and the
argument against the general one.

**Folding in the disclosure rule as its own record.** The re-derivation note is
the *mitigation for this exact failure* — it exists because you could not derive
from the authority. Splitting them would leave a rule about disclosure with no
statement of what it is disclosing about.

## Consequences

**Good.** One question — *what would I have to change to make this wrong?* — and
it applies to a commit trailer, a comment, a count and a compiler diagnostic
without adaptation.

**Good.** It gives the five instances a shared name, so the next one is
recognisable as a recurrence rather than a novelty.

**Bad, and accepted.** Re-deriving costs more than copying, every time. This
record asks for that cost on every read, and the saving is invisible because it
is a defect that did not happen.

**Bad, and accepted.** Nothing enforces it. `dco-check.sh` covers one instance
class; the rest rely on the author asking the question.

**Bad, and NOT mitigated.** Reflections already in the tree look exactly like
derivations. No audit has been done, and the five above were found incidentally
over one day — which is not evidence that they are the only ones.

## Provenance

Written at the time, from the 2026-09-08 session. **The distinction between what
was verified here and what was reported by others is load-bearing**, since this
record's subject is values taken from sources that were not checked.

**Verified independently for this ADR:**

- **The `MISSING_INPUT_SCHEMA` cause-naming** — read on `main` while ruling on
  #762. `validate-invariants.ts:80-87` warns on `!op.input` and `continue`s,
  with no access to why `input` is absent; the construction-time drop sites in
  `from-openapi.ts` return `undefined` silently.
- **#804's enumeration** — the comment states that the original walk covered only
  the pass being edited and reported four codes where five exist. **The passes
  were counted from the source directory on review** (nine files under
  `packages/core/src/compiler/passes/`, of which three call
  `context.warnings.warn`), not from the commit comment.
- **#676's counts** — measured directly **on 2026-09-08 at the time of that
  ruling**: 234 files, 239 rows. **The absolute pair is dated and drifts daily;
  the surplus of 5 is the load-bearing part** and has held at every commit
  sampled since (253/258, 255/260, 257/262, 262/267). Recount rather than citing
  these.
- **The PR #605 trailer** — its own DCO check refused the commit, naming the
  mismatch between the remembered value and the actual author.

**Reported and NOT reproduced here:** the PR #804 copied-trailer instance, which
is QA's and the Engineer's observation; and a stale build artifact resolving
through a workspace symlink, reported by QA the same day, whose subject this
author did not read.

> **A marked value is not a true one, and this record proved it against itself.**
> The first draft said the #804 walk covered *"a subset of the four passes."*
> There is no four: nine passes exist and three call `context.warnings.warn`, and
> the merged comment this record cites says *"`apply-overlays`, `resolve-identity`
> and this file"* — three. **The four was introduced here.**
>
> The Provenance above had already flagged that row as derived from the commit
> comment rather than from the passes. **The flag was correct and the value it
> produced was still wrong**, because a disclosure records where you looked, not
> whether what you found is true. It was caught by review, not by the marking.
>
> So: **stating your source is necessary and is not sufficient.** Where the value
> is load-bearing, derive it from the authority as well as saying that you did
> not — and note that this defect was a wrong count *inside the row describing a
> wrong count*, in a record about counting. That is where this class hides.

> **This record was itself written under its own rule, and the rule fired.** The
> `Signed-off-by` trailer on its commit was derived by reading the commit
> object's author line **after** committing. That read returned
> `dmitrys-mac-mini-10`. The trailer on this author's previous commit — one day
> old, correct when written, and sitting in immediate reach — reads
> `dmitrys-mac-mini-9`. The host had been rebuilt in between.
>
> **Copying it would have failed the check, and nothing available at the moment
> of writing would have suggested otherwise.** The reflection was cheaper, closer
> to hand, and wrong; the authority cost one extra command. This is the sixth
> instance, and it happened while documenting the other five.

## Retirement trigger

Revisit if a mechanism ever covers the general case — a way to assert that a
value's source is its authority, rather than one guard per instance class. Until
then this is applied by hand, and `dco-check.sh` remains the only instance with a
machine behind it.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
