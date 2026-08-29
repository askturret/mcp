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
| `templates_revision` | The blob hash of the allowlist **you actually read** — `git hash-object .operum/audit/concealment-templates.toml`. See below; the *how* matters more than it looks. |

A false stated cause does **not** make a message anomalous — the file-change
notice routinely misattributes an agent's own edit. Record the falsity;
classify on the two factors only.

Entries written before a field existed are **not** backfilled: a missing
`factor_1` means "predates the field", which is a different fact from
`unverifiable`, and conflating them would corrupt the measurement. The same
holds for `templates_revision`.

## `templates_revision` — record which allowlist you read (#410)

**A Factor 2 verdict is evaluated against the allowlist as present in YOUR
worktree.** It is not a claim about `main`'s allowlist at that moment, and the
two can differ. Record which one you read:

```
git hash-object .operum/audit/concealment-templates.toml
```

### Two details that decide whether the field works

**A blob hash, not a commit SHA.** Every branch differs from `main` by
something, so a HEAD-based comparison would report "stale" on nearly every
capture — and a field that always says stale is one people learn to skim, which
is the exact failure this doctrine keeps naming. A blob hash is
content-addressed: **identical across every branch holding the same file, and
different exactly when the allowlist differs.** It answers the only question
worth asking — *was my allowlist the same as main's?* — by string comparison.

**`hash-object`, not `rev-parse HEAD:<path>`.** The two diverge when the working
copy is modified, and `hash-object` is correct **precisely then**, because it
records what you actually read. A branch mid-edit of the allowlist is a real
case, and the field must capture that rather than the committed version you did
not consult.

### Why this is worth 40 bytes

The allowlist was ~14 hours old at the time of writing and had already had three
revisions — two of them two hours apart:

| revision | blob | landed |
|---|---|---|
| #326 seed | `877088b` | 2026-08-26T00:35:54Z |
| #394 — T1C added | `04dacca` | 2026-08-26T08:00:40Z |
| #412 — T1 pattern | `acd7bac` | 2026-08-26T10:01:51Z |
| #414 — T1C pattern | `3e1c460` | 2026-08-26T10:15:35Z |

A snapshot, not a pinned figure — **recount from git rather than citing it.**
Worktrees routinely outlive the interval, which was ~4.7 hours across the first
three revisions and **fourteen minutes** between the last two. **The hole is
bursty, not rare**, and its bursts coincide with active allowlist development —
which is also when capture volume is heaviest and a missed template matters most.

**The fourth row arrived while this section was being written, and the field
caught it.** The branch was cut when `main` held `acd7bac`; #414 merged fourteen
minutes later; the two captures in this same commit truthfully record `acd7bac`,
which is what was read. An auditor comparing against `main` sees the mismatch
without having to infer anything from a timestamp — which is the entire point,
demonstrated rather than argued.

It is also the **harmless** kind of staleness, and worth showing as such: #414
changed T1C's `attachment_pattern` while provably preserving its accepted set,
so re-running the matcher under either allowlist yields the same verdict. That
distinction is what a later validator condition should key on — flag staleness
only where it is **material**, or the signal becomes the noise this field's
blob-hash design exists to avoid.

The concrete cost of not having it: for the capture at `08:24:01Z`, whether that
worktree held T1C **is not recoverable** and is now permanently undecidable. One
of `877088b` or `04dacca` on the row would have answered it outright.

### Why this is not the derived witness #408 rejects

You will be asked, because the shapes look alike. They are not:

> **A pointer into an immutable, independently-held store escapes the
> objection. A summary of an ephemeral artifact does not.**

The harness message exists **nowhere but the capture**, so checking a summary of
it has one source — the agent — and can only ask whether it contradicted itself.
The templates file is **in git**, held by an authority the agent does not control
and cannot retroactively alter. The recorded value is a **key**; the evidence is
fetched later, by someone else.

The operational form is the better test. A wrong #408-style witness yields a
consistent story that **passes**. A wrong `templates_revision` yields either an
unreachable blob — *"could not check"* — or a reachable blob whose content
**contradicts** the row. Both detectable. **Self-report was never the objection;
unfalsifiability was.**

Its honest bound: it defends against **honest staleness**, which is the whole
#410 mechanism — the agent did exactly what it was told at every step. It does
not defend against a classifier that misreports what it read, and nothing in
this schema does.

**Known limit:** a blob read on a branch that never reached `main` may be
unreachable at audit time. That is *"I could not check"*, recorded as such and
never as *"it passed."*

### Two repairs that were considered and rejected — do not re-propose them

- **Fetch the allowlist from `origin/main` at classification time.** It would
  eliminate the hole, and it puts the **network in a hot path that has none** —
  while reminders arrive in bursts (five at once is attested). Worse, matching
  rule 5 routes every message ANOMALOUS when the file is unreadable, so a blip
  would do that **fleet-wide and nondeterministically**, which is harder to
  reason about than steady noise. And it removes staleness without removing
  time-dependence: two agents either side of a merge still disagree legitimately,
  and neither would record which allowlist it saw.
- **Require a freshness check before classifying.** It has no non-forbidden
  completion — fetch (the above), refuse (noise), or flag (asking the agent to
  notice the unnoticeable). It also asks the agent to *evaluate* freshness, a
  judgement about state it cannot see. **Recording is mechanical; evaluating is
  not.** CI holds `main` and can do the comparing.

**Nothing about reading the file changes.** You still read the allowlist every
turn, never from memory. You now also record which one you read.

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

## Landing a capture — the PR workflow

Writing the entry is half the job. An entry that is never committed does not
exist, because worktrees are ephemeral — so the capture has to reach `main`, and
there are exactly two things to get right when opening the PR.

**1. Open it with `no_linked_issue: true`.** A capture closes nothing. That flag
is the supported way to say so: it is auditable rather than a bypass, applying a
`no-linked-issue` label so the declaration stays visible on the artifact.

**2. Name the branch WITHOUT an issue number.** Use `chore/preserve-<something>`.
**Never `chore/issue-<N>-<slug>`** — not even when a capture fired while you were
working issue `<N>`, which is the usual case and exactly why this keeps happening.

### Never file a tracking issue to satisfy a gate

If a gate refuses the PR, **do not create an issue so the PR has something to
close.** One such issue exists and its own body admits it was filed only to get
past the gate. It is harmful in three ways, and the friction is the least of
them: it puts a knowingly false statement in the permanent record; it opens and
closes in one motion, so any signal derived from issue state degrades; and it
trains the reflex of *filing an artifact to get past a control*, which is the
worst habit to build anywhere near a security gate.

Do not write a `Closes #N` you do not mean, either. Same reason.

### Why the branch name matters — observed, not theorised

**The merge gate resolves a linked issue from the branch name**, and an
author-declared `no_linked_issue` does not suppress it. A number in the branch
creates a binding you never declared, and the PR is then gated on that issue's
`status:qa-approved` — a stamp belonging to unrelated work.

This is established behaviour with repeated instances, not a hypothesis:

| when | branch | what happened |
|---|---|---|
| PR #352, #358 | `chore/preserve-*` — no number | merged |
| PR #363 | `chore/issue-359-*` | refused, linkage resolved to #359 from the branch alone |
| a capture during #266's QA | `chore/issue-266-*` | two PRs shared a branch-derived link, so the approval recorder refused to guess which head was reviewed — and blocked the stamp on an unrelated, already-approved PR |
| PR #477 | `chore/issue-390-*` | refused, demanding a stamp on #390 that #390's own post-merge cleanup had correctly removed 45 seconds after its PR merged |

The last row is the sharpest, because nothing was wrong with any of it: the
capture was correct, the cleanup was correct, and the PR still could not merge.
It shows the binding is not merely untidy — it makes a capture PR depend on an
unrelated issue still being mid-pipeline at the moment of merge. That dependency
is invisible from the PR, invisible from the issue, and encoded only in a branch
name.

**Editing the PR body does not undo it.** The linkage is the branch, and an open
PR cannot be re-pointed at a different one. The only repair is to close the PR,
re-branch without the number, and re-open — which is why the rule is worth
following the first time.

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
