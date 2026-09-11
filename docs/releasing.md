# Releasing

How a release is cut, what each step is allowed to assume, and — stated as
plainly as what *is* enforced — what nothing checks.

This page **references** two documents rather than restating them, because a
copy would be wrong within one release and would create two places to update:

- **[Compatibility and deprecation policy](compatibility-policy.md)** — which
  surfaces semver governs, which it does not, and how the policy itself may
  change. It decides what your version number is *allowed* to be.
- **[CHANGELOG.md](../CHANGELOG.md)** — entry format, and the rule that a
  `Changed` or `Removed` entry names the covered surface it touches.

> **The automated `npm publish` has never been confirmed to have published
> anything.** Every npm publish this project has made was performed by hand. The
> earlier legs of step 4 have been observed working — a published Release does
> fire `supply-chain.yml`, and CI does attach the SBOM — but the leg that puts a
> tarball on the registry has not, so that is the one this page cannot vouch for.
>
> **This claim expires the first time a run is observed publishing**, and
> whoever observes it is the one to remove it. Until then, confirm a publish
> against `registry.npmjs.org` rather than against the workflow's own success
> message, and see
> [Rehearsing before it matters](#rehearsing-before-it-matters).

---

## Order of operations

1. **Land the version bump and the CHANGELOG entry through a PR to `main`.**
   Both files are covered by the ordinary review path; neither is edited on a
   tag or on a release branch. The version you choose is the compatibility
   policy's call, not this document's.
2. **Tag the merge commit.** Annotated and signed — see
   [Signing](#signing-and-provenance-cover-different-things). Tagging is a
   local, reversible act and nothing ships because of it.
3. **Publish a GitHub Release from that tag.** *This* is the step that ships.
4. **`release: published` triggers `supply-chain.yml`**, which runs licence
   review, SBOM generation, the readiness matrix, and then publishes to npm.

Steps 1–3 are human. Step 4 is entirely automated, which is why step 3 is the
step worth controlling.

---

## The privileged action is publishing the Release, not tagging

**Anyone who can push can tag.** A tag is one command, it can be deleted with
another, and in this repository it triggers nothing that ships. Restricting tag
creation would be security theatre: it would look like a control while leaving
the act that actually publishes artifacts wide open.

Publishing a Release fires an automated `npm publish` to a public registry.
That is irreversible in practice — npm's unpublish window is narrow and
deliberately hard to use. So the restriction belongs there:

> **Restrict who may publish a GitHub Release** — via a repository ruleset or a
> deployment environment with required reviewers on the release event. Do not
> restrict tag creation and call it a release control.

This is a deliberate inversion of the arrangement this document replaces.
`readiness.md` previously claimed the release process "refuses to tag `1.0.0`
if any row is red". That was false twice over: no workflow here had a tag
trigger at all, and even a tag-triggered workflow **cannot refuse a tag**,
because GitHub Actions runs after the ref already exists. A workflow can fail a
run; it cannot un-create the thing that started it.

**That inertness is measured rather than assumed, and it is contingent.** Both
halves were read from source on 2026-09-04. No publishing path carries a `tags:`
trigger — `supply-chain.yml` fires on `pull_request`, `push` to `main`,
`release: published` and `workflow_dispatch`, and the only workflow with a
`tags:` trigger is `tag-readiness-advisory.yml`, which ships nothing. And
`GET /repos/askturret/mcp/rulesets` returned two active rulesets, **both**
`target: branch` — there is no tag ruleset.

**The two facts hold each other up.** Tag creation is left unprotected *because*
tagging ships nothing. Add a `tags:` trigger to a publishing path and the
argument above does not merely weaken, it **inverts**: an unprivileged act would
publish to a public registry. So such a change must land a **tag ruleset in the
same commit** — the gap between the two is the exposure. #622 proposed exactly
that trigger and was refused on this evidence rather than on preference.

**Nothing enforces that.** No guard under `.github/scripts/` reads workflow
`tags:` triggers, and none looks for a tag ruleset — so the sentence above is an
instruction, not a guarantee, and it holds only if whoever adds the trigger
reads this paragraph first. Said plainly because a rule with no guard behind it,
left unmarked in a passage about what is merely measured, would be the same
defect this passage exists to record.

**Both readings are re-runnable, and this passage is false the moment either
answer changes.** Re-read the trigger blocks under `.github/workflows/` and the
rulesets endpoint above; whoever changes one of these facts is the person
holding the other.

---

## What is gated, and what is not

### Gated

| Act | Gate | Where |
|---|---|---|
| `npm publish` | licence review + NOTICE freshness + SBOM generation | `publish` job `needs: [supply-chain, …]` |
| `npm publish` of a **`>= 1.0.0`** release | readiness matrix, all 12 rows `✅ met` | `publish` job `needs: [… , readiness]` |
| Opening or updating a PR to `main` | readiness matrix, at commit time | `test-integrity` job in `test.yml` |

The last row says *pull request*, not *merge*, and the distinction is real:
`test.yml` stopped running on `push: main` in #687 change 3, so the matrix is
evaluated on the PR's tree before the merge rather than on the merged tree
after it. It also does not block anything on its own — this repository has no
required status checks (#647).

The version is parsed from the release tag. A tag whose version cannot be
parsed is treated as `>= 1.0.0` and therefore **blocks** — the safe direction,
since a release whose version is unreadable is not one to ship on an unchecked
matrix.

### Not gated

- **Creating a tag.** Nothing blocks it, and nothing can. The
  `tag-readiness-advisory.yml` workflow runs the matrix on `v*` tags and writes
  the verdict to the job summary — so whoever is about to publish a Release
  sees red *before* clicking rather than after. It is **advisory**: it does not
  block the tag, it does not block the Release, and a red run there refuses
  nothing.
- **Publishing a `0.x` release over a red matrix.** Deliberate. `readiness.md`
  certifies *1.0* readiness, and the compatibility policy is explicit that
  `0.x` carries no compatibility guarantee at all. The readiness job still runs
  on a `0.x` release and still reports the verdict in its summary — it just
  does not block. A `0.x` release may ship red, but not quietly.
- **The contents of the CHANGELOG.** No job verifies an entry exists or matches
  the change. It is a review responsibility.

---

## Signing and provenance cover different things

They are easy to conflate, and neither implies the other:

- **A signed, annotated tag** attests *intent*: a specific human asserted that
  this commit is the release. It says nothing about what was built from it, and
  nothing about what reached npm.
- **npm `--provenance`** attests *build origin*: it links the published tarball
  to the workflow run that produced it, so a consumer can verify the artifact
  came from this repository's CI rather than from someone's laptop. It says
  nothing about whether a human intended that release.

Provenance requires `id-token: write`, which the `publish` job declares. Tag
signing is a local git configuration and is not enforced by CI — a release cut
from an unsigned tag will publish exactly as readily. That is a gap worth
knowing about rather than assuming closed.

---

## Rehearsing before it matters

The `npm publish` at the end of the path above has never been observed running.
Two of its steps were **broken** until this document was written, and neither
failure could have been observed without running it:

1. The `supply-chain` job runs `gh release upload`, which needs
   `contents: write`. The job inherited the workflow-level `contents: read` and
   declared no permissions of its own, so the SBOM upload would have failed
   with a 403 on the first real release.
2. Every workspace package was `"private": true`. `npm publish --workspaces`
   **skips** private packages with a warning and exits `0` — so the publish job
   would have reported success having published nothing.

Both are fixed. The point of recording them here is that a release path whose
publish step nobody has watched run is not a release path yet, it is an untested
one.

**Rehearse with `workflow_dispatch`.** `supply-chain.yml` already accepts a
manual trigger, which runs licence review, NOTICE checking and SBOM generation
against the real tree without a release existing. Run that first.

Then cut a real `0.x` release as the rehearsal — `0.x` is exactly the version
range the readiness matrix treats as advisory, so a mistake there cannot be
blocked by a gate you were trying to test, and the compatibility policy makes
no promises about it. Confirm, on the run itself rather than by reading this
page:

- the SBOM is attached to the Release as an asset (proves fix 1),
- `npm publish` reports a **non-zero** package count (proves fix 2),
- the readiness job appears in the graph and reports its verdict,
- the published tarballs contain `dist/` and resolve their
  `@askturret/*` dependencies at the versions the manifests declare.

Only after that does a `1.0.0` release rest on tested machinery.

---

## Which packages publish

Eleven packages are public; two are not. The split is closed under runtime
dependencies — every `@askturret/*` dependency of a public package is itself
public — which is what makes a published package installable rather than
broken.

**Public:** `mcp-core`, `mcp-transports`, `mcp-sources-openapi`, `mcp-explorer`,
`mcp-observability`, `mcp-adapters-express`, `mcp-adapters-fastify`,
`mcp-gateway`, `mcp-cli`, `mcp-adapter-conformance`, `mcp-adapter-test`.

**Private:** `mcp-reliability`, `mcp-examples`, and everything under
`examples/`.

`mcp-adapter-conformance` and `mcp-adapter-test` joined the public set in #173
and **have not been published yet** — they ship on the next release. Closure
under runtime dependencies is why they moved together: the kit depends on the
bank, so publishing the kit alone would 404 on its own dependency.

They enter at `0.1.0` while the other nine carry `0.2.0`. That is deliberate —
they have no published history, so `0.1.0` is their genuine first version rather
than a stale one, and semver does not ask sibling packages to agree. The nine
share a number only because they share a release history these two do not.
**Whether the next bump brings all eleven into lockstep is a decision for that
release**, recorded here so it is made rather than inherited.

Two packaging details are load-bearing rather than incidental:

- **`files` must list `dist`.** `dist/` is in `.gitignore`, and there is no
  `.npmignore`. Without an explicit `files` list npm falls back to `.gitignore`
  — which excludes the very build output `main` points at, while including
  `src/` and its tests. A dry run of `mcp-core` before this was fixed produced
  177 source entries and **zero** `dist/` entries.
- **Internal dependencies are ranges, not `*`.** All 29 were `"*"`, which
  publishes as `"*"`: a consumer would resolve each sibling to whatever is
  latest, which defeats semver entirely on packages whose whole compatibility
  story is the policy linked at the top of this page.

### The conformance kit — resolved

This section used to ask whether `@askturret/mcp-adapter-test` should be
private. **It is now public**, and the question is closed.

It was never really open. The decision was made in architecture §12.2 and #54,
whose acceptance is *"published on npm"* — the `private: true`, the `1.0.0` and
the `npx` help text were that issue's documented intended end state rather than
drift. What kept it waiting was sequencing: an adapter-conformance kit asserts a
stable contract to conform to, and until `@askturret/mcp-core` was published
there was nothing to conform to. That release happened, so the kit follows.

`@askturret/mcp-adapter-conformance` went public in the same change, and had to:
it is the kit's runtime dependency, so the kit alone would have 404'd on its own
dependency. That is the closure rule above, applied.

**The `1.0.0` did not stand.** The package version is now `0.1.0`; `KIT_VERSION`
keeps `1.0.0`, because the two answer different questions. `KIT_VERSION` is the
conformance-result contract and moves when the categories change, so a stored
result stays meaningful alongside the kit that produced it. The package version
tracks the project. They were equal only while the package was private and its
`version` field was inert — publishing made it load-bearing, and a 0.x project
shipping a `1.0.0` on day one would promise a stability it does not have. The
precedent is the independently-versioned plugin `apiVersion` in
[`compatibility-policy.md`](compatibility-policy.md) §2.

One consequence worth stating because nothing enforces it: **`npx
@askturret/mcp-adapter-test` is accurate from the next release, not from the
merge of #173.** Flipping `private` makes a package publishABLE; the publish
happens in CI on release. Between those two moments the documented command still
404s.

---

## Related

- [Architectural readiness for 1.0](readiness.md) — the matrix the gate reads
- [Compatibility and deprecation policy](compatibility-policy.md)
- [CHANGELOG.md](../CHANGELOG.md)
