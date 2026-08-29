# Compatibility and deprecation policy

What "1.0" will mean, expressed as a rule you can check a change against.

**Policy version `1.1.0`. Applies from release `1.0.0` onward.**

This page is a **versioned contract**, and the most consequential one the
project publishes: it is the thing the 1.0 label actually promises. Changing it
is governed by [its own rules](#changing-this-policy).

> **Not yet in force.** The project is at `0.1.0`. Under semver, `0.x` carries no
> compatibility guarantee at all, and pretending otherwise would be the first
> thing this document got wrong. It is published now so the rules are agreed
> **before** they start binding, and so pre-1.0 changes can be made with the
> post-1.0 cost visible.

## How this relates to the compatibility matrix

Two documents, one boundary between them:

| | Answers |
|---|---|
| [`compatibility.md`](compatibility.md) | **Which versions** of Node, TypeScript, Express, Fastify, OpenAPI and the MCP SDK are supported *today*. |
| **This document** | **Which parts of the API** are promised to be stable, and **what we do** when one has to change. |

The matrix is deliberately **not restated here**. It changes on every release
and this document does not; a copy would be wrong within one release and would
create two places to update. [`compatibility.json`](compatibility.json) remains
the machine-readable source of truth for the matrix, and the matrix carries its
own stability rules for how *it* may change.

---

## What semver applies to

A change to anything in this section is governed. Breaking it requires a MAJOR
release, and there is no exception for "nobody was using it".

### 1. Core public entry point

Everything exported from `@askturret/mcp-core`'s public entry point — the types
below, **and the observable behaviour of exported functions**, including which
inputs they reject:

`OperationDefinition` · `OperationCommand` · `OperationResult` · `Policy` ·
`OperationSource` · `OperationExecutor` · `PresetConfiguration` and the preset
option types · the config surface accepted by the facades
(`McpFacadeOptions`) and by `createMcpServer`.

**Option defaults.** Changing the **default value of an option** on an exported
function is MINOR only when the old behaviour remains reachable by passing the
old value explicitly; otherwise it is MAJOR.

This is the same test §4 applies to CLI flags and config keys, stated here as
well because in a library most defaults are API options rather than flags — the
more common case, and the one a reader is more likely to be pricing. A reader
should meet the rule in the section that covers their surface, rather than
having to reach for one whose heading names a different one.

### 2. The plugin API — versioned independently

`PluginContext`, `AskTurretPlugin`, `PluginCapability` and the surface described
in [`plugin-api.md`](plugin-api.md) carry their **own `apiVersion`**, which moves
independently of the package version.

A breaking change to the plugin API is **MAJOR to `apiVersion`** even when it
ships in a MINOR release of the package. The two numbers are not required to
agree and should not be assumed to.

Why separate: a plugin author's compatibility question is "does my plugin still
load", not "did the package version change". Tying the two would force a package
MAJOR for a plugin-only break, or hide a plugin break inside a package MINOR.

### 3. CLI machine-readable output

`doctor --json`, `inspect --json`, `diff --json`, and the `diagnostics` bundle
format are **public contracts**. Breaking one of their schemas is MAJOR.

"Breaking" means: removing a field, renaming a field, changing a field's type,
or changing the meaning of an existing value. **Adding** a field is MINOR —
consumers are expected to ignore fields they do not know.

### 4. CLI flags and configuration file keys

Flag names, config-file keys and their accepted values are **covered**, for the
CLI and for the gateway alike.

This is stated explicitly because it is easy to miss: a renamed flag breaks
every operator's deployment script and every Dockerfile, which is at least as
disruptive as a renamed type and considerably harder for the operator to debug —
the failure arrives at 3am as a container that will not start.

Removing or renaming a flag or key is MAJOR. Adding one is MINOR. Changing a
**default** is MINOR only when the old behaviour remains reachable by writing
the old value explicitly; otherwise it is MAJOR.

### 5. Registry snapshot hash algorithm

Changing how the snapshot hash is computed is **MAJOR**.

The hash appears in audit records as the identifier of the surface a call was
made against. Changing the algorithm does not merely alter future hashes — it
severs the link between every historical audit record and the registry it
referenced, retroactively and unrecoverably. That is a larger blast radius than
any type change in this document, and it is the one entry here that cannot be
mitigated by a deprecation period.

### 6. Error `code` values

`OperationErrorCode` and the JSON-RPC error codes on the wire are covered.
Removing a code, or changing which condition produces it, is MAJOR.

**Error message wording is not covered** — see below.

### 7. The MCP wire protocol

Bound by MCP SDK compatibility (§12.3). The SDK is imported by
`packages/transports` alone and appears in no public API surface, so an SDK
upgrade is absorbed inside the transport boundary **where possible**.

Where it is not possible — where an upstream protocol change is breaking to our
own surface — **we bump MAJOR.** This is anticipated at least once as MCP
itself stabilises, and saying so now is more honest than discovering it later.

Protocol-level fixtures are retained across SDK upgrades so a protocol-era
change is visible as a diff rather than as an absence.

---

## What semver does NOT apply to

Listed as explicitly as the covered surface, because an unstated exclusion
becomes an implied promise.

- **Explorer UI internals.** The rendered page, its DOM, its embedded view
  model and its client script. It is reached through a URL, not an `import`,
  and it is dev-only. The `buildExplorerViewModel` / `buildExplorerPanels`
  *types* are covered as core types; what the page does with them is not.
- **Internal package layout.** Workspace names, private module paths, and which
  package a symbol physically lives in. Import from a package's public entry
  point; a deep path into `dist/` is not a supported import.
- **Test fixtures and their exact contents.** Including the conformance bank's
  fixtures. The bank's *categories* are a contract (and carry their own kit
  version); the JSON inside a fixture is not.
- **Error message wording.** Only `code`s are contract. Messages are written to
  be read by a human debugging a problem, and improving one must not require a
  MAJOR release. **Do not parse them.**
- **Log output format and content**, other than the `deprecation` tag below.
- **Timing, ordering and performance characteristics** not stated as a
  guarantee. Notably: operation iteration order beyond what is documented as
  deterministic.

---

## Deprecation

The rule, in one line: **nothing is removed without having first been
deprecated in a release you could have upgraded to safely.**

1. A deprecated API **stays in place for at least one MINOR release** within the
   current MAJOR. It keeps working, unchanged, for that whole period.
2. Deprecation is announced **in the release that introduces it** — in the
   CHANGELOG, and in the matrix's Deprecations section where a version range is
   involved. A deprecation never appears for the first time in the release that
   removes it.
3. At runtime, deprecated usage emits a **structured log record carrying a
   `deprecation` tag**, naming what is deprecated, what to use instead, and the
   earliest release it may be removed in. One record per distinct usage per
   process, not per call — a warning that floods a log is a warning that gets
   filtered.
4. **Removal happens on the next MAJOR at the earliest.** A deprecation is not a
   removal schedule; it is the minimum notice before one becomes possible.

Migration tooling detects deprecated usage in configuration files, so the
upgrade path is checkable rather than a reading exercise.

### `deprecation` tag shape

```json
{
  "level": "warn",
  "deprecation": {
    "api": "expressMcp({ enableExplorer })",
    "since": "1.2.0",
    "replacement": "expressMcp({ explorer: { enabled } })",
    "removedNoEarlierThan": "2.0.0"
  }
}
```

`removedNoEarlierThan` is deliberately not "removedIn": committing to a specific
removal release at deprecation time is a promise about a version that does not
exist yet.

---

## Worked answers

The point of a policy is that it answers questions without a meeting. These are
real questions that were deferred to this document while it was being written.

### Changing the shape a preset returns (#52)

**Question.** §10.2 describes the Regulated audit requirement as
`sink: { durable: 'required' }`; the implementation carries it as a sibling
`durability` field on `PresetAuditConfig`. Is reshaping it to match the spec a
breaking change?

**Answer: yes, MAJOR** — after 1.0. `PresetConfiguration` is a core public type
(§1 above), it is *returned* to adopters, and moving a field is removal plus
addition however it is described. Adopters reading `config.audit.durability`
would break.

**Before 1.0 it is free**, which is exactly why the question is worth settling
now rather than after the label ships. Reshape it while it costs nothing, or
accept the current shape deliberately.

### Widening a public type (#55)

**Question.** Is widening a type — adding a member to a union, making a required
field optional — breaking?

**Answer: it depends on which direction the value flows**, and this is the one
rule here that is genuinely counter-intuitive:

| Change | Where the type appears | Verdict |
|---|---|---|
| Add a member to a union | in a value we **return** | **MAJOR** — an adopter's exhaustive `switch` stops compiling |
| Add a member to a union | in a value we **accept** | MINOR — accepting more is backwards-compatible |
| Make a field optional | in a value we **return** | **MAJOR** — the adopter must now handle `undefined` |
| Make a field optional | in a value we **accept** | MINOR |
| Add a required field | in a value we **accept** | **MAJOR** |
| Add an optional field | in a value we **accept** | MINOR |

Most types here flow both ways — `OperationDefinition` is returned by a source
and accepted by the compiler. **When a type flows in both directions, take the
stricter verdict.**

### CLI flags and config keys on the gateway (#57)

**Question.** The gateway's compatibility surface is its flags and config file,
not its TypeScript exports. Are those covered?

**Answer: yes** — §4 above exists for this. `--upstream` cannot be renamed in a
MINOR, and `audit.sink` cannot change its accepted values in a MINOR. An
operator's deployment script is as much a dependent as an `import` statement.

---

## Changing this policy

Adding a surface to the covered list, or clarifying wording without changing a
verdict, is a **MINOR** bump of the policy version.

**Removing a surface from the covered list, or weakening a guarantee, is
MAJOR** — and it is a withdrawal of a published promise, so it ships with an
explanation in the CHANGELOG rather than as a diff.

The policy version is independent of the package version, like the plugin API's.

---

## Related

- [`compatibility.md`](compatibility.md) — which versions are supported today
- [`plugin-api.md`](plugin-api.md) — the plugin surface and its `apiVersion`
- [`../CHANGELOG.md`](../CHANGELOG.md) — every entry classifies its change against this policy
- [`ownership.md`](ownership.md) — who reviews changes to each covered surface
- [`../SECURITY.md`](../SECURITY.md) — which versions receive security fixes
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — what to check before changing a covered surface

---
*Operum Engineer · [operum.ai](https://operum.ai)*
