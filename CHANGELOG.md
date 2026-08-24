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
- `.github/scripts/check-doc-types.mjs` — a CI guard requiring every type named
  in a documented ` ```typescript ` block to be a type that exists, and every
  documented member of a real type to be a real member. Four issues (#42, #43,
  #44, #61) had each independently rediscovered a documented name with no
  referent. The reverse direction is deliberately not checked: a doc that omits
  a field is abridged, a doc that names one that does not exist is wrong.

### Fixed
- The Explorer's auto-refresh no longer discards a snapshot selection (#178).
  Panel 5 armed a 2000ms poll whose mechanism is `location.reload()`, and panel 6's
  selector shares that route — so an operator who picked a different pair had both
  the selection and the "this is NOT the pair you selected" warning wiped about two
  seconds later, with no explanation. That warning exists precisely so the page can
  never show one pair while labelling it another, and the poll silently restored
  exactly that state.
  Touching either selector now disarms the poll, unticks the checkbox and says why.
  Unticking is part of the fix rather than tidiness: a control reading "Auto-refresh
  every 2000ms" while nothing refreshes is the page asserting something untrue about
  itself. Re-ticking re-arms and will discard the selection on the next reload —
  acceptable, because it is now an explicit operator act.
  **Not a covered surface** — Explorer is a dev-only diagnostic page and its markup
  is explicitly excluded; no exported type or adapter behaviour changes.
- The host-header allowlist can match an IPv6 host (#247). `isHostAllowed`
  stripped the port with `host.split(':')[0]`, which assumes at most one colon —
  so every IPv6 literal reduced to `'['`, and the shipped `[::1]` default could
  never match. An allowlist row that read as coverage and routed nothing.
  **Covered surface — adapter behaviour**, and strictly a repair: it failed
  CLOSED, so this was a false-deny rather than a hole. An operator on IPv6
  localhost got a 403 that no configuration could fix, because the mangling
  happened before the lookup — adding `[::1]` or `::1` to `allowedHosts` did not
  help either.
  The authority is now parsed with `URL`, and both sides of the comparison are
  canonicalised, so `::1`, `[::1]` and `[::0001]` in configuration all match the
  request they should, and host names compare case-insensitively as DNS
  requires. The default stays **bracketed** `[::1]`: the URL Standard's host
  serializer emits IPv6 with its brackets, so `hostname` is `'[::1]'` —
  unbracketing it would have left the entry dead in a new way that looked fixed.
  `URL` alone would have loosened the mitigation while fixing IPv6, because it
  reads `evil.com@localhost` as userinfo plus host and returns `localhost` — and
  the same for a path, query or fragment. Authorities carrying any of those are
  refused before parsing, which the previous `split` had rejected by accident.
  An `allowedHosts` entry that cannot be parsed is now an error at construction
  rather than silently discarded, since an entry that can never match is the
  same defect this fixes arriving by another route.

- `diagnostics --help` documents `--regulated`, and every command's help now
  agrees with its unknown-flag refusal by construction (#264). #261 generated
  the refusal list from each command's flag spec and left `--help`
  hand-maintained; the two promptly disagreed, with `diagnostics --help` listing
  nine flags to the refusal's twelve.
  Not a covered surface — CLI help text. It mattered because the omitted flag
  was `--regulated`, a real disclosure control, and because #261's own
  `--preset regulated` refusal explicitly points operators at it: an operator
  following that advice to `--help` did not find it, so the only way to discover
  a disclosure control was to trigger an error.
  Both renderings are now derived from one list, so there is no second copy to
  drift from — adding the missing lines would have fixed the disagreement and
  left the mechanism that produced it. `inspect` and `diff` were checked in the
  same pass and had no gap; they are converted anyway, so the property holds for
  all three rather than being true of two by luck.

- `inspect`, `diff` and `diagnostics` accept `--flag=value` and refuse flags
  they do not recognise (#261). All three matched flags by exact string equality
  with no final `else`/`default`, so every `=` spelling and every unrecognised
  `--` token was discarded in silence — the same false-green shape #256 fixed in
  `doctor`, which a sibling sweep found was not local to it. `migrate` already
  refused loudly and is unchanged.
  **Covered surface — CLI behaviour** (compatibility-policy §5). Invocations
  that exited 0 now exit 2, the usage code `inspect` and `diff` already
  document; nothing that previously *worked* changes.
  The shared part lives in one place (`args.ts`) rather than being copied three
  times, since the duplication is what let these drift apart to begin with. It
  normalises argv into the form each command's existing loop already handles, so
  those loops are untouched. `doctor` is deliberately not migrated onto it — it
  has a positional argument and its own `--preset` resolution, so folding it in
  would mean re-testing the command this pattern was just proven on.
  The three carve-outs from #256 hold: `--` ends option parsing, a non-flag
  token passes through, and `--help`/`-h` print usage — `inspect` had no help at
  all and now does.

- `diagnostics --preset` refuses a value it cannot honour (#255). An unsupported
  or unknown value was silently discarded, so `--preset regulated`,
  `--preset nonsense` and omitting the flag all produced a bundle with no preset
  section and exit 0. Each case now states its own reason, and the refusal
  happens before any bundle is written.
  The wording is deliberately not #169's: there the flag prints an expansion,
  here it decides what goes into the bundle, so "expand it in code" would answer
  a question the operator did not ask. The message also distinguishes `--preset`
  from `--regulated`, which governs disclosure and works with any preset.

- A conformance category that hangs in CLEANUP now reports a failed row (#253).
  #151 bounded every request, at `rpc`. The `cancellation` category does not go
  through `rpc` — it uses a direct `fetch`, because it aborts one specific
  in-flight request — and its `finally { server.close() }` waited on the
  half-dead connection it deliberately leaves behind. No request deadline
  reaches a close.
  Not a covered surface — this is the conformance harness. The symptom was a
  missing verdict rather than a wrong one: the category ran past the suite's own
  30s jest cap, and when jest kills a test it ABANDONS the function, so the
  `finally` that records the row never ran. The table printed `—`, which a
  reader could not tell from "not applicable".
  Every category now runs through one bounded entry point, `runCategory`,
  whose budget (20s, overridable with
  `ASKTURRET_CONFORMANCE_CATEGORY_TIMEOUT_MS`) deliberately sits *below* the
  harness cap — that ordering is the fix, since only a rejection lets the row be
  recorded at all.
  The empty cell is also now labelled `NOT RUN`, with a legend printed only when
  one appears. It had meant two different things in a table whose entire purpose
  is to be self-explanatory; a hang reports `FAIL`, so the cell has one meaning
  left and says so.
  Separately, `rpc` no longer calls `AbortSignal.any`, which landed partway
  through the Node 20 line while this package declares `engines: >=20.0.0` — on
  the earliest 20.x a caller-supplied signal produced a `TypeError` instead of a
  timeout, and `rpc` is exported for the adapter-test kit, so that is the
  intended public use. Composed by hand instead, which keeps the declared floor
  honest without dropping support for runtimes where everything else works.

- `doctor` accepts `--flag=value`, and refuses flags it does not recognise
  (#256). `parseArgs` matched flags by exact string equality with no final
  `else`, so every `=` spelling and every unrecognised `--` token was discarded
  in silence — `--preset=regulated` produced a clean report and exit 0, and a
  typo'd `--jsonn` produced human-readable output and exit 0, failing a
  downstream JSON parse in a way that blamed the wrong layer.
  **Covered surface — CLI behaviour** (compatibility-policy §5). Invocations
  that exited 0 now exit 1; that is the point of the change. Nothing that
  previously *worked* changes.
  The `=` form is split before dispatch and routed into the same
  `resolvePresetFlag`, so both spellings inherit #169's four refusals from one
  decision function rather than two copies of a message — pinned by a test
  asserting the two produce byte-identical stderr.
  `--preset=regulated` mattered most: it reproduced the exact false green #169
  was filed to prevent, via a completely conventional spelling, so that fix was
  bypassable by an operator who did nothing unusual.
  Three deliberate carve-outs so the new refusal rejects nothing that used to
  work: `--` ends option parsing (the conventional way to name a file that looks
  like a flag), a token not starting with `--` is still positional, and
  `--help`/`-h` now print usage — previously `doctor --help` answered "Missing
  required argument", and refusing it would have been worse.

- Both adapters re-run in CI when the packages they are built from change
  (#153). `adapters-express` and `adapters-fastify` triggered only on their own
  directory plus `packages/explorer`, so a core-only or transports-only change
  did not re-run either suite — even though both jobs already *build* those
  packages, which is where the filters and the reality had drifted apart.
  Not a covered surface — repository CI. Recorded because the gap was a
  near-miss rather than a hypothetical: during #43 a real bulkhead bug reached
  CI and was caught only because #42's `adapter-conformance` filter happens to
  include those two packages. That is coverage by side effect, and it would have
  disappeared the day that filter was narrowed.
  Scoped to the two adapters #153 names; the broader gap across the other
  filters is #213 and is deliberately left alone, with a test pinning that
  boundary so a future widening is an explicit edit rather than a drive-by.

- `doctor --preset` refuses what it cannot expand instead of ignoring it (#169).
  Four different situations previously produced one identical outcome — a clean
  score, exit 0, and no preset section: `--preset regulated` (supported but
  silently dropped), `--preset <typo>`, `--preset` with no value, and omitting
  the flag. An operator running a compliance-adjacent check could not tell "not
  supported" from "I typo'd it" from "I forgot the flag".
  **Covered surface — CLI behaviour** (compatibility-policy §5): an invocation
  that exited 0 now exits 1. That is the point of the change rather than a side
  effect, and `--preset production` is unaffected.
  The silence was correct until #168, when `regulated` became a real preset; the
  behaviour did not change, its correctness did. Each case now states its own
  reason — regulated cannot be expressed as a flag because it requires an
  `EvidenceVerifier` function, light is applied inside the adapter rather than
  described as configuration, and an unknown value is named as unknown with the
  known set listed. A placeholder expansion was rejected as the alternative: it
  would describe a configuration that could never boot.

- The adapter conformance suite bounds every request, so a hung adapter fails a
  row instead of stalling the run (#151). `rpc` — the choke point `callTool` and
  every category go through — now carries a deadline, default 15s, overridable
  with `ASKTURRET_CONFORMANCE_REQUEST_TIMEOUT_MS`. A malformed override is an
  error rather than a silent fallback, because falling back to *no* deadline
  would restore the hang invisibly.
  Not a covered surface — this is the conformance harness, not a published API.
  An adapter that accepted a connection and never answered previously produced
  no table at all: #42's QA watched it sit past 600 seconds, and CI reported
  only a job timeout with nothing to read. The rejection now travels the
  ordinary path, so `runBank` records a normal FAILED row carrying a `TIMEOUT:`
  note that names the method, the URL and the budget.
  The body read is inside the deadline too — a server can send headers and then
  stall the body, which hangs just as effectively. A caller-supplied `signal` is
  composed with the deadline rather than replaced, and only a deadline abort is
  labelled a timeout, so a kit cancelling its own request is not told the
  adapter hung.

- `RedactionPipeline.add` no longer documents a security property that does not
  hold (#171). Its public type doc, and the matching comment in
  `createRedactionPipeline`, claimed that "a user rule cannot accidentally
  un-redact something the defaults already catch, because first match wins and
  the built-in matched first". The premise is true and the conclusion does not
  follow: ordering only decides a tie, and a tie needs a built-in matching the
  **same node**. No built-in matches a plain-object container, so a user rule
  claiming one wins by default and the walk never reaches the leaves inside it.
  Not a covered surface and **no behaviour changed** — the diff to the runtime
  is comments only. It is recorded here rather than passed over in silence
  because the text stated a security property an adopter could reasonably build
  on, which is the reason it was filed as a bug.
  The adopter-facing behaviour is deliberate and is unchanged: replacing a whole
  subtree is a legitimate capability for code running in the adopter's own trust
  boundary. Plugin-supplied rules remain constrained to leaf values by
  `constrainPluginRedactionRule`, which is where the trust boundary actually is.
  Both halves are now pinned by tests, so the corrected wording cannot quietly
  drift back.

- `@askturret/mcp/policies` resolves (#149). The subpath was missing from the
  root `package.json` exports map, so the import on README line 89 —
  `import { confirmationForEffects, authenticated, allOf } from
  '@askturret/mcp/policies'` — threw `ERR_PACKAGE_PATH_NOT_EXPORTED`. Following
  our own documented usage failed on its first line.
  **Covered surface — published entry points** (compatibility-policy §1), and
  purely additive: a subpath that previously could not be imported now can, and
  no existing entry changes. `./policies` points at the policy engine's public
  entry point, `packages/core/dist/policy/index.js`.
  The same class as the `./fastify` bug fixed in #41, and it survived that fix
  because the guard added there reads the exports map rather than resolving
  through it — a map cannot be checked for an entry nobody remembered to add.
  The new test resolves for real, in a subprocess, and additionally executes the
  README's own example against the resolved subpath.

- The DCO check no longer certifies commits it never examined (#141).
  `.github/scripts/dco-check.sh` selected commits with `git rev-list
  --no-merges`, so **any** commit carrying two parents was excluded — not
  failed, never looked at. A commit can acquire a second parent by accident:
  tooling that leaves `MERGE_HEAD` set turns the next ordinary commit into one,
  and libgit2-based tooling does not drop the redundant parent the way `git
  commit` does. On #135's branch that happened to every commit at once, so the
  job filtered the branch down to nothing and reported success having verified
  zero commits.
  Not a covered surface — this is repository CI, not a published API. It is
  nonetheless a real gap: nine such commits exist on `main`, and one
  (`36dfdeb0`) carries no trailer at all and passed this check in silence.
  A merge is now exempt only if it is *genuine* — some extra parent brings in
  history the first parent did not already have. A merge in shape only is
  verified like the ordinary commit it is, while forge-generated merges stay
  exempt as before. Two supporting changes: a run that examines zero commits
  out of a non-empty range now fails instead of passing, and the counts of
  skipped and degenerate merges are printed, because the original defect
  survived precisely by being invisible.
- `expressMcp` no longer hangs when the host app registered its own body parser
  (#147). A global `express.json()` — an ordinary thing for a host app to have —
  drained the raw request stream before the MCP transport attached its
  listeners, so `data` and `end` never fired and the request produced **no
  response at all**: not an error, not a 500, a hang until the client timed out.
  **Covered surface — adapter behaviour**, and strictly a repair: requests that
  previously hung now succeed, and requests that already worked are untouched.
  The adapter now replays an already-consumed body for its own routes only. A
  sibling route in the host app still sees the body its own parser produced.
  This is the Express counterpart to the Fastify pass-through parser added in
  #41. The mechanisms differ because the frameworks do: Fastify can *prevent*
  the parse inside its plugin scope, while in Express the host's middleware has
  already run, so the body can only be reconstructed. `express.raw()` and
  `express.text()` bodies are replayed byte-for-byte; an `express.json()` body
  is re-serialized from the parsed value, which is semantically equal rather
  than byte-identical.
- The `diagnostics` support bundle no longer stamps a protocol version this
  server has never spoken (#190, completing #61). `versions.json` carried a
  hardcoded `2025-06-18` while the server announces `2024-11-05`; it now reports
  core's exported `MCP_PROTOCOL_VERSION`.
  Not a covered surface — the bundle is a support artifact, not a published API.
  It is the worst place for the defect regardless, because the bundle is what
  someone reads while already debugging a version problem.
  The value is the version this build **announces**. No session exists at
  collection time — the collectors make stateless JSON-RPC posts and never
  initialize one — so there is no negotiated value to report.
- `migrate` no longer rewrites an overlay as if it were a config because of how
  it happens to be capitalised (#192). `askturret.MCP.json` and
  `askturret.mcp.json` are **the same file** on macOS and Windows, whose
  filesystems are case-insensitive by default — but the overlay pattern required
  a lowercase `mcp` while the config pattern accepted any case, so one spelling
  was protected and its own alias was silently rewritten. Both patterns are now
  case-insensitive, the overlay alternation accepts `askturret-mcp` and a
  trailing ordinal, and a config rule additionally refuses any document carrying
  an `operations` key whatever the file is named. Not a covered surface —
  `migrate`'s file classification is internal, and no shipped rule targets
  overlays yet, so no adopter project changes behaviour today.
- The architecture overview's type vocabulary now matches the code
  (#156). `OperationDefinition` documented `effects: Effect[]`,
  `executors: Executor[]` and a `policies` field — two types that do not exist
  and one field that never did; the real shape is a single `EffectMetadata` and
  exactly one `ExecutorBinding`. `OperationExecutor` was documented with a
  spurious `type` field and a 2-parameter `execute`; `PolicyDecision`'s deny
  variant with `reason` rather than `code` + `safeReason`; and
  `RegistrySnapshot.operations` as a mutable `Map` under a heading reading
  "Immutable Registry Snapshots". Not a covered surface — documentation only,
  no runtime behaviour changes.
- §5 "Multiple Executor Strategies" claimed an operation "can use different
  execution strategies at different times", which read as a per-operation list.
  One `ExecutorBinding` is bound per operation at compile time; ADR-014's
  requirement that executors produce identical golden output is what makes the
  migration story true, not a runtime fan-out. Retitled "Interchangeable
  Executor Strategies".
- Six dead documentation links across four files, including `../ARCHITECTURE.md`
  (referenced twice, never existed) and the same phantom `quick-start.md` /
  `policies.md` names in three separate files. `docs/readiness.md` criterion 12
  cited a plugin example directory that does not exist; it now cites the
  `registerSource` / `registerExecutor` capability gate and the plugin tests
  that exercise it, which is what actually evidences the criterion. A
  source/executor *example* remains worth adding (#233).
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
  instead of by hash.
- `mcp_registry_hash_id` — registry identity as a metric VALUE, restoring the
  divergence detection that removing the label above had silently disabled.
  The claim that "divergence detection is unaffected because it reads the
  `mcp:registry_hashes:count` recording rule, not this label" was exactly
  backwards, and it is worth stating plainly: the panels do not read the label,
  but **the rule they read was computed FROM it**. Removing the label did not
  route around the rule, it emptied it. A missing label collapses to `""` on
  every series, so `count by (job, registry_hash)` yielded one group per job and
  `mcp:registry_hashes:count` became a constant 1 — leaving
  `McpRegistryHashDivergence` (`severity: critical`, and the whole of §64
  Option A) unable to fire at all. Nothing failed; an alert that cannot fire
  looks exactly like an alert with nothing to report.
  The identity is a VALUE and not a label because a label cannot be made bounded
  here: gauges are modelled as UpDownCounters, and a zeroed series still exists
  and is still counted by `count by (...)`, so no eviction would stop a retired
  hash from voting. As a value there is one series per instance whose value
  changes on reload, and `count_values` rebuilds the grouping at query time —
  where cardinality is bounded by the hashes actually live rather than by every
  hash ever served. Both recording rules keep their names and their output
  `registry_hash` label, so alerts and panels are unchanged; that label now
  holds the hash in decimal (`printf '%013x'` converts it back).
  13 hex digits, because 52 bits is the widest hex-aligned prefix float64
  represents exactly — at 14 two distinct hashes could round together and
  diverging instances would compare equal.
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
- `check-dashboard-metrics.mjs` also reads `examples/dashboards/alerts.yaml`
  now, and validates recording-rule and alert expressions against the metric
  contract exactly as it validates panels. It previously read `*.json` only, on
  the stated grounds that recording rules are "defined in alerts.yaml, not
  emitted by the runtime" — true of the rule OUTPUTS, and wrong about their
  INPUTS, which are ordinary PromQL over real metrics and drift the same way.
  That gap is what let a `severity: critical` alert go inert unnoticed. A rule
  file that is named but missing, and an `expr:` the reader cannot parse, are
  both errors rather than skips. It also flags a panel or alert reading a
  recording rule no rule file defines.
- The Option A alert-rule test asserted the recording rule's expression as
  TEXT, which stayed green while the rule it pinned went inert. It now also
  asserts the rules against `METRIC_DEFINITIONS`: every `mcp_*` series a rule
  reads must be declared, and every label it groups by must exist on one of
  them.
- The dashboard generator renders an unlabelled metric as `max(metric)` rather
  than the degenerate `max by () (metric)` with an empty legend.
- `migrate` no longer rewrites an identifier wherever it appears once a file
  imports it. Each occurrence is now classified by syntactic position, and only
  the import specifier and plain references are rewritten. Property accesses,
  object keys, object shorthand and declaration bindings are reported as
  `manual` findings with line numbers instead.
  Two of those shapes silently corrupted adopter code AND compiled, so the
  compile-error backstop the design relies on could not see them: `cfg.durability`
  on the adopter's own object was renamed along with the import, and
  `{ durability }` shorthand became `{ durable }` — a different emitted key.
  No adopter was affected: no shipped migration has a `source` rule, so this
  path has never run outside tests. Fixed ahead of the first one that does.
  A file can now produce both a `rewrite` and a `manual` finding; previously the
  engine kept only one finding per file per rule.

### Changed
- An audit record's `registryHash` is now server-authored on every path (#218).
  It previously fell back to `command.registryHash` — the value the CALLER sent
  — whenever dispatch failed before stage 1 captured a snapshot hash, which
  every call naming an unknown operation does. Such records now carry the new
  `AUDIT_REGISTRY_HASH_UNRESOLVED` sentinel (`'unresolved'`) instead.
  **Covered surface — audit-log contents** (compatibility-policy §5). A consumer
  that read `registryHash` from an unknown-operation record was reading the
  caller's claim, so the value it saw was never evidence of anything; it now
  reads a sentinel that says resolution never happened.
  Two problems, and the second is why tagging the value's provenance would not
  have been enough: the field is exempt from audit redaction (it is in
  `AUDIT_STRUCTURAL_FIELDS`, justified as non-sensitive *by construction*), so a
  caller-controlled string reaching it was both a misattribution and an
  unredacted channel into the audit log — a caller could post arbitrary text
  through a surface that strips everything else. Labelling smuggled content
  does not stop it arriving.
  `OperationCommand.registryHash` is consequently read nowhere now. It stays,
  because it is a required field on a public type and removing it would be
  breaking under §1; it is documented as inert.

- The `@modelcontextprotocol/sdk` peer-dependency range moves from `^0.5.0` to
  `^1.24.0`, clearing GHSA-w48q-cv73-mx4w (#140) — high severity, "does not
  enable DNS rebinding protection by default". `npm audit` now reports **0
  vulnerabilities**.
  Not an enumerated covered surface — `docs/compatibility-policy.md` does not
  cover peer-dependency ranges — but it is a **major** bump across the SDK's
  `0.x` → `1.x` boundary and would break an adopter pinned to `0.5.x`. No such
  adopter can exist yet: all thirteen workspaces are `private: true`, so nothing
  has been published (#173).
  The compatibility risk to this repository is close to nil, and the reason is
  worth recording rather than asserting: **the SDK is never called at runtime.**
  Its entire usage is one deliberately-unused *type-only* import in
  `packages/transports`, kept as a boundary marker and enforced by
  `check-sdk-boundary.mjs`. `Server` is still exported from the same path in
  `1.30.0`, so `tsc -b --force` is clean and all 1,432 tests pass unchanged.
  The advisory's mechanism was never reachable here either — the transport
  implements its own host-header validation for DNS rebinding, independent of
  the SDK. The bump is still right: the range is what an adopter installs from.
- The network-access guard's gateway exemption is now the single file that needs
  it, `packages/gateway/src/server.ts`, rather than the whole of
  `packages/gateway/src/` (#181).
  Not a covered surface — this is CI tooling, and no shipped behaviour changes.
  It is recorded because it narrows what the guard behind
  `docs/telemetry-policy.md`'s no-outbound-call promise will let through: an
  outbound call added anywhere else in the gateway package is now caught rather
  than exempted. Nothing in that package made one, so no existing code moves.
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
