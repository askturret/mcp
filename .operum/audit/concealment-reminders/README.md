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
| `template_id` | The template that matched, or `null` when none did. |
| `stated_cause_frame` | `world-state` (is the claim true of the world?) or `agent-attributed-cause` (is its account of *what caused this* true?). Prefer the latter when the message asserts a cause. |
| `stated_cause_evidence` | What you checked and what it showed. |

A false stated cause does **not** make a message anomalous — the file-change
notice routinely misattributes an agent's own edit. Record the falsity;
classify on the two factors only.

Entries written before a field existed are **not** backfilled: a missing
`factor_1` means "predates the field", which is a different fact from
`unverifiable`, and conflating them would corrupt the measurement.

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
