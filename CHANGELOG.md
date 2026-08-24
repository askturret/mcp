# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
scoped by **[`docs/compatibility-policy.md`](docs/compatibility-policy.md)** —
that document defines which surfaces semver actually applies to, and is what
every entry below is classified against.

## How to write an entry

Group changes under the standard headings: **Added**, **Changed**,
**Deprecated**, **Removed**, **Fixed**, **Security**.

Two project-specific rules on top of Keep a Changelog:

**1. A `Changed` or `Removed` entry states which covered surface it touches.**
Not as ceremony — it is what makes the version bump checkable by a reader rather
than trusted. If a change touches no covered surface, say that too:

```markdown
### Changed
- `OperationResult.error` is now a discriminated union.
  **Breaking — core public types** (compatibility-policy §1), returned value,
  so an exhaustive `switch` must be updated.
- Reworded the `EXECUTOR_MISCONFIGURED` message to name the missing field.
  Not a covered surface — error wording is explicitly excluded; the `code` is
  unchanged.
```

**2. A `Deprecated` entry names its earliest possible removal.**

```markdown
### Deprecated
- `expressMcp({ enableExplorer })` in favour of `{ explorer: { enabled } }`.
  Emits a `deprecation`-tagged log record. Removable no earlier than `2.0.0`;
  supported for at least one further MINOR regardless.
```

A deprecation must appear here in the release that **introduces** it, never for
the first time in the release that removes it.

**3. A breaking entry links its migration.** Every `Removed` entry, and every
`Changed` entry that breaks a covered surface, links the corresponding snippet
in [`docs/migrations/`](docs/migrations/README.md) — which is generated from the
rules `npx @askturret/mcp migrate` actually executes, so the link cannot point
at a guide describing a change the tool does not make.

```markdown
### Removed
- `audit.durability` on `PresetConfiguration`, replaced by `audit.sink.durable`.
  **Breaking — core public types** (compatibility-policy §1).
  Migration: [0.x → 1.0](docs/migrations/README.md#0x--10) —
  `npx @askturret/mcp migrate --from 0.x --to 1.0`
```

---

## [Unreleased]

Nothing released yet. The project is at `0.1.0` and **pre-1.0, so no
compatibility guarantee is in force** — see the policy document for what changes
when `1.0.0` ships.

### Added
- `docs/compatibility-policy.md` — the semver, compatibility and deprecation
  policy for the 1.0 contract, and this changelog format. Not a covered-surface
  change: it publishes the rules that will govern them.
- `docs/ownership.md` and `.github/CODEOWNERS` — repository ownership boundaries.
- `.gitattributes` — `merge=union` for append-only audit logs.
- `npx @askturret/mcp migrate` and `docs/migrations/` — version-to-version
  migration tooling. No published migration exists yet, because no release has
  broken a published surface; the tooling ships first so the first breaking
  change arrives with its migration rather than after it.
- `REQUEST_TOO_LARGE` — a request body exceeding `maxRequestBodySize` now returns
  HTTP `413` with this code, symmetric with the response side's
  `OUTPUT_TOO_LARGE`.
  **Covered surface — error `code` values** (compatibility-policy §6). Adding a
  code is additive, so this half is MINOR; the condition it takes over is
  recorded under *Changed* below.
  Classified non-retryable (`NEVER_RETRY_CODES`): the same payload against the
  same cap yields the same refusal. It is emitted by the transport before the
  body is parsed, so unlike every other code in the union it can never come from
  an executor — which is why it is deliberately absent from the executor-facing
  code lists in `adapter-conformance` and `reliability`.
- `createMcpServer` is now a real implementation, and `UnsupportedReloadModeError`
  with it. It expands a preset, builds a registry, and constructs a reload
  controller from the preset's own `reloadMode` — closing the declare-but-don't-
  wire gap #36 recorded honestly and #37 left ready to join.
  It does **not** serve traffic: `start()` / `stop()` still refuse, and the
  Production preset's `pending` list still names `audit.sink`, `redaction` and
  `outputValidation`. Adapters (`expressMcp` / `fastifyMcp`) and the gateway
  remain the way to serve.
  Regulated is **refused** rather than built: it declares `fail-readiness`, which
  `createReloadController` has no branch for, so wiring it through would silently
  deliver `degraded` — the opposite of what that mode exists to say.
- `compileSnapshot` — the discover/compile/filter step, extracted from
  `bootstrapRegistry` so boot and reload run the same path. Facade behaviour is
  unchanged; bootstrap still compiles under `light`.
- `FORBIDDEN_FIELD_KEYS` and `DROPPED_FIELDS_KEY` — the §9.4 never-log list as a
  runtime array (`ForbiddenFieldKey` is now derived from it rather than
  hand-written alongside it), and the field name `asLegacyLogger` uses to report
  what it refused to forward.
- `docs/adr/` — an ADR home, starting at
  [ADR-021](docs/adr/ADR-021-two-logger-types.md). Numbering starts at 021
  because fourteen ADRs are already cited by number in source comments and none
  is written down; reusing one of those numbers would be worse than the gap.

### Fixed
- `mcp_registry_operations` no longer carries a `registry_hash` label, and
  `hash` joins the §9.2 label denylist.
  The label was truncated to 12 characters, and three separate comments called
  that the cardinality bound. It is not one: **truncation bounds a label's
  width, not the number of distinct values it can take.** Every reload that
  changed the registry produced a new permanent time series — and in the OTel
  adapter a new permanent entry in a `gaugeLevels` map that nothing evicts,
  beneath a comment asserting the label was "bounded by construction".
  `recordActiveRegistry` no longer accepts a hash at all, so the cardinality
  cannot be reintroduced by a caller passing one. Which registry is live is
  reported on a span and in the readiness payload, where high-cardinality
  identity costs nothing.
  Dashboards: the generated `reliability.json` panel becomes
  `max(mcp_registry_operations)`, and `examples/dashboards/registry.json` breaks
  down by `instance` — a scrape label bounded by the size of the deployment —
  instead of by hash. Divergence detection is unaffected: it reads the
  `mcp:registry_hashes:count` recording rule, not this label.
- `check-metric-cardinality.mjs` now derives its denylist from `LABEL_DENYLIST`
  rather than keeping a second hand-maintained copy, and fails rather than
  falling back when it cannot read it. The two had already drifted: adding
  `hash` to the runtime list left the CI guard — the one readiness criterion 8
  cites as evidence — still passing the reintroduced label.
- `check-dashboard-metrics.mjs` now fails when it cannot parse a declared
  metric instead of silently dropping it. Its entry matcher needs `name`,
  `kind` and `labels` adjacent, so a comment between those keys removed the
  metric from its view and made a correct dashboard look as though it
  referenced a metric the runtime does not emit.
- The dashboard generator renders an unlabelled metric as `max(metric)` rather
  than the degenerate `max by () (metric)` with an empty legend.

### Changed
- A policy denial carrying `UNAUTHENTICATED` now reaches the caller as
  `UNAUTHENTICATED` rather than being collapsed into `FORBIDDEN`. Every other
  denial — unrecognised policy codes and the engine's own internal ones
  included — still normalises to `FORBIDDEN`.
  **Covered surface — error `code` values** (compatibility-policy §6). §6 makes
  "changing which condition produces it" MAJOR, and this changes which condition
  produces `FORBIDDEN`. It would therefore be a MAJOR change once `1.0.0` ships,
  and lands now precisely because no guarantee is in force yet.
  A client switching on `FORBIDDEN` to mean "any denial" needs an
  `UNAUTHENTICATED` arm. The two call for different behaviour — obtain
  credentials and retry, versus do not retry with this identity — which is the
  distinction callers previously could not make.
- An oversized request body returns HTTP `413` with `REQUEST_TOO_LARGE` instead
  of HTTP `500` with JSON-RPC `-32603` "Internal server error".
  **Covered surface — error `code` values** (compatibility-policy §6). §6 makes
  "changing which condition produces it" MAJOR, and this removes a condition
  from `-32603`, so it would be MAJOR once `1.0.0` ships. It lands now because
  no guarantee is in force yet.
  A client treating `-32603` as "server fault, possibly transient" would have
  retried an oversized payload that could never succeed; it now gets a terminal,
  client-correctable answer. Body-read failures that are **not** size-related —
  a reset socket, say — still return `500`/`-32603`, which is the distinction
  the fix turns on.
- `createMcpServer(options)` now REQUIRES options and returns an `McpServer`,
  replacing the v0.1 stub `createMcpServer(_options?: unknown): unknown` whose
  `start()`/`stop()` threw.
  **Covered surface — core public types** (compatibility-policy §1). A signature
  change on an exported function is breaking, so this would be MAJOR once
  `1.0.0` ships; it lands now because no guarantee is in force and the previous
  shape could not do anything except throw.
- The Production preset no longer lists `reloadMode` under `pending`, because it
  is now enforced end to end. Not a covered surface — `pending` describes what is
  unfinished, and leaving a wired control in it would misreport in the other
  direction.
- `asLegacyLogger` no longer forwards §9.4 forbidden fields. It previously cast
  `meta` into the structured sink unconstrained, which erased the compile-time
  guard those generics exist for — and `DEFAULT_REDACTED_KEYS` shares no member
  with `FORBIDDEN_FIELD_KEYS`, so the runtime layer did not cover it either.
  A forbidden key's value is now dropped and its NAME reported under
  `forbiddenFieldsDropped`; silence was the defect, so a value vanishing without
  trace would only be a quieter version of it.
  Not a covered surface in the §6 sense — no error code or type changes — but it
  is a behaviour change on an exported function, and a log consumer may see a
  field name it has not seen before. It appears only when something was dropped.

[Unreleased]: https://github.com/askturret/mcp/compare/main...HEAD
