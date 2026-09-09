<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-027: A check must examine the artifact that lands, not a pre-transformation proxy

**Status:** Accepted (#741)

## Context

A check runs on a pull request and examines an object. Between that moment and
the object reaching users, something transforms it — a merge rewrites it, a
release rebuilds it, a publish relocates it. **The check certified the object it
saw, and a different object shipped.**

Two demonstrated instances in this repository, both measured rather than
reasoned:

| | what the check examined | what actually landed | outcome |
|---|---|---|---|
| **#670** | a tarball packed from the PR's tree | a tarball packed at release time, on a different runner, from a different tree | **no exit code the PR-lane check returned could stop a bad publish.** Fixed by adding a second invocation in the release job |
| **#696** | a PR commit, authored by the agent identity, whose `Signed-off-by` trailer matched | the squash commit: message preserved verbatim, **author rewritten to the founder and committer to GitHub** | **6 of 6 sampled merged commits fail `dco-check.sh`**, and `dco.yml` triggers on `pull_request` only, so `main` has never been checked |

Two further gaps identified by enumeration in #741, real but not yet demonstrated
by a failure:

- **`check-readme-imports`** — its own header says the imports must resolve *"FOR
  A READER, not just for this repo."* A reader resolves against the published
  package; the PR lane resolves against the workspace, where every specifier
  resolves through workspace linking regardless of what ships.
- **`check-npx-invocations`** — asserts every `npx @askturret/<pkg>` names a
  package *"this workspace publishes."* The claim is about the registry; the PR
  lane can verify the intent to publish, not that the name exists to install.

The forces that make this a decision rather than an obvious step:

- **The check is not wrong, and its output is not stale.** It correctly certified
  a real object. This is what distinguishes the class from
  [ADR-024](ADR-024-output-must-vary-with-the-fact.md) and from
  [ADR-025](ADR-025-derive-from-the-authority.md): nothing was copied, nothing was
  invariant. The *subject* was a different instance.
- **The transformation is usually invisible from the check's vantage.** Squash
  authorship rewriting happens on GitHub's side, after every local artifact says
  the trailer is correct. #696 went unnoticed across the entire history of the
  repository.
- **Green is indistinguishable from covered.** A PR-lane check that passes looks
  exactly like a check whose property holds on `main`. In #696's case the second
  was false 100% of the time.

## Decision

> **Ask what transforms this artifact between the check and the user. If anything
> does, the check has certified a proxy — and the property must be re-asserted on
> the object that actually lands.**

Two rules follow, and the first is the one most likely to be got wrong:

**ADD an invocation; never MOVE one.** #670's own workflow comment states this,
and it is the correct shape:

> *"The PR-lane invocation in test.yml's `test-integrity` is **RETAINED, not
> moved**: it is the cheapest refusal available and catches a committed
> regression before merge. This one proves the release tree, which is a different
> tree built on a different runner."*

Relocating trades an early cheap refusal for a late expensive one, and loses the
pre-merge catch entirely.

**The two invocations may need different exit semantics.** Again from #670: on a
pull request, *"I could not establish this"* is a reasonable shrug; immediately
before an irreversible publish it is a stop. A guard promoted to a release lane
must block on cannot-check, not only on divergence.

## Scope — three adjacent properties this does NOT cover

Recorded because each has been mistaken for this class, twice by this author.

**A guard that did not run at all.** `check-doc-surfaces` exists because
`readme-quickstart.test.ts` sat under a package path filter, so *"the exact
change it guards against, a doc-only edit, scheduled it not at all."* That is a
**scheduling** defect: the subject was correct and the check never executed. The
remedy is where it is wired, not what it examines.

**A check answering a different question.** #762's `doctor` reports preset-policy
admission under the name of a count of tools that will appear. **This author
originally cited #762 as an instance of this class and was wrong** — its output
is a mislabelled answer to a different question, not the same question asked of a
second instance of one subject. The correction shrank this record's evidence base
from three instances to two and is the reason it was deferred once before being
written.

**Incomplete coverage of one subject.** `check-express-resolution` verifies the
major under test is declared, but not that every declared major has a matrix leg
(#721). One subject, partially examined — ADR-024's excluded `#646` shape.

The three are separable by asking **what would fix it**: wire it elsewhere;
rename what it reports; widen its inputs. Only this record's class is fixed by
*re-asserting the property on a second object*.

## What was deliberately rejected

**Promoting all 26 PR-lane-only guards.** #741 enumerated them and found **24
whose subject is repository-internal** — the PR lane sees the tree `main` will
have, so no second instance exists. Promoting them would spend the serial signing
runner, the scarcest capacity in the build, to re-assert properties that cannot
have changed.

**Building the two identified gaps now.** Recorded rather than built, on two
grounds, both measured:

- **Neither gap has produced a demonstrated failure.** #670 had one — a PR-lane
  check that could not stop a bad publish. Nobody has yet shown a README that
  passes `check-readme-imports` and breaks for a reader, or an `npx` line that
  passes and names a package the registry lacks. Promoting on a reasoned gap
  rather than an observed one inverts the standard the two demonstrated instances
  set.
- **The release lane is the serial signing runner**, the scarcest capacity in the
  build. Two more guards there is a permanent cost paid on every release, against
  an unobserved failure.

> **An earlier draft deferred on a different ground, and that ground was false.**
> It said [#661](https://github.com/askturret/mcp/issues/661) reported guards
> that detect cannot-check and exit `0` anyway, so promoting one would install a
> gate that cannot refuse. **#661 was refuted as filed, on this record's own
> issue, nine hours before the record was written.** Measured here with `node` on
> `PATH` and `git` absent: `check-readme-imports` returns **2** — *"CANNOT CHECK
> — the clean room could not be built"* — and `check-npx-invocations` returns
> `0` legitimately, because it has **zero spawn sites** and so has no
> cannot-check condition to swallow, while still wiring `EXIT_CANNOT_CHECK = 2`
> and returning it. The stated ground applied to **neither** guard it was used to
> defer.
>
> Recorded rather than quietly replaced, because the failure is instructive: the
> claim was carried forward from this author's own earlier comment instead of
> from the issue thread as it then stood — **a reflection, in the sense
> [ADR-025](ADR-025-derive-from-the-authority.md) means it, and the authority had
> not moved. It had simply never been read.** An ADR outlives the review that
> produced it, so **re-reading the issue thread belongs in the last step before
> committing one.**
>
> #661's *actual* finding — that the fail-closed property is held by many
> implementations and asserted by nothing — is cited here **as #661's and not as
> this record's**: a crude proxy run while writing this correction (guards
> defining `EXIT_CANNOT_CHECK`, and which of them assert it in their own tests)
> did not reproduce its numbers, and adopting a count this author cannot
> reproduce would repeat the defect being corrected.

**A guard for the class.** It would have to know what transforms each artifact,
which is not recoverable from the repository — GitHub's squash behaviour is not
declared anywhere in this tree.

## Consequences

**Good.** One question at wiring time, and it is answerable: *what transforms
this between here and the user?*

**Good.** It gives #696 a name. A defect present in 100% of merged history, found
only when someone ran the checker against `main` on a hunch, is exactly the kind
that stays invisible without a class to recognise it by.

**Bad, and accepted.** Re-asserting on the landed artifact costs a second run, in
the most expensive lane. #670 pays it on every release.

**Bad, and accepted.** The two identified gaps stay open. This record names them
and does not close them.

**Bad, and NOT mitigated.** Nothing enumerates transformations. Squash-authorship
rewriting was found by accident; a future merge-strategy or release-path change
could introduce another and nothing would report it.

## Provenance

Written at the time, from the 2026-09-08 session.

**Verified independently for this ADR:** #696's 6-of-6 failure, by running
`dco-check.sh origin/main~6 origin/main` and reading the author, committer and
trailer of each commit; `dco.yml`'s `pull_request`-only trigger; #670's workflow
comment, quoted from `supply-chain.yml`; the 34 / 26 / 8 guard counts; and the
four previously-undecided guards' inputs, read from their implementations.

**The set the counts were enumerated over**, since naming only the commit leaves
them unreproducible — a reviewer's reasonable proxy returned 30 / 4 against these
26 / 8, and the difference was the definition, not the tree:

```
# 34 — non-test guards
git ls-tree -r --name-only origin/main .github/scripts/ \
  | grep '^\.github/scripts/check-.*\.mjs$' | grep -v '\.test\.mjs$'

# 26 — of those, invoked by test.yml and by NO other workflow
#      (per guard: grep -rl "$basename" .github/workflows/ | grep -cv 'test\.yml'  == 0)
```

**"PR-lane-only" means invoked by `test.yml` and by no other workflow file** —
not "absent from `supply-chain.yml`", which is the narrower proxy and yields a
different split. Re-derives exactly on `ebd15fd7` as it did on `3570bd7`.

**Reported and NOT reproduced here:** #661's finding that the fail-closed
property is held by many implementations and asserted by nothing. It is cited in
*What was deliberately rejected* as #661's own, because a proxy run while writing
this record did not reproduce its numbers. Every other claim above was measured
in this repository.

**Not established:** that squash is the only merge path in use. Six commits is a
consistent sample, not a proof of configuration, and the repository's
merge-strategy settings were not read.

> The linked-issue guard that refused PR #806 — because the closing keyword was
> in the title and not the body — states this record's principle in its own
> refusal text: *"the artifact you amend is not the artifact that merges."* It is
> **not an instance**; it is a worked example of the remedy, refusing at the
> point where the transformation happens. It arrived unprompted while this record
> was being deferred for want of evidence.

## Retirement trigger

Revisit if the release path stops rebuilding artifacts, or if merges stop
rewriting commit metadata — at that point the transformations this record exists
for would no longer occur, and a single PR-lane assertion would be sufficient.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
