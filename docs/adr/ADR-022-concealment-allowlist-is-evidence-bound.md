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

**Bad, and mitigated.** The file lives in an unprotected path, so the guard is
not the only thing needed — a CODEOWNERS entry routes it to the founder, since
CI can check the *shape* of a widening diff but not whether it should happen.

**Good.** The failure mode is closed: a missing, unreadable, or invalid file
means everything routes ANOMALOUS, which is exactly today's behaviour.

**Good.** `attacker_influenceable` is retained on every slot even though it no
longer licenses skipping Factor 1 (that waiver was withdrawn upstream). It
governs matching discipline and is a mandatory review criterion — a
mis-declared slot still reopens the substring hole.

## Retirement trigger

If the harness ever emits these notices in a structured, delimited form whose
provenance an agent can verify directly, whole-message matching against
captured prose stops being necessary and this decision should be revisited.
Until then, the captured corpus is the only ground truth available.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
