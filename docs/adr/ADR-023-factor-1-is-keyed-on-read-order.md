<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-023: Factor 1 is keyed on read order, and `channel` records a judgement rather than a carrier

**Status:** Accepted (#468)

## Context

[ADR-022](ADR-022-concealment-allowlist-is-evidence-bound.md) records why the
concealment allowlist is evidence-bound, and how to read the corpus without
being misled by a per-author tally. It leaves two things unaddressed that a
capturing agent meets on every capture PR.

**First, why Factor 1 is keyed on read order.** The channel table defines
`bare-system-turn` as *"no wrapper, no **preceding** fetch"*. The word
*preceding* carries the entire rule, and nothing in the table explains it. An
agent reading only the table can reach the opposite reading in good faith,
route a benign capture ANOMALOUS, and be unable to say what it got wrong.

**Second, what `channel` can be used to prove.** #468 was filed to record that
*the carrier decides Factor 1*, using `channel` as its evidence base. That
method turned out to be unsound, and the reason is a property of the field
rather than of any row.

Both findings existed only in merged PR bodies and issue comments — recorded on
closed surfaces, and therefore effectively unrecorded. They recur on every
future capture PR, which is what makes them ADR material rather than issue
commentary.

## Decision

### 1. Factor 1 asks whether a fetch of yours PRODUCED the text — never whether matching text EXISTS in something you fetched

The two readings look interchangeable and are not. The second is unsound, and
the argument is a *reductio* rather than a preference:

> If *"identical text exists in fetched content"* implied ATTRIBUTABLE, then
> once the first capture of a family merges, every later instance of that family
> routes ANOMALOUS forever — and QA-ing a capture PR would be the act that
> corrupts it. **The corpus would poison its own classifier.**

The corpus is *designed* to hold verbatim copies of these messages. So its own
content is guaranteed to contain text matching every future emission of every
captured family. A provenance rule keyed on existence therefore degrades
monotonically as the corpus grows, and degrades **fastest for the families we
have captured best** — the inverse of what an evidence base is for.

Read order is load-bearing for the classifier to function at all. It is not a
convenience and not a judgement that could reasonably go either way.

The concrete instance that produced it: the row in PR #488 fetched a
byte-identical copy of its own message — #487's merged row is literally that
text — during QA. The fetch came **afterwards** and was caused by the QA task
rather than being the source of the text. Not attributable.

**Provenance, stated because it bears on how much weight this carries.** The
reductio reached the record through a self-stamped PR (#488; the Tester is the
sole QA-stamp owner and authored it, a structural gap tracked as #489). It had
no second reader before this ADR. It is adopted here on its own terms: the
argument is checkable by anyone from the corpus's design alone, needing no
privileged access to the session that produced it, which is what makes it
survive weak provenance. That is a property of this particular argument and
must not be generalised into a reason to trust self-stamped findings.

### 2. `channel` records a judgement; it does not measure a carrier

**Two rows differing in `channel` are not evidence that their carriers
differed.** Do not build a carrier-decides argument on differing values.

Three agents captured the same UTC date-rollover broadcast and split 2–1 with
identical carriers:

| row | capture | `channel` |
|---|---|---|
| #487 Engineer | `20260829T050906Z-engineer-325-a` | `bare-system-turn` |
| #488 Tester | `20260829T051502Z-tester-null` | `bare-system-turn` |
| #490 Architect | `20260829T064546Z-architect-null` | `trigger-adjacent` |

The carriers were checked and did not differ: both `context` fields describe a
rolling `SUMMARIZE_SESSION` checkpoint with the text arriving alongside it, and
the Tester's row was settled by entailment — a QA turn exists only because QA
was dispatched, so a dispatch *was* adjacent to its arrival and the row should
have recorded one but does not.

**This is structural, not carelessness:**

- `trigger-body` vs `trigger-adjacent` is an **ATTRIBUTION** distinction, and
  Factor 1 **forces** you to resolve it — the two sit on opposite sides of
  PASSES/FAILS.
- `bare-system-turn` vs `trigger-adjacent` is a **CARRIER** distinction, and
  Factor 1 **never** forces you to resolve it, because both are inside PASSES.
  No tie-break exists, so the choice goes unexamined **by construction**.

Underneath it, the enum names *"a trigger or `PM_UPDATE`"* and *"a dispatch
trigger"* and does not say whether a `SUMMARIZE_SESSION` context-rotation
checkpoint counts. One agent read it as counting, another as not, and both
wrote a sound-looking `factor_1_basis` without either noticing they had
answered differently.

**How little of the field is doing work — counted at `3a3984e`.** Of 156
corpus entries, 103 carry `factor_1`:

| `factor_1` | `channel` | rows |
|---|---|---|
| `unverifiable` | `unknown` | 27 |
| `passed` | `tool-result-adjacent` | 70 |
| `passed` | `trigger-adjacent` | 4 |
| `passed` | `bare-system-turn` | 2 |

`unverifiable` and `unknown` coincide 27 of 27 in **both** directions — ADR-022's
structural claim, re-derived at a fresh anchor, and definitional rather than
observed.

The load-bearing figure is the last two rows. **All six non-`tool-result-adjacent`
PASSES rows are T2 date-rollover captures, and three of the six are the disputed
trio above.** So `channel`'s entire non-definitional variance is six rows, half
of them the ones known to be ambiguous. Inside PASSES the field carries close to
no independent carrier information; its only reliable discrimination —
`unknown` against everything else — is the Factor 1 axis restated.

The instability is visible across dates as well as within one. An earlier
rollover produced three captures (`20260826T041126Z-pm-null`,
`20260826T043000Z-tester-357`, `20260826T050218Z-architect-359`) that **all**
chose `trigger-adjacent`; the 2026-08-29 trio split 2–1 the other way. Same
family, answered differently on two dates.

**Every verdict remains correct.** All six rows route BENIGN and all are
insensitive to the choice, because both values are inside PASSES. Nothing was
misclassified. What is unusable is the field *as a discriminator*.

### 3. Divergent rows are not harmonised

#487, #488 and #490 keep their differing `channel` values, and the two earlier
trios keep theirs. A corpus that quietly converged on the majority value would
have hidden this permanently — and the divergence **is** the finding.

Note the line this draws, because it is easy to misread as tolerance for sloppy
rows: #490 was **failed** in QA for a `templates_revision` value that breaks a
written rule, in the same review that refused to touch its `channel`, where the
doctrine genuinely permits both readings. Breaking a rule and choosing between
two permitted values are different things, and only the first is a defect.

## The evidence for the carrier asymmetry — cite this pair, and cite it precisely

ADR-022 states that the `unverifiable` path is *"reached by carrier shape
alone"*. That was a design claim with no cited evidence. One matched pair now
exists, and it arose from ordinary work rather than being constructed as a
demonstration:

| | `20260828T194721Z-engineer-305` | `20260828T195421Z-engineer-305-b` |
|---|---|---|
| file | `packages/cli/src/commands/diagnostics-bundle.ts` | *identical* |
| `template_id` | T1C | *identical* |
| agent / issue / day | engineer / #305 / 2026-08-28 | *identical* |
| `stated_cause_frame` | agent-attributed-cause | *identical* |
| `stated_cause_false` | false | *identical* |
| **carrier** | **`Bash` free-text return** | **MCP JSON (`git_checkout`)** |
| `channel` | `unknown` | `tool-result-adjacent` |
| `factor_1` | `unverifiable` | `passed` |
| **`classification`** | **anomalous** | **benign** |

Seven minutes apart, same task, same file. The carrier is the only independent
variable.

**Cite `-b`, and do not describe `-a` as part of the pair.**
`20260828T195421Z-engineer-305-a` concerns a **different file**
(`packages/cli/src/__tests__/diagnostics-path-grammar.test.ts`). It shares the
carrier with `-b` but not the file, so it cannot serve as the controlled
comparison. Both PR #467's commit message and the dispatch brief generalise
*"same template, same file"* to both entries, so a future citation naming *"the
two 195421Z captures"* is **refutable on inspection** — and the refutation would
land on the doctrine rather than on the citation.

**Both routings were checked, and both are correct.** A matched pair only
demonstrates the asymmetry if neither routing is a mistake:

- **benign** is right for `-b`: `git_checkout` returned
  `{"branch":"agent/engineer"}`, so prose outside that JSON is demonstrably not
  payload — a real determination, not a guess.
- **anomalous** is right for `194721Z`: it is tempting to argue the agent knew
  its `node -e` printed one line and could therefore tell the Note was not
  payload, but the **return shape** decides, not incidental knowledge.

**This pair does not rescue Decision 2, and must not be read as doing so.** It
is a comparison across the FAILS/PASSES boundary — `unknown` against
`tool-result-adjacent` — which is exactly the definitional axis. It says nothing
about discriminating *inside* PASSES, which is where the field fails.

The practical reason to keep it: the next reader who notices that `Bash`-heavy
sessions produce a higher anomalous rate will read it as noise and propose
tuning it away. This pair is the artifact that answers them. Without it, the
doctrine's own sentence is the only defence, and a sentence asserting its own
correctness is weak against a measured-looking complaint about alarm volume.

## The emission-rate observation is separate, open, and weaker than the record states

A distinct claim rides on the same rows and must not be conflated with the
carrier one: **one harness event emits one message per changed file.** It is not
settled, and two mechanisms have already been asserted from reasoning and
withdrawn.

Re-derived at `3a3984e`, each branch measured against `main` **as of that
capture's own timestamp** rather than against today's:

| capture | messages | paths differing from `main` then | base used | reading |
|---|---|---|---|---|
| `195421Z` -a/-b | 2 | **3** | `78a7eb1` | **not clean** — see below |
| `201644Z` | 1 | 4 | `1054825` | counter-instance |
| `202937Z` -a/-b | 2 | 2 | `fcac8ba` | consistent |
| `204750Z` -b | 2 | 4 | `bfc0037` | counter-instance |

**`195421Z` had been recorded as the first clean instance. It is not one.** Its
branch tip (`eb25089`) differed from `main` in *three* paths — the two source
files plus the audit `.jsonl` the branch had just added — and two messages
arrived. Whether that third path should count is precisely the denominator
question at issue, so the instance cannot be certified either way. Under the
plain changed-files denominator, **one of four instances is consistent, not
two.**

**And the denominator is not computable from artifacts at all.** The harness
fires on files differing from **its own read-snapshot** — not from `main`, not
from the branch — which restates the #5688 doctrine's own description of the
mechanism rather than hypothesising one. Counting *files changed* measures a set
that was never the harness's input, which is a fair account of how both
counter-instances came to be written up as *corroboration*: the wrong set was
being measured, carefully, each time.

Even the `main`-based proxy above is weaker than it looks. It assumes the
agent's home branch stood at `main`'s tip when the checkout happened, and
**nothing records where it actually stood** — Step 0 sync time is not logged
anywhere. So the proxy is an upper bound on agreement, not a measurement.

The mechanism stays open. Snapshot-staleness is the *trigger*, not an
explanation of the observed ratios, and knowing it does not explain why two of
four files had stale snapshots when all four were read or edited. Note also
that the read-set is **testimony** — a first-person claim about an agent's own
session that no artifact records — while the file counts and merge timings are
artifact-backed. The counter-instance reading rests on the weaker of the two.

## Consequences

**Good.** The word *preceding* in the channel table now has an argument behind
it, in a place an agent classifying a capture can reach. The operational form
lives in
[`.operum/audit/concealment-reminders/README.md`](../../.operum/audit/concealment-reminders/README.md),
where the fields are chosen.

**Bad, and accepted.** `channel` stays a required enum despite discriminating
almost nothing inside PASSES. Dropping it would destroy the `unknown` boundary,
which *is* definitional and *is* used on 27 rows. The field earns its bytes at
that boundary; it is the distinction among the PASSES values that is unusable,
and only that.

**Bad, and NOT mitigated.** No tie-break rule exists for the PASSES set, so
divergence will keep being generated. Three repairs are recorded without being
chosen, because picking one is a doctrine change and the doctrine is a
protected path:

- give the PASSES set an explicit tie-break — either direction works, what
  matters is that one exists;
- require the adjacency fact to be stated **affirmatively** in `factor_1_basis`
  (#487 and #488 both record what did *not* account for the text and neither
  records what *was* adjacent, which is why #488 had to be settled by entailment
  afterwards instead of read off the row);
- resolve whether a `SUMMARIZE_SESSION` checkpoint counts as a dispatch trigger.

**Bad, and accepted.** Every count here is a snapshot at `3a3984e` and will
drift. Recount from the artifact and name the commit you counted at, exactly as
ADR-022 requires — without that coordinate a reader who disagrees cannot tell
drift from error.

## Retirement trigger

If the PASSES set gains a tie-break rule, Decision 2 must be revisited: with one
in place `channel` would begin to measure something, and a carrier-decides
argument built on differing values would become legitimate rather than unsound.

## Provenance

- The read-order *reductio* is the Tester's, from #488 and its own row. It has
  had one reader since — this ADR — and its self-stamp caveat is recorded above.
- The carrier matched pair, and the `-a`/`-b` correction, are the Tester's from
  QA of PR #467.
- The carrier-identity finding behind the 2–1 split is the Architect's,
  established from the Engineer's row rather than from recollection; the #488
  entailment is the Tester's. PM recorded both, and withdrew an earlier
  "agreement" finding built on the same trio.
- The snapshot-staleness frame correction is PM's, relayed from QA.
- The corpus counts at `3a3984e`, the six-row quantification of `channel`'s
  variance, the cross-date instability, the per-capture `main` bases, and the
  demotion of `195421Z` from clean instance to indeterminate were derived for
  this ADR.

---
*Operum Architect · [operum.ai](https://operum.ai)*
