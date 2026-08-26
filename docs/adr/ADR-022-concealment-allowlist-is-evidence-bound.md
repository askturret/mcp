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

## Retirement trigger

If the harness ever emits these notices in a structured, delimited form whose
provenance an agent can verify directly, whole-message matching against
captured prose stops being necessary and this decision should be revisited.
Until then, the captured corpus is the only ground truth available.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
