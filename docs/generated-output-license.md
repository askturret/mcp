# Licensing of Generated Output

**What this page answers:** if you run AskTurret MCP over your API, who owns what
comes out the other side?

**The short version: you do.** Nothing AskTurret generates from your inputs is
encumbered by an AskTurret licence. The Apache-2.0 licence on this project covers
*our* code, not *your* output.

This page is a **versioned contract**, not guidance. See
[Stability of this contract](#stability-of-this-contract).

---

## The three categories

Output splits into three kinds of material, and they are licensed differently. The
distinction that matters is **who authored the bytes**, not which tool emitted them.

| Category | Example | Licence |
|---|---|---|
| **Generated output** | CLI scaffolding, compiled tool definitions, registry snapshots, overlays you write | **Yours.** No AskTurret restriction. |
| **Bundled runtime code** | Anything imported from `@askturret/mcp` at runtime | **Apache-2.0** — ours, and it stays ours |
| **Shipped example fixtures** | `examples/petstore-light`, the Petstore specs under `__tests__/fixtures/` | **Apache-2.0**, permissively reusable |

---

### 1. Generated output belongs to you

This covers everything AskTurret produces *from your inputs*:

- server scaffolding emitted by the CLI templates,
- tool definitions the compiler derives from your OpenAPI spec, routes, schemas or
  handlers,
- registry snapshots and `diff` output,
- policy and overlay files you author against our schema.

**You may use, modify, distribute, relicense and sell this output with no
obligation to AskTurret.** No attribution requirement, no copyleft, no notice
clause. We assert no copyright interest in it, and this page is our public,
versioned statement to that effect.

The only licences that attach to your generated output are the ones that were
already on **your** source materials. If you compile tools from a third-party
OpenAPI spec, that spec's licence governs — we neither add to it nor subtract
from it.

> **Why say this explicitly?** Code generators have a genuine history of ambiguity
> about output ownership, and "the tool is Apache-2.0" does not by itself tell you
> whether the *output* is. An adopter should not have to reason about it, ask a
> lawyer, or take our silence on faith.

### 2. Bundled runtime code stays Apache-2.0

Generated scaffolding typically **imports** from `@askturret/mcp` rather than
inlining it. Those imported modules are our code and remain under the
[Apache License 2.0](../LICENSE), exactly as if you had installed the package
directly — which, in practice, you did.

So: the file the CLI wrote for you is yours; the library that file calls into is
ours, under Apache-2.0. Shipping your generated server to your users carries the
same Apache-2.0 obligations as shipping any other application built on an
Apache-2.0 dependency — principally, preserving the [`NOTICE`](../NOTICE) and
licence text for the code you redistribute.

If a future template ever **inlines** a non-trivial amount of our runtime source
into generated output rather than importing it, that inlined code is a
redistribution of Apache-2.0 material and carries its terms with it. No current
template does this.

### 3. Example fixtures are permissively licensed

The examples and test fixtures we ship — [`examples/petstore-light`](../examples/petstore-light),
and the Petstore specs under `packages/*/src/__tests__/fixtures/` — are **our own
work**, written for this project and licensed **Apache-2.0**. Copy them, adapt
them, and build tutorials on them.

They are *inspired by* the industry-standard Petstore example but are not copies
of it.

**If we ever vendor a genuinely third-party specification** into this repository,
it will ship with its own per-fixture licence file recording the upstream source
and terms, and it will be listed in
[`LICENSE_EXCEPTIONS.md`](../LICENSE_EXCEPTIONS.md). **Today, none are vendored** —
so there is currently no per-fixture licence file, and its absence means "all
fixtures are ours", not "we forgot to check".

---

## What this page does *not* do

- **It is not a patent grant beyond Apache-2.0.** The patent terms in
  [`LICENSE`](../LICENSE) §3 govern our code and are unchanged by anything here.
- **It is not a trademark licence.** Naming, branding and logo use are governed
  separately by [`TRADEMARK.md`](../TRADEMARK.md). Owning your generated output
  does not entitle you to call your product AskTurret.
- **It does not launder input licences.** Running a GPL-licensed spec or schema
  through our compiler does not make the result permissive. Output inherits the
  obligations of its inputs.
- **It is not legal advice.** It is a clear statement of the licence terms we
  offer, which your counsel can rely on as our published position.

---

## Stability of this contract

This page is a **versioned contract**. It changes only through the ordinary
release process:

- **Any change to the terms above requires a semver bump and a release-notes
  entry.** A change that narrows adopter rights is a **breaking change** and
  requires a **major** version bump.
- Clarifications that do not alter the substance of the terms — wording, examples,
  formatting — may ship in a minor or patch release, and still require a
  release-notes entry.
- The terms that applied when you generated your output are the terms that
  **continue** to apply to it. We cannot retroactively encumber output that was
  already generated under an earlier version of this page.

## Related

- [Compatibility matrix](compatibility.md) — supported runtimes and versions, also a versioned contract
- [`LICENSE`](../LICENSE) — Apache License 2.0, full text
- [`NOTICE`](../NOTICE) — attribution for bundled runtime dependencies
- [`LICENSE_EXCEPTIONS.md`](../LICENSE_EXCEPTIONS.md) — reviewed dependency-licence exceptions
- [`TRADEMARK.md`](../TRADEMARK.md) — trademark and branding
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — contributor licensing and the DCO
