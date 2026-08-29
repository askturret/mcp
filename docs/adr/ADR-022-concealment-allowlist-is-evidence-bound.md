<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-022: The concealment allowlist is evidence-bound

**Status:** Accepted (#276)

## Context

The two-factor concealment classifier routes a concealment-shaped harness
message as BENIGN only when it is not attributable to content the session
fetched (Factor 1) **and** it whole-message matches an entry in
`.operum/audit/concealment-templates.toml` (Factor 2).

That file had never existed here. With no file to match against, Factor 2
always failed, so **every** such message routed ANOMALOUS and produced a
prominent disclosure no matter how routine the trigger. The absence had been
flagged as a standalone observation at least twenty-five times across
individual capture PRs since 2026-08-23, and declined every time — correctly,
because deciding what an agent may treat as safe-to-ignore instruction-shaped
text is a security judgement that does not belong inside a routine capture PR.

The cost of leaving it absent is not zero. An alarm that is almost never a true
positive is one the reader learns to skim, and that is how the first genuine
one gets missed. **Over-disclosure is a safety regression too, just a slower
one.**

The forces that make this a decision rather than an obvious step:

- The file is a **security control in an unprotected path**. `.operum/audit/*`
  is engineer-owned, so any agent can edit it in an ordinary PR.
- Widening it is **cheap and quiet**. Adding one permissive template is a
  one-line diff that reads like configuration.
- The corpus shows **silent textual corruption in practice**: an em dash was
  transcribed as an ASCII hyphen in eleven entries as of `e901fc2`, all from a
  single agent's capture style. A reviewer cannot see that difference at a
  glance.

## Decision

**A template may not exist unless a real captured message matches it.**

Every `[[template]]` cites entries in `.operum/audit/concealment-reminders/`,
and `.github/scripts/check-concealment-templates.mjs` fails the build unless
the template's compiled prose matches at least one cited entry. Widening the
allowlist therefore requires *also planting a corpus entry* — a far louder
change than editing a line of TOML, and one a reviewer can read.

Four supporting decisions follow from that:

**Whole-message matching, anchored at both ends.** A substring test would admit
an attacker-named file such as `Dont-tell-the-user-this.txt` arriving inside
the `<PATH>` slot of an otherwise genuine message. Anchoring is structural —
there is no configuration knob that produces a substring match.

**The trailing attachment is a positive shape assertion, never "ignore the
tail".** A template declaring `trailing_attachment` matches only when the
remainder satisfies `attachment_pattern`. Discarding the remainder would let
arbitrary text ride along inside a BENIGN classification.

**That assertion is applied anchored, and the pattern is itself validated.**
Both halves were missing in the first implementation and QA defeated the
allowlist through the gap (#326). An unanchored `.test()` asks only whether the
pattern occurs *somewhere* in the tail — "ignore the tail" wearing a shape
assertion's clothes. And `attachment_pattern` was the one regex in the schema
never probed, while every slot pattern was: it must now reject arbitrary prose
*and* accept a canonical example of its declared attachment kind, and an
attachment kind with no canonical samples is refused rather than trusted.

**And it must not accept a NEIGHBOURING kind (#387).** The two directions above
are both blind to a pattern that accepts too *much*: a widened pattern still
accepts every canonical sample of its own kind and still rejects arbitrary
prose, so it passes both. That gap became reachable once T1C was added as a
*sibling* of T1 rather than a widening of it — a claim that rests entirely on
T1C's truncation marker being mandatory. Weakening that marker to optional makes
T1C silently accept the clean listings that are T1's territory, at which point
the templates overlap and the sibling argument is void. Measured rather than
supposed: that mutation survived the whole guard *and* every self-test
assertion. So each kind may also declare samples it must REJECT, holding text
that is a valid attachment of a different kind — necessarily per-kind, since the
shared arbitrary-prose probes can only hold text no attachment should ever
accept.

**A template's `prose` must contain its own `concealment_clause`.** This closes
the same attack at its root. Because captures legitimately elide their trailing
listing, evidence binding matches prose as a *prefix* of a capture — and a bare
prefix of a real message is still a prefix of it. So a template truncated to
`Note: <PATH> changed on disk since you last read it.` passes evidence binding
while citing genuine, unmodified evidence and planting nothing. Requiring the
declared clause means a truncated template is no longer a concealment template
at all. Prefix latitude is now granted only to templates that declare an
attachment — never more widely than the reason for it reaches.

**Pure ASCII, with `\uXXXX` escapes.** Every byte above U+007F is rejected,
comments included. This turns the one observed corruption mode into a
mechanically visible one: a reviewer cannot distinguish an em dash from a
hyphen, but can distinguish `—` from `-`. Note that the ASCII rule and the
evidence rule catch *different* corruptions — pasting a raw em dash fails the
first; editing `—` down to `-` passes it and is caught by the second.

**A strict-subset TOML reader, not a dependency.** The guards here are
zero-dependency `.mjs` and the project runs a supply-chain workflow. Beyond
that, a general TOML library silently accepts restructured input this schema
never intended — inline tables, dotted keys, datetimes — and silent acceptance
is the failure mode an allowlist cannot afford. For an allowlist, a restrictive
parser is a feature.

## What was deliberately rejected

Recorded so nobody re-derives them as obvious simplifications.

**The ASCII-hyphen variant of T1 was not seeded.** As of `e901fc2`, 130 captures
carry the clause: **11 render it with an ASCII hyphen and 119 with U+2014.**
Partition them by the character immediately preceding `otherwise no need to call
it out`; that is the whole method, and the two figures account for all 130.

Those eleven are exactly the captures whose `verbatim` begins
`Note: <redacted-abs-path>` — 11 of 11 in both directions. **That is a
correlation with one agent's placeholder string, not with redaction in
general.** The distinction is load-bearing: read "redacted" more broadly, as
*carries no absolute path in the `Note:` slot* (`verbatim` not matching
`Note: /`), and 31 captures redact, of which 20 still use U+2014.

An earlier draft of this paragraph called that a perfect correlation without
saying which reading it meant. It holds under the first and fails under the
second, so the reading was silently doing work the evidence was credited with.
State the predicate with the count, or the count cannot be checked.

Seeding the hyphen form would widen the allowlist on the strength of one agent's
transcription slip.

**The `Note: `-prefixed variant of T2 was not seeded.** As of `e901fc2`, of the
eight captures carrying T2's clause, **one** begins `Note: ` and **seven** do
not. TOML optionality is not available in this schema by design, and adding the
prefix as an alternative would be widening on one observation.

If either form is genuinely emitted upstream, it fails Factor 2, routes
ANOMALOUS **once**, a human confirms it, and it is added with its own citation.
That is the designed cost, and it is in the correct direction. **Never widen a
template to pre-empt drift.**

**A catch-all, optional literals, and alternation inside a template** are all
excluded for the same reason.

## Consequences

**Bad, and accepted.** New upstream wording produces one loud false alarm
before anyone can act on it. The allowlist can only ever lag the harness. This
is deliberate: the alternative is a template broad enough to match wording
nobody has seen.

**Bad, and accepted.** `corpus_matches` can under-claim as the corpus grows;
the guard only rejects over-claiming. An exact-count check would fail on every
new capture, which is the Frozen Snapshot antipattern.

**Bad, and NOT currently mitigated.** The file lives in an unprotected path, so
the guard is not the only thing needed: CI can check the *shape* of a widening
diff, but not whether it should happen. A CODEOWNERS entry was added to route
this file to the founder — and on this repository, today, **it routes nothing.**

That is not a caveat; it is the present state, and it was verified rather than
assumed (#326 QA):

- **CODEOWNERS is inert here.** The organisation is on the **free** plan and the
  repository is **private**. GitHub honours CODEOWNERS only on public
  repositories, or on private ones under Team or Enterprise. `requested_reviewers`
  on a PR touching `/.github/` — which already has a rule — is empty.
- **Even once enabled, it would not fire on our own PRs.** GitHub never requests
  review from a PR's own author, and every PR in this repository is authored by
  the founder. Self-authored changes bypass owner routing by construction.

So the honest statement of the compensating control is: **the entry is dormant.**
It becomes live only if the repository is made public or the organisation moves
to Team, *and* the widening change arrives from someone other than the file's
owner. Until then the only real controls on this file are the guard and human
attention on the diff.

The entry is kept because it is correct and costs nothing — the glob, the
placement and last-match-wins were all verified — and because the failure mode
of a *wrong* rule is silent. But it must not be cited as the answer to the
`attacker_influenceable` gap below while it cannot fire. Repository visibility
and plan are a founder decision, tracked in #330.

**Good.** The failure mode is closed: a missing, unreadable, or invalid file
means everything routes ANOMALOUS, which is exactly today's behaviour.

**Good.** `attacker_influenceable` is retained on every slot even though it no
longer licenses skipping Factor 1 (that waiver was withdrawn upstream). It
governs matching discipline and is a mandatory review criterion — a
mis-declared slot still reopens the substring hole.

**Bad, and now stated plainly.** CI validates that `attacker_influenceable` is
*present and boolean*; it cannot judge whether the declaration is *true*. A slot
flipped from `true` to `false` passes every check here. That was disclosed from
the outset and remains correct — but the compensating control named for it was
CODEOWNERS review, which is dormant (above). **So this gap is currently
uncompensated by any mechanism**, and rests on whoever reads the diff. Recording
it that way is the point: an unmitigated risk that is written down can be
scheduled, while one described as mitigated cannot.

## Reading the corpus

The corpus is the evidence base for every template above, and the raw material
for any upstream wording-drift report. Both uses invite tallying it, and a tally
**by author** misleads — so this is written down before someone runs one.

**Weight by `channel`, not by `agent`.** Factor 1 asks whether the text is
attributable to something the session fetched. Answering it needs a legible
boundary between a tool's payload and anything appended after it. A structured
JSON return has one; a free-text return — `Bash` stdout, raw file contents — does
not, so the determination is *indeterminable*, which records as
`factor_1: unverifiable` and routes ANOMALOUS.

That path is reached by **carrier shape alone**. Nothing about the agent, the
method, or the message is involved. An agent working predominantly through
`Bash` therefore accumulates `unverifiable` entries at a higher rate than one
working through MCP tools, and a per-author tally of `classification` measures
**tool mix**, not message risk.

Measured against the corpus rather than asserted — of the 87 entries carrying
`factor_1` as of `e901fc2`, **every** `unverifiable` row also carries
`channel: unknown`, across two different agents. The correlation is total
because it is definitional.

**A second confounder, which weighting by `channel` alone does not remove.**
ANOMALOUS and `unverifiable` are not the same population. As of `e901fc2`
the corpus holds 140 entries, of which **only 87 carry `factor_1` at all** — and
**within that 87-entry subset**, 46 are anomalous: 25 by the carrier path above,
and **21 that passed Factor 1**, anomalous because Factor 2 found no
whole-message template match. That second group is a statement about template
coverage rather than about the carrier or the agent. Read `factor_1` and
`template_id` as separate axes; collapsing them into `classification` merges two
unrelated causes into one number.

**That in-subset 46 is not the whole-corpus anomalous count, which is 93.** The
two differ because many entries predate `factor_1` entirely, so only the 87
carrying it can be split by cause at all — the split above is silent about the
other 53. Mixing the two figures compares different populations.

Every count above is a snapshot taken at `e901fc2` and will drift as the corpus
grows — **recount from the artifact rather than citing them, and name the commit
you counted at.** Without that coordinate a reader who recounts and disagrees
cannot tell drift from error. The artifact is the union of
`.operum/audit/concealment-reminders/*.jsonl` and the frozen
`.operum/audit/concealment-reminders.jsonl`; as of `e901fc2` every entry
lives in the per-entry directory and the frozen log is not present, but a
recount must read both, because a tally over one source silently under-counts.

The structural claim above does not drift, because it is definitional rather
than observed: `unverifiable` is recorded precisely when the boundary could not
be established, which is what `channel: unknown` means.

### `template_id` is a PROSE match, and always has been (#408)

The paragraph above tells you to read `factor_1` and `template_id` as separate
axes. It is worth knowing what the second axis actually measures, because it is
narrower than the field's name suggests:

> A row's `template_id` records that the template's **prose** matched the
> message's head. For a template declaring a `trailing_attachment`, the
> whole-message rule was applied at classification time, to the **live message**,
> and is **not recoverable from the capture.**

**This is a description, not a weakening.** Both of this ADR's corpus-facing
numbers — evidence binding and `corpus_matches` — already compute exactly this,
in `check-concealment-templates.mjs`, deliberately and with the reasoning in a
comment: *captures elide their attachment*, so an attachment-bearing template is
compared on its head. That has run on every PR since the guard shipped. #408
found a **type error** — the field written in one matcher's vocabulary and read
in another's — rather than a gap that had been hiding.

The consequence for reading the corpus: an entry's `template_id` is
self-verifying only where the template declares `trailing_attachment = "none"`.
Elsewhere it is checkable on prose alone, which cannot separate T1 from T1C —
they share their prose byte-for-byte — and cannot show whether the live
attachment satisfied the template. The full residue, its containment by Factor
1, and why a *derived* witness cannot close it, are recorded where a capturing
agent will meet them:
[`.operum/audit/concealment-reminders/README.md`](../../.operum/audit/concealment-reminders/README.md).

**No entry is wrong because of this**, and none is to be corrected. The field
means what it always meant; only the documentation was silent.

### A Factor 2 verdict is scoped to the classifier's own worktree (#410)

Stated because a reader will otherwise assume the wrong referent:

> A Factor 2 verdict is evaluated against the allowlist **as present in the
> classifying agent's worktree**, recorded as `templates_revision` — the blob
> hash of the file as read. It is **not** a claim about `main`'s allowlist at
> that moment, and the two can differ.

They differ more often than calendar arithmetic suggests. As of `e901fc2` the
allowlist had **five revisions** since it was seeded on 2026-08-25, **two of
them fourteen minutes apart**, and agent worktrees routinely outlive that
interval — re-derive with
`git log -- .operum/audit/concealment-templates.toml`. The staleness is
**bursty rather than rare**, and its bursts fall exactly on periods of active
allowlist development — which are also the periods of heaviest capture volume.

**This matters for how the corpus is read.** #388's diff-scoping rests on **its
own** measurement that *42 of 43 inverse-shaped rows predate T1C's merge, and
were correctly anomalous against the allowlist of their moment.* That figure is
#388's and is deliberately **not re-derived at this anchor**: "inverse-shaped"
is defined there and not here, and quoting a count without the predicate that
produced it is the defect the paragraphs above were just corrected for. It is an
**inference from timestamps**, because no row recorded what it saw — and it is
precisely the inference that failed for the one post-merge row, where
timestamp-versus-merge said *"should have matched"* and the truth was a stale
worktree. `templates_revision` converts that inference into an observation.

Rows predating the field are neither backfilled nor failed, exactly as with
`factor_1`. The field, its blob-hash-not-commit-SHA rationale, and the two
repairs rejected in reaching it are recorded where a capturing agent will meet
them:
[`.operum/audit/concealment-reminders/README.md`](../../.operum/audit/concealment-reminders/README.md).

**None of this is a defect, and the caveat must not be read as scheduling a
fix.** Refusing to certify a boundary that cannot be observed is the classifier
working: `unverifiable → anomalous` is the load-bearing clause, and loosening it
for free-text carriers would reopen the hole it closes. The asymmetry is honest
and errs in the safe direction. What needed recording is not the behaviour but
its effect on anyone *reading* the resulting evidence.

Nothing here needs instrumenting. `channel` is already a required enum on every
entry — which is precisely what makes this checkable rather than a matter of
recollection, and why it was specified as an enum rather than free prose.
Entries predating the field carry neither `factor_1` nor `channel`; they are not
backfilled, so any tally must scope itself to rows that carry them. Absence
means *"predates the field"*, which is a different fact from `unknown`.

**The "checkable" claim in that paragraph is true only at the `unknown`
boundary, and the section below is where it stops.** Read it as scoped, not as
a property of the field in general: `unknown` against everything else is
checkable because it is the definitional Factor 1 axis restated, while the
distinctions *among* the PASSES values are a recorded judgement.

### The carrier observation, and why `channel` cannot measure it (#468)

The section above makes two claims that a reader has to take on the text's word:
that the carrier alone decides Factor 1, and that `channel` is what makes this
"checkable rather than a matter of recollection". The first now has an artifact.
The second does not survive one.

#### The carrier pair — an anchor for the asymmetry claim

`20260828T194721Z-engineer-305` ↔ `20260828T195421Z-engineer-305-b`. Same
agent, same task (#305), same day, seven minutes apart, the **same file**
(`packages/cli/src/commands/diagnostics-bundle.ts`), both matching **T1C**:

| | `194721Z` | `195421Z-b` |
|---|---|---|
| carrier | `Bash` free-text return | MCP JSON (`git_checkout`) |
| `channel` | `unknown` | `tool-result-adjacent` |
| `factor_1` | `unverifiable` | `passed` |
| `classification` | **anomalous** | **benign** |

The carrier is the only independent variable, and it moved the verdict.

**Both routings are correct, which is what makes the pair usable.** `benign` is
right for `-b`: `git_checkout` returned `{"branch":"agent/engineer"}`, so prose
outside that JSON is demonstrably not payload. `anomalous` is right for
`194721Z`: the agent knew its `node -e` printed one line, but incidental
knowledge is explicitly not the test — the return shape is, and a free-text
return has no legible boundary. Had either been over-conservative the pair would
evidence a classification bug instead.

**Cite `-b`, never `-a`.** `20260828T195421Z-engineer-305-a` shares `-b`'s
carrier but concerns a **different file**
(`packages/cli/src/__tests__/diagnostics-path-grammar.test.ts`), so it cannot
serve as the controlled comparison. A citation naming "the two `195421Z`
captures" as the pair is refutable on inspection, and the refutation would land
on this doctrine rather than on the citation.

#### `channel` records a judgement; it does not measure a carrier

The paragraph above says `channel` is what makes the asymmetry checkable. **For
the `unverifiable` path that holds and is definitional** — recounted at
`3a3984e`, all 27 `unverifiable` rows carry `channel: unknown`, as they must,
because `unknown` is what "the boundary could not be established" means.

**Inside the PASSES set it does not hold at all**, and the T2 date-rollover
family shows why. Six rows at `3a3984e`, from two broadcasts:

| broadcast | adjacent artifact | `channel` values |
|---|---|---|
| 2026-08-26 | a `TASK` / `SELF-ASSESSMENT` dispatch trigger | `trigger-adjacent` ×3 (pm, tester, architect) |
| 2026-08-29 | a `SUMMARIZE_SESSION` context-rotation checkpoint | `bare-system-turn` ×2, `trigger-adjacent` ×1 |

Every one of the six describes *something dispatched adjacent to the arrival*.
The first three agree; the second three split 2–1 — and the three agents in the
second group were later established, from each other's `context` fields rather
than from recollection, to have had **the same carrier**.

The 2026-08-26 broadcast is the corpus's own control: hold the family fixed,
make the adjacent artifact an unambiguous trigger, and the field is stable.
**The instability is not general — it is localised to one unnamed arrival type.**
The channel table enumerates *"a trigger or `PM_UPDATE`"* and *"a dispatch
trigger"* and never says whether a context-rotation checkpoint is one.

Why it goes unexamined rather than being argued out: `trigger-body` vs
`trigger-adjacent` is an **attribution** distinction, and Factor 1 forces its
resolution — the two sit on opposite sides of PASSES/FAILS. `bare-system-turn`
vs `trigger-adjacent` is a **carrier** distinction, and Factor 1 never forces
it, because both are inside PASSES. With no tie-break, agents write a
sound-looking `factor_1_basis` either way and never discover they disagreed.

**Consequence: two rows differing in `channel` are not evidence that their
carriers differed.** Anyone building a carrier argument from a cross-row
`channel` comparison is reading a judgement as a measurement. The pair above
avoids this — its carriers are established from the tool return shapes named in
the rows, not inferred from the field.

**No verdict is affected and no row is to be corrected.** All six T2 rows route
BENIGN and every one is insensitive to the choice. The three divergent rows are
deliberately **not** harmonised: a corpus quietly converging on a majority value
would erase the only evidence the ambiguity exists.

#### Read order is load-bearing, and it is only half the rule

The channel table defines `bare-system-turn` as *"no wrapper, no **preceding**
fetch"*. That word carries the whole classifier, and nothing explains it. The
argument that does:

> If *"identical text exists in fetched content"* implied ATTRIBUTABLE, then
> once the first capture of a family merges, every later instance of that family
> routes ANOMALOUS forever — and QA-ing a capture PR would be the act that
> corrupts it. **The corpus would poison its own classifier.**

This is a *reductio*, not a preference, and it is decisive against the
existence reading: the corpus is **designed** to hold verbatim copies, so its
content is guaranteed to match every future emission of every family it
records — degrading fastest for the families captured best.

**But read order alone does not repair it, and the reductio's own scenario is
where it fails.** A reviewer who reads a merged capture row and *then* receives
a fresh emission has a fetch that genuinely **precedes** the arrival. "No
preceding fetch" routes that ANOMALOUS, so the poisoning returns in attenuated
form. Read order is **necessary and not sufficient**: a fetch after the arrival
cannot have produced it, but a fetch before it need not have.

The rule that survives both cases is **causal production** — attributable iff a
fetch of mine *produced* this text, meaning the arrival **is** that fetched
content rather than merely matching it. The doctrine already intends this where
it frames Factor 1 as *"a question about provenance"*; only the channel table is
phrased as existence. Read `preceding` as the cheap necessary half of a
production test, never as the test itself.

#### Emission rate — a separate observation, and open

Distinct from the carrier finding and not evidence for it. At `3a3984e` the
"one message per changed file" reading has two clean instances
(`195421Z` -a/-b; `202937Z` -a/-b — two files, two messages each) and **two
counter-instances**: `201644Z`, where both changed files differed from `main`
yet one message arrived, and `204750Z-b`, where #471 changed four files and two
messages arrived.

**Both counter-instances were first written up as corroboration, and both were
false in the same direction.** The reason is worth more than the ratio: the
reminder fires on files differing from the harness's snapshot at the agent's
**last read** — not from `main`, not from the branch, and **not enumerable from
git**. Counting changed files measures a set that was never the harness's input,
which is close enough to be plausible and wrong often enough to mislead. A
corpus count keyed on changed files cannot settle this however many rows it
covers.

**No mechanism is claimed.** Two were asserted from reasoning and withdrawn;
snapshot-staleness is the trigger, not an explanation of the observed ratios.

#### State the denominator with the ratio, or the ratio cannot be checked (#494)

**"Two clean instances" above is denominator-relative, and the denominator was
never stated.** Two agents re-derived the same four instances from artifacts and
reached different tallies — not because either miscounted, but because
*"changed file"* has two defensible readings and each picked one silently.

Measured with `--name-status`. **Both endpoints are as-of the capture's own
timestamp**, and naming only one of them is what makes such a table
unreproducible — so both are given per row:

- **base** — `main` as it stood when the capture was taken.
- **branch** — the feature branch's HEAD at that same moment, which is **not**
  its eventual tip. These branches kept receiving commits afterwards, in one
  case including the very captures being counted.

| capture | base | branch HEAD then | **M**odified | **A**dded | messages |
|---|---|---|---|---|---|
| `195421Z` -a/-b | `78a7eb1` | `eb25089` | **2** | 1 | 2 |
| `201644Z` | `1054825` | `9a141fa` | 3 | 1 | 1 |
| `202937Z` -a/-b | `fcac8ba` | `92ff9d1` | **2** | 0 | 2 |
| `204750Z` -b | `bfc0037` | `5db509d` | 4 | 0 | 2 |

Each row is `git diff --name-status <base> <branch>`.

**Row 1 is the one that needs its branch endpoint named, and it is also the row
the whole argument rests on.** Taken from the branch's eventual tip instead, it
reads `M=3 A=3`: that branch went on to commit the two `195421Z` captures
themselves, and `protected-file-events.jsonl` was first touched seventeen
minutes *after* the checkout. Rows 2–4 happen to reproduce from their tips, so
the omission survives a spot-check and fails only where it matters.

Recorded rather than quietly fixed, because it is this subsection's own thesis
turned on itself — a table asserting *"state the denominator"* that could not be
re-derived under an unstated convention. It was caught only because the reviewer
re-derived the numbers **before** reading the reasoning; read in order, the gap
is invisible.

- Counting **modified** paths: `195421Z` is clean, and the tally is **two clean,
  two counter** — the reading recorded above.
- Counting **all differing** paths: `195421Z` is 3-against-2 and the tally is
  **one clean, three non-clean**.

Both are computable, both are honest, and they disagree. So the ratio is not a
fact about the harness until the denominator is named beside it — the same
correction this ADR already made once for the eleven-hyphen count: *state the
predicate with the count, or the count cannot be checked.*

**The divergence has a single cause, and it is itself an observation.** The
third `195421Z` path is `A`, not `M`: the branch **added** that capture
`.jsonl`, so returning to the home branch **deleted** it rather than modifying
it — and **no message was emitted for it.** The agent had written that file, so
a snapshot plausibly existed. That is the only add-versus-modify case among the
four, and it is exactly where the two readings come apart.

It also suggests the modified-files reading may be *correct* rather than merely
convenient — a deletion may not be a "change on disk" for this purpose. Stated
as a candidate, not a finding: one instance is not a rule, and the section above
is right that no mechanism is established.

**And the `main`-based proxy is not a measurement either.** Every base in the
table assumes the agent's home branch stood at `main`'s tip when the checkout
ran. **Nothing records where it stood** — Step 0 sync time is not logged, in the
team log or anywhere else. A home branch synced earlier would have reverted more
files than the table shows, so each row is an *upper bound on agreement*, not a
count.

Which sharpens the section above rather than contradicting it. The denominator
we would actually want — snapshot-staleness — is not recoverable from git; the
two proxies that *are* computable disagree with each other; and neither is
pinned to the state the checkout actually left. **Three independent reasons the
ratio cannot be settled by counting**, and only the first was recorded before.

#### Provenance

The carrier pair, the counter-instances and the T2 control were each re-derived
here from the rows and from git before being written down. The *reductio* is the
Tester's, and reached this document through a **self-stamped** PR (#488 — the
Tester is sole QA-stamp owner and authored it; the structural gap is #489). It
is recorded because a second reader found the argument sound, and the
sufficiency limit above is that reader's amendment to it, not the original
claim.

The denominator subsection (#494) was added afterwards, from a second Architect
session that had measured the same four instances independently and reached a
different tally. **It reported that as a contradiction and was wrong to.**
`--name-status` showed both readings were sound and the denominator had simply
never been named — so the correction landed on the newer claim, not on the one
recorded here. The add-versus-modify observation and the unrecorded home-branch
position came out of settling it.

## Retirement trigger

If the harness ever emits these notices in a structured, delimited form whose
provenance an agent can verify directly, whole-message matching against
captured prose stops being necessary and this decision should be revisited.
Until then, the captured corpus is the only ground truth available.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
