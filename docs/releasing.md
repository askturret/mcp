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

---

## What is gated, and what is not

### Gated

| Act | Gate | Where |
|---|---|---|
| `npm publish` | licence review + NOTICE freshness + SBOM generation | `publish` job `needs: [supply-chain, …]` |
| `npm publish` of a **`>= 1.0.0`** release | readiness matrix, all 12 rows `✅ met` | `publish` job `needs: [… , readiness]` |
| Merging to `main` | readiness matrix, at commit time | `test-integrity` job in `test.yml` |

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

Nine packages are public; four are not. The split is closed under runtime
dependencies — every `@askturret/*` dependency of a public package is itself
public — which is what makes a published package installable rather than
broken.

**Public:** `mcp-core`, `mcp-transports`, `mcp-sources-openapi`, `mcp-explorer`,
`mcp-observability`, `mcp-adapters-express`, `mcp-adapters-fastify`,
`mcp-gateway`, `mcp-cli`.

**Private:** `mcp-adapter-conformance`, `mcp-adapter-test`, `mcp-reliability`,
`mcp-examples`, and everything under `examples/`.

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

### One unresolved question

`@askturret/mcp-adapter-test` is **private here, and that may be wrong.** It
carries every marker of a package meant for publication — a `bin`, an
`exports` map, a curated `files` list, a description, and a version of `1.0.0`
while everything else sits at `0.1.0` — and its own `--help` output tells users
to run `npx @askturret/mcp-adapter-test <path-to-adapter>`. That command does
not work today and will not work while it is private.

It is left private rather than flipped because publishing it also means
publishing `@askturret/mcp-adapter-conformance`, which it depends on, which in
turn depends on both official adapters. That is a real decision about what the
project supports for third-party adapter authors, not a packaging detail to
settle inside a release-process change. It is
[#277](https://github.com/askturret/mcp/issues/277), which also carries the
question of whether that `1.0.0` version number stands if the package ships.

---

## Related

- [Architectural readiness for 1.0](readiness.md) — the matrix the gate reads
- [Compatibility and deprecation policy](compatibility-policy.md)
- [CHANGELOG.md](../CHANGELOG.md)
