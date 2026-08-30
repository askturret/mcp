# Repository ownership

How review responsibility is split across this repository, why it is split
where it is, and how to take on an area (§12.4).

The machine-readable half of this document is
[`.github/CODEOWNERS`](../.github/CODEOWNERS). If the two ever disagree, the
CODEOWNERS file is what actually routes a review — treat the disagreement as a
bug and say so.

## Governance: informal, founder-led

There is no steering committee, no BDFL title and no foundation. Decisions are
made by the founder, in the open, on issues and pull requests.

That is a deliberate choice for a project at this stage rather than an
oversight. A governance model exists to resolve disputes between maintainers,
and a project with one maintainer has none to resolve — writing the constitution
first would be ceremony that constrains the people who eventually arrive without
having helped anyone in the meantime.

**We will revisit this as the project grows.** The trigger is people, not time:
once more than one person is regularly reviewing in an area they do not own,
the informal model has stopped describing reality and should be replaced by one
that does.

Contributor licensing is a separate question and is not covered here — this
project uses DCO sign-off, documented in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## The boundaries

| Area | Owns | Why it is its own boundary |
|---|---|---|
| `packages/core/` | compiler, dispatcher, policy, presets, audit, redaction | Everything depends on it. A change here reaches every package and every adopter. |
| `packages/transports/` | the MCP wire contract | Visible to clients we do not control, so a change is not ours to take back. |
| `packages/sources-openapi/` | spec discovery and schema handling | Reads untrusted third-party documents; the failure modes are parsing ones. |
| `packages/adapters-*/` | framework integration | Must stay interchangeable — see **Adapter contributions** below. |
| `packages/explorer/` | the operator-facing UI | Renders adopter data in a browser; the risks are disclosure and injection. |
| `packages/observability/`, `packages/reliability/` | telemetry and resilience | Behaviour under failure, which is hard to review from a diff alone. |
| `examples/`, `packages/examples/` | worked examples | Shared ownership, lightest review. |
| `packages/adapter-conformance/`, `packages/adapter-test/` | the conformance contract | Held apart from adapters — see **Separation of duties**. |
| `packages/gateway/` | the standalone deployment | A container and a published binary, so it carries release-surface risk libraries do not. |
| `packages/cli/` | operator tooling | |
| `.github/`, `.gitattributes` | CI, guards, merge behaviour | The gates every other boundary relies on. |

The split follows **blast radius and failure mode**, not lines of code. Two
packages of similar size sit in different boundaries when a mistake in one is
recoverable and a mistake in the other reaches an adopter's production.

### Separation of duties

`packages/adapter-conformance/` and `packages/adapter-test/` are deliberately
**not** owned by adapter owners.

Those packages define the contract that gates adapter contributions. An adapter
owner who also owned the bank could weaken the test that governs their own
work — not maliciously, just by being the person best placed to judge that a
failing assertion is "wrong" and least placed to be objective about it.

Today one person owns everything, so this separation is a formality. It is
written down now because it is the kind of structure that is impossible to
retrofit: once someone owns adapters, telling them they may not also own the
bank is a demotion, whereas the boundary existing beforehand is just the map.

## Adapter contributions need two things

An adapter change — to `packages/adapters-*/`, or a new adapter — requires
**both**:

1. **An approving review from the adapter owners**, routed by CODEOWNERS.
2. **A green conformance-kit run**, enforced by CI.

Neither substitutes for the other, and that is the point.

The conformance kit proves an adapter behaves identically **at the wire** —
discovery, schema preservation, context propagation, cancellation, error
mapping, authorization context, lifecycle cleanup, duplicate handling. It cannot
judge whether an adapter is idiomatic for its framework, whether it leaks scope
into a host application, or whether its options mean the same thing as its
sibling's. A human owner cannot check the eight categories by reading a diff.

So: CI enforces the run, an owner enforces the judgement.

Run it yourself before opening the PR — `npx @askturret/mcp-adapter-test
./my-adapter` — and see [`docs/adapters.md`](adapters.md) for the public
conformance table and how to add yourself to it.

> **Note.** The conformance kit is not published to npm yet, so that command
> does not resolve today; run it from a local checkout in the meantime. Tracked
> in [#173](https://github.com/askturret/mcp/issues/173).

## Becoming a maintainer

There is no application form, and no invitation-only list.

**What actually happens:** you review other people's changes in an area, and
your reviews turn out to be right. Not "you shipped a big feature" — writing
code and being trusted to judge someone else's are different skills, and this
document is about the second one.

Concretely, we will offer you an area when:

- **You have contributed to it substantively** — enough changes that you know
  where the sharp edges are, rather than one large PR.
- **You have reviewed in it** — on other people's PRs, catching things that
  mattered. This is the strongest signal, and the one most people skip.
- **You have shown the failure mode of the area.** For `core/` that is knowing
  what a change breaks three packages away. For `transports/` it is knowing
  which changes clients cannot absorb. For `adapters/` it is knowing what
  conformance does *not* cover.
- **You are around.** Ownership is a commitment to respond, not a badge. An
  owner who cannot review is worse than no owner, because CODEOWNERS will route
  to them and the PR will sit.

Then: open an issue saying which area and why, or say so on a PR. The founder
adds you to `.github/CODEOWNERS` and grants write access. Both are needed —
**a CODEOWNERS entry for someone without write access is silently ignored by
GitHub**, so the file would claim an owner the repository does not route to.

**Stepping back is fine and carries no stigma.** Open a PR removing yourself.
An out-of-date owners file is a worse outcome than a smaller one, because it
looks like coverage that is not there.

## What CODEOWNERS does and does not do

It **routes review requests**. Whether it also **blocks a merge** is a separate
question with a specific answer today, and the answer is no — see below.

It does **not**:

- prevent anyone from *editing* a file — it is review routing, not permissions;
- guarantee an owner has write access — GitHub ignores entries for users who do
  not, without reporting it;
- express "needs an owner **and** a green conformance run" — that lives in this
  document and in CI, because the format has no way to say it.

`.github/scripts/check-codeowners.mjs` runs in CI and fails if a pattern in the
file matches **no tracked path** — a dead rule that routes nothing while looking
like coverage. It also fails if a package under `packages/` has no rule of its
own, so adding a package forces an ownership decision rather than letting it
fall silently to the catch-all.

It cannot check the permissions half. Nothing in the repository can.

## What this file does and does not gate today (#330)

The repository is public and a branch ruleset requires 1 code-owner approval, so
these rules are honoured by GitHub — where previously the plan tier meant they
were not. They nonetheless gate **no PR authored in this repository today**, for
two independent reasons, either alone sufficient:

1. **Self-authorship.** GitHub never requests review from a PR's own author, and
   every PR here is authored by the same account that owns every path.
2. **Bypass.** That account is an `always` bypass actor on both rulesets, as are
   organisation admins and the admin role. The rule does not apply to it even
   when an approver exists.

So CODEOWNERS is **structure for future maintainers, not a control on today's
changes**. Adding a second owner fixes (1); removing the bypass entry fixes (2);
**both are required** before any claim of enforced review is true.

### Why this section names conditions instead of a status

The sentence above used to read *"when branch protection requires owner
approval, blocks merge without one"*. That was safely hypothetical when written
and became misleading the morning the ruleset was added: **the antecedent turned
true and the consequent was false.** Nobody edited the file; the world moved
underneath it.

That is the failure this section exists to avoid, so it states conditions rather
than a status. *Dormant* and *live* are each one platform setting away from being
false, and neither can be re-checked by a reader. Each clause above can: it names
what is true, and what specifically would change it.

The conditions are also **independently verifiable** — `GET /repos/askturret/mcp`
for visibility, and `GET /repos/askturret/mcp/rulesets/{id}` for the approval
requirement and the bypass list. Nothing here asks to be taken on trust.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
