<!-- SPDX-License-Identifier: Apache-2.0 -->
# Concealment capture fidelity

One file per entry, named `<ts>-<agent>-<issue>.jsonl`. One file per entry is
why two agents capturing at the same moment never collide.

## Capture `verbatim` byte-exactly. Never substitute a placeholder.

This is the rule that everything else depends on, and it is the one most often
broken.

These captures are not only a record — they are **the evidence the Factor 2
allowlist is validated against**. `.github/scripts/check-concealment-templates.mjs`
fails the build unless each template in
[`../concealment-templates.toml`](../concealment-templates.toml) matches a real
entry here. A template is only as trustworthy as the message it cites, so a
capture whose text was rewritten cannot support one.

**A rewritten capture is not a partial record. It is an unusable one.** You
cannot verify a whole-message template against a message whose text was
changed.

### Do not redact the path

When the analysis behind [ADR-022](../../../docs/adr/ADR-022-concealment-allowlist-is-evidence-bound.md)
was done, **27 of 61 file-change captures had replaced the absolute path** with
`<redacted-abs-path>`, `<PATH>`, `<ABSOLUTE_WORKTREE_PATH>` or `<repo>`. All 27
were unusable, and the analysis only reached a defensible answer because 34
other captures had preserved it.

The path is not a credential. It is a filesystem path, and its exact rendering
is what proves where the slot boundary falls.

### Do not normalise punctuation

Copy the characters that were there. An em dash (U+2014) is not a hyphen; a
typographic apostrophe (U+2019) is not U+0027.

Both slips are attested. Eleven entries silently turned an em dash into a
hyphen. And the capture taken for #276 — written by an agent who had just read
this rule while implementing the guard — transcribed `That's` with U+2019 and
broke its own byte-exact match. It was caught only because the guard checks
evidence mechanically. **Assume you will make this mistake and let the guard
tell you.**

## Elide only a trailing line-numbered listing, and say that you did

A file-change notice may be followed by a line-numbered listing of the file.
That listing is an *attachment*, not message prose, and eliding it is fine.

- Keep the **whole prose**, through the final `:` of
  `Here are the relevant changes (shown with line numbers):`.
- Say in the entry that you elided, and whether the harness truncated it.
- Prefer keeping the **first and last listing lines**. Every capture before
  #276 elided the listing entirely, which is why `attachment_pattern` could not
  be derived from the corpus at all and had to be confirmed against a
  purpose-taken capture.

Concealment-shaped text found *inside* a listing is ANOMALOUS, never benign.

## Required fields

Beyond `ts`, `agent`, `issue`, `context` and `verbatim`:

| Field | Notes |
|---|---|
| `factor_1` | `passed` / `failed` / `unverifiable`. **`unverifiable` implies `classification: "anomalous"`** — never resolve doubt toward benign. |
| `factor_1_basis` | What you actually checked: the tool call, the file, or the absence of any fetch. A verdict without evidence cannot be disagreed with. |
| `channel` | Which carrier the text arrived on. Use `unknown` when body-vs-adjacent cannot be established — omitting the field is worse, because a query cannot count an absent field. |
| `classification` | `benign` / `anomalous`. |
| `template_id` | The template whose **prose** matched, or `null` when none did. See below — this means less than it looks like, and always has. |
| `stated_cause_frame` | `world-state` (is the claim true of the world?) or `agent-attributed-cause` (is its account of *what caused this* true?). Prefer the latter when the message asserts a cause. |
| `stated_cause_evidence` | What you checked and what it showed. |

A false stated cause does **not** make a message anomalous — the file-change
notice routinely misattributes an agent's own edit. Record the falsity;
classify on the two factors only.

Entries written before a field existed are **not** backfilled: a missing
`factor_1` means "predates the field", which is a different fact from
`unverifiable`, and conflating them would corrupt the measurement.

## What `template_id` means, and what it cannot show (#408)

> **`template_id` records that this template's PROSE matched the message's
> head.** The whole-message rule — prose *and* attachment — was applied at
> classification time, to the live message, and is **not recoverable from the
> capture.**

**Nothing was given up in writing that down.** A reader meeting "narrowed" will
assume a claim was weakened; it was not. The corpus-side matcher has *always*
compared prose for attachment-bearing templates —
`check-concealment-templates.mjs` does it in both evidence binding and
`corpus_matches`, with the reason in a comment: *because captures elide their
attachment*. This paragraph is a description of shipped behaviour, not a
concession. The field was written in one matcher's vocabulary and read in
another's; that mismatch, not a verifiability gap, is what #408 found.

It follows from a rule two sections up rather than being an extra rule: you
elide the listing, so the stored bytes cannot exhibit what an attachment
requires. An attachment-less template (`trailing_attachment = "none"`) has no
attachment to elide, so its entries verify themselves whole.

### The residue, stated exactly — it is sharper than "unverifiable"

T1 and T1C **share their prose byte-for-byte**. So on a capture, prose-matching
resolves to `{T1, T1C}` and cannot separate them, and the attachment decides
exactly two things — **which are precisely the two a capture cannot show:**

| what the attachment decides | residue |
|---|---|
| T1 vs T1C | **bookkeeping.** Same family, same concealment clause, same routing outcome; the cost is mis-attribution between two `corpus_matches` counters. |
| benign vs anomalous | **real.** A row routed BENIGN citing T1C whose true tail was arbitrary payload cannot be detected from the capture by any later reader. |

The second is **contained, not eliminated**, and the containment is that Factor
1 is an independent gate: an attacker-supplied whole message is attributable to
a fetch and routes ANOMALOUS regardless of Factor 2. That is the doctrine's own
*"neither factor subsumes the other"* doing its job. Read it as a bound on the
residue, never as its removal.

### Do not "fix" this by recording a derived witness

The appealing repair is to store a summary of the elided listing — its line
count, its tail bytes — so a later matcher can reconstruct enough to check.
**Rejected, and on a stronger ground than cost:**

> **A witness derived by the classifier cannot verify the classifier.**

The witness would be produced by the same agent, in the same turn, as the
`template_id` it would be checked against. Matching them establishes only that
the agent did not contradict itself. The circularity is **scale-invariant**, so
a cheap witness is no better than an expensive one — it cannot be rescued by
making it smaller.

It has already been tried informally, and the attempt demonstrates the failure.
A capture in this directory records its elision as ending with the marker line
*"which is the tail T1C specifies"* — a derived witness whose final clause
states its conclusion as evidence for itself. Storing that in a structured field
would change its formatting, not its epistemic status.

**Bytes are evidence; a summary of bytes is a second judgement.** This corpus
has no shortage of judgement. What it is short of is the ability to check
judgement against evidence, and a derived witness cannot supply that by
construction.

### This is not the #326 latitude returning

Head-matching is the exact latitude the #326 truncation attack exploited, so the
resemblance is worth naming rather than leaving for someone to notice. **No
latitude is added here.** #326 attacked the **templates** file — a truncated
prose prefix paired with a catch-all attachment — and is closed by two controls
over the *template*, both untouched: the `concealment_clause` requirement and
the attachment probe. This section concerns only the **capture-side** relation,
and describes matching that already ships.

## Never rewrite what is already here

`.operum/audit/*.jsonl` is `merge=union` in `.gitattributes`, so concurrent
branches union-merge instead of conflicting. Never resolve such a merge by
picking one side — the union is the correct answer for an append-only log. A
whole-file restore once destroyed three entries, and CI caught nothing, because
an append-only log has no append-only assertion. `check-audit-append-only.mjs`
now asserts it directly.

The older `../concealment-reminders.jsonl` is **frozen** where it exists. It is
read alongside this directory and is never written to, restored, or deleted.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
