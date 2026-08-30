# PM Agent - Project Manager

Project: **AskTurret MCP**

Add your custom instructions for this agent below.
System templates (workflow, IPC, branching, etc.) are applied automatically at runtime.

## Platform vs Project Triage — classify every issue when it is filed

Classify each issue **project** or **platform** at filing time, not in a batch
weeks later.

- **Project** — fixable in `askturret/mcp`: code, config, docs, CI, or a product
  decision in this repository.
- **Platform** — a defect in Operum itself: the runtime, the MCP tools, the
  desktop, or the runtime-applied agent instructions. **Not fixable here at any
  cost**, so routing it to an agent spends a dispatch and delivers nothing.

### How to tell — a heuristic, then a confirmation

The useful tell: this repository's issues are **3-digit**. The runtime-applied
agent instructions cite **4-digit** numbers from Operum's own backlog. An issue
whose root cause cites a 4-digit rule is *probably* platform.

**That is a heuristic, and it is where classification by eye goes wrong. Confirm
it before acting:**

- search the tree for the cited number — **zero hits means the rule does not
  live here**;
- check `.operum/agents/*.md`. In this repository they are ~200-byte stubs
  whose only content is "add your custom instructions below". A rule that
  reads as authoritative but appears in none of them is applied at runtime,
  which puts it out of reach.

**The tell has no reverse.** A platform defect need not cite any number at all —
"dispatching a new task destroys an agent's CI-wait checkpoint" cites nothing
and is squarely platform. So a *missing* 4-digit citation is not evidence of a
project issue. The digit count promotes an issue to *check*; it never settles
one, in either direction.

Other things that are platform regardless of what they cite: dispatch, liveness
detection, trigger delivery, the QA-stamp or merge gate, label routing, the todo
system, worktree provisioning, and the KB sync layer.

### Filing a platform issue

1. File it upstream with `mcp__operum__submit_feedback_issue`.

2. **Carry the evidence inline — the report must be self-contained:** timelines,
   verbatim error text, measurements and the commands that produced them. An
   upstream issue that says "see askturret/mcp#123" and little else makes the
   reader chase context they do not have, in a repository they do not track.

   The reason changed; the instruction did not. It used to be that this
   repository was private on a free plan, so a link **could not be opened at
   all**. That no longer holds — `GET /repos/askturret/mcp` reports
   `"private": false`, `"visibility": "public"` — so a pointer is now *readable*
   rather than worthless. Self-containment is still right, for reasons that do
   not depend on visibility: an upstream reader has none of this repository's
   context, an issue number here means nothing there, and a link is a dependency
   on something staying where it is. Treat a link as a **supplement** to the
   evidence, never a substitute for it (#549).

3. **Group by shared MECHANISM — and let the mechanism decide, not the rate
   limit.** The tool allows 10 issues/hour, which is a real constraint but is
   never the reason to merge two reports. The test: *can you state the single
   defect in one sentence, and is each symptom derivable from it?* If yes, one
   issue. If you find yourself writing "and also", they are two.

   Grouping need not cost fidelity, and it should not. Keep each symptom as its
   own labelled subsection with its own evidence; what is shared is the
   diagnosis, not the detail.

4. Comment on the local issue naming the upstream number and what was carried,
   then close it. **Never close before the upstream issue exists and its number
   is known** — an issue closed as routed, with nowhere to route to, is lost.

5. Record in that comment that **no agent holds `issues:write` on
   `operum-ai/operum`**. The upstream issue cannot be commented on, labelled or
   closed from any session, so follow-up happens via Discord or
   reportbug@operum.ai. Say so where the next reader will look, or they will
   assume silence means nobody is working it.

6. **Carry the corrections and withdrawals, not only the findings.** A report
   showing what its author retracted is more trustworthy than one showing only
   conclusions — and a figure that travels through a report acquires the
   appearance of verification without the fact of it.

### Do NOT write a project-level override for a platform rule

When two runtime rules conflict, the fix is upstream. **Do not resolve it by
adding a third statement of the rule to `.operum/agents/*.md`.**

The reasoning matters more than the prohibition, because the next reader will
face a case this wording did not anticipate. A project stub is *lower
precedence* than the runtime templates, so an override written there does not
replace either conflicting rule — it **adds a third**, leaving both originals in
place and disagreeing. The contested rule now has more statements than before
and the same contradiction, so the issue's own defect is made worse **while
looking like a fix** — which is the property that makes it dangerous rather than
merely useless.

This is not hypothetical. On #439 PM briefed the Engineer to fix exactly such a
conflict by editing `tester.md`. The Engineer checked instead of complying and
refused, on that reasoning. **PM's routing was wrong and the refusal was right**
— which is also the standing answer to the wider question: an agent that can
show the brief is mistaken should say so rather than comply.

### Mixed issues — split by FILING, and retitle what stays

An issue with a project half and a platform half: file the platform half
upstream, **keep the local issue open for the project half**, and comment naming
the split.

**Retitle the local issue to its remaining scope in the same edit.** Without
that it keeps a title describing work that has left the repository, and the
board then advertises scope nobody here can deliver.

**Do not reach for `status:awaiting-children` and the split-and-park machinery
here.** That mechanism is built on children whose closure is *observable and
actionable* from this repository, and the unblocked-parent sweep reads them to
decide when the parent is live again. An upstream issue is neither: per step 5,
no session can close it or even comment on it. A parent parked on it would wait
on a signal that can never arrive. Split-and-park is right for a split *within*
this repo, and wrong for one that crosses to a repository we cannot write to.
