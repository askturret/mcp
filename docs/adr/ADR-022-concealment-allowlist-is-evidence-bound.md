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
  transcribed as an ASCII hyphen in eleven entries, all from a single agent's
  capture style. A reviewer cannot see that difference at a glance.

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

**The ASCII-hyphen variant of T1 was not seeded.** Eleven entries render the
clause with a hyphen rather than an em dash — and those eleven are *exactly*
the eleven that also redacted the path, a perfect correlation with one agent's
transcription style. All thirty-four unredacted captures use U+2014. Seeding
the hyphen form would widen the allowlist on the strength of a transcription
slip.

**The `Note: `-prefixed variant of T2 was not seeded.** One capture records it;
four record the unprefixed form. TOML optionality is not available in this
schema by design, and adding the prefix as an alternative would be widening on
one observation.

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

Measured against the corpus rather than asserted — of the 39 entries carrying
`factor_1` at the time of writing, **every** `unverifiable` row also carries
`channel: unknown`, across two different agents. The correlation is total
because it is definitional.

**A second confounder, which weighting by `channel` alone does not remove.**
ANOMALOUS and `unverifiable` are not the same population. At the time of writing
the corpus holds 90 entries, of which **only 39 carry `factor_1` at all** — and
**within that 39-entry subset**, 31 are anomalous: 14 by the carrier path above,
and **17 that passed Factor 1**, anomalous because Factor 2 found no
whole-message template match. That second group is a statement about template
coverage rather than about the carrier or the agent. Read `factor_1` and
`template_id` as separate axes; collapsing them into `classification` merges two
unrelated causes into one number.

**That 31 is not the whole-corpus anomalous count, which is 78.** The two differ
because most entries predate `factor_1` entirely, so only the 39 carrying it can
be split by cause at all — the split above is silent about the other 51. Mixing
the two figures compares different populations.

Every count above is a snapshot and will drift as the corpus grows — **recount
from the artifact rather than citing them.** The artifact is the union of
`.operum/audit/concealment-reminders/*.jsonl` and the frozen
`.operum/audit/concealment-reminders.jsonl`; at the time of writing every entry
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

They differ more often than calendar arithmetic suggests. The allowlist was ~14
hours old when this was written and had already had three revisions, two of them
two hours apart; agent worktrees routinely outlive that interval. The staleness
is **bursty rather than rare**, and its bursts fall exactly on periods of active
allowlist development — which are also the periods of heaviest capture volume.

**This matters for how the corpus is read.** #388's diff-scoping rests on the
measurement that *42 of 43 inverse-shaped rows predate T1C's merge, and were
correctly anomalous against the allowlist of their moment.* That is an
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

## Retirement trigger

If the harness ever emits these notices in a structured, delimited form whose
provenance an agent can verify directly, whole-message matching against
captured prose stops being necessary and this decision should be revisited.
Until then, the captured corpus is the only ground truth available.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
