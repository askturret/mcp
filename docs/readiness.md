# Architectural Readiness for 1.0

This document certifies that the architecture defined in §17 has met all 12 acceptance criteria for a 1.0 release. §17 is not a section of another document — this page is itself that definition, so there is nothing to link to.

Every criterion links to the test or deliverable that verifies it. CI verifies the matrix on every pull request and every push to `main`: if any row is not `✅ met`, the build fails.

**Publication of a `1.0.*` release is refused if any row is red.** The same check runs on `release: published`, and the `publish` job depends on it — so a red matrix means nothing reaches npm. A `0.x` release is advisory: the check runs and reports, but does not block, because this page certifies *1.0* readiness and [the compatibility policy](compatibility-policy.md) makes no guarantee below it.

**Tagging is still not blocked, and cannot be.** GitHub Actions runs after a ref exists, so no workflow can refuse a tag — only fail a run afterwards. The gate is at publication, which is the act that ships artifacts. [`docs/releasing.md`](releasing.md) sets out the full process.

---

## Readiness Matrix

| # | Criterion | Status | Evidence | Owner | Last Verified |
|---|---|---|---|---|---|
| 1 | Canonical model supports OpenAPI, explicit definitions, and two framework adapters without source-specific fields | ✅ met | [Type-level test forbidding source-specific fields](../packages/core/src/__tests__/types.test.ts); [Conformance suite](../packages/adapter-conformance/src/__tests__/conformance.test.ts) green for Express + Fastify | Architecture | 2026-08-24 |
| 2 | Registry snapshot is deterministic and produces a stable hash across processes | ✅ met | [Hash-stability test across two Node processes](../packages/core/src/preset/__tests__/production.test.ts) | Core team | 2026-08-24 |
| 3 | `tools/list` and `tools/call` use the same coherent snapshot during reload | ✅ met | [Concurrent-dispatch test with mid-flight swap](../packages/core/src/reload/__tests__/in-flight.test.ts) | Core team | 2026-08-24 |
| 4 | Policy is enforced both at discovery and invocation | ✅ met | [Discovery enforcement (#34)](../packages/core/src/policy/__tests__/policy.test.ts); [Invocation enforcement (#35)](../packages/core/src/dispatcher/__tests__/authorization.test.ts); [Joint parity test](../packages/core/src/policy/__tests__/discovery-invocation-parity.test.ts) — drives the real `createVisibilityEngine` and `createAuthorizationEngine` from one shared policy and asserts an operation is hidden at discovery **iff** it is denied at invocation; each surface is separately asserted to fail closed when the policy throws | Core team | 2026-08-24 |
| 5 | Cancellation and deadlines reach every official executor | ✅ met | [Per-executor cancellation tests](../packages/core/src/executor/__tests__/via-http.test.ts); [HTTP transport cancellation](../packages/transports/src/http/cancellation.test.ts); [Conformance suite](../packages/adapter-conformance/src/__tests__/conformance.test.ts) category "Cancellation" green | Executors team | 2026-08-24 |
| 6 | Non-idempotent writes are never automatically retried | ✅ met | [`OUTCOME_UNKNOWN` no-retry test](../packages/core/src/retry/__tests__/dispatcher-retry.test.ts); [Exhaustive retry-matrix test](../packages/core/src/__tests__/idempotent-retryable-fuzz.test.ts) — drives the real `decideRetry` and `isRetryEligible` across all 12 error codes × all 16 effect combinations (192 cases): `OUTCOME_UNKNOWN` never retries under any combination, a non-idempotent mutating operation never retries under any code, and a retry is only ever returned for a transient code the effects matrix permits | Core team | 2026-08-24 |
| 7 | Audit records include policy and registry evidence without raw secrets | ✅ met | [`AuditEvent` schema includes `policyDecision`, `registryHash`, `inputDigest`](../packages/core/src/audit/types.ts); [Redaction snapshot test proves no secret appears](../packages/core/src/logging/__tests__/redaction.test.ts) | Audit team | 2026-08-24 |
| 8 | Telemetry passes cardinality and redaction tests | ✅ met | [CI cardinality guard](../.github/scripts/check-metric-cardinality.mjs) green; [Redaction snapshot test](../packages/core/src/logging/__tests__/redaction.test.ts) green | Observability team | 2026-08-24 |
| 9 | Each official adapter passes the shared conformance suite | ✅ met | [Conformance kit](../packages/adapter-conformance/src/__tests__/conformance.test.ts) green for Express, Fastify and Gateway | Adapters team | 2026-08-24 |
| 10 | Load tests demonstrate bounded memory and graceful overload behavior | ✅ met | [Reliability suite sustained-load results](../packages/reliability/src/__tests__/reliability.test.ts): 10-minute sustained load, memory bounded, bulkhead + breaker + retry work together | Reliability team | 2026-08-24 |
| 11 | An MCP SDK upgrade can be completed inside the transport boundary without changes to operation definitions | ✅ met | [Fake-SDK-upgrade drill](../packages/gateway/src/__tests__/deployment-examples.test.ts): upgrades the SDK, re-runs all gateway tests, no change to operation definitions required | Gateway team | 2026-08-24 |
| 12 | A new source or executor can be added as a plugin without modifying core control flow | ✅ met | [`registerSource` / `registerExecutor` on `PluginContext`](../packages/core/src/plugin/types.ts), capability-gated in [`host.ts`](../packages/core/src/plugin/host.ts); [plugin tests](../packages/core/src/plugin/__tests__/plugin.test.ts) register a real `OperationSource` through a plugin and assert it is usable as compiler input. The [reference example](../examples/plugin-otel-exporter/) shows the adopter-facing lifecycle, for an exporter — a source/executor example is tracked in [#270](https://github.com/askturret/mcp/issues/270) as adoption work, not a readiness blocker. | Architecture | 2026-08-24 |

---

## Verification

Both gates below run the same script — [`check-readiness-matrix.mjs`](../.github/scripts/check-readiness-matrix.mjs),
itself self-tested by [`check-readiness-matrix.test.mjs`](../.github/scripts/check-readiness-matrix.test.mjs)
before either gate trusts its verdict. One implementation is what keeps the
commit-time and release-time answers from drifting apart.

**Commit-time gate** (the `test-integrity` job in `.github/workflows/test.yml`):

1. Runs all 12 test suites referenced above.
2. On every pull request and every push to `main`, verifies all rows are `✅ met`.
   It counts only numbered matrix rows and requires exact equality, so a
   restructured table fails rather than silently passing.

**Release-time gate** (the `readiness` job in `.github/workflows/supply-chain.yml`):

3. On `release: published`, evaluates the same matrix. The `publish` job
   declares `needs: [supply-chain, readiness]`, so a `1.0.*` release with any
   red row publishes nothing to npm. `0.x` releases run it advisorily.
4. Writes `met`, `total` and `ok` to `$GITHUB_OUTPUT`, and the verdict to the
   job summary — on both the passing and failing paths, so the machine-readable
   result exists for every run rather than only the ones that fail.

### What it does not do

Listed rather than omitted, because a gate assumed to be stricter than it is
gets trusted for work it never did.

- **It does not block tagging, and no workflow can.** Actions runs after the
  ref exists. [`tag-readiness-advisory.yml`](../.github/workflows/tag-readiness-advisory.yml)
  reports the matrix on a `v*` tag so it is visible before someone publishes a
  Release, but it is advisory and refuses nothing.
- **It does not block a `0.x` release.** Deliberate — this page certifies 1.0
  readiness. The verdict is still reported.
- **It has never run on a real release.** No release has ever been cut from
  this repository, so the release-time path is built and unit-tested but
  unexercised end to end. [`releasing.md`](releasing.md) describes the
  rehearsal that would change that.

What it *does* enforce, it enforces without exceptions: no per-criterion
overrides, and no evidence from unmerged branches.

---

## Non-goals for 1.0

This certification covers **architectural readiness**, not feature completeness:

- No new features in this issue
- Scaling, performance optimization, and advanced resilience patterns are post-1.0
- Documentation, tutorials, and ecosystem integrations are post-1.0

---

## Acceptance Criteria

- [x] All 12 rows are `met`
- [x] Evidence links are current and passing
- [x] CI gate merges into `.github/workflows/test.yml`
- [ ] Release automation refuses to **publish** a red `1.0.*` release — **built,
      not yet exercised.** The `readiness` job gates `publish` in
      `supply-chain.yml` and the evaluator is self-tested, but no release has
      ever been cut from this repository, so the end-to-end path is unproven.
      This box is ticked when a real release run demonstrates it, not when the
      workflow merges. (The original wording — "refuses `1.0.0` tag" — was
      false twice over: nothing had a tag trigger, and no workflow can refuse a
      tag. See [`releasing.md`](releasing.md).)
- [x] Doc merged into `docs/readiness.md`

---

## Related

- [Architecture overview](architecture-overview.md) — the design these criteria are assessed against
- [Releasing](releasing.md) — the release process, and where this matrix gates it

This page is itself the §17 readiness definition. It previously linked to a
`§17 Architectural Readiness` section of the architecture overview and to a
`releasing.md` release checklist; **neither existed at the time**. The `§17`
link is gone, because that section still does not exist. The `releasing.md`
link is back, because [that document now does](releasing.md) — written in
[#269](https://github.com/askturret/mcp/issues/269) along with the gate it
describes.

That sentence was here before this page could support it, which is worth
recording because it is the same defect the page was fixing. The `releasing.md`
link had been removed, but the *claim* it supported survived — the page went on
asserting a release process that refuses a bad tag. And the `§17` link was not
removed at all; it was still live, pointing at an anchor that does not exist in
a file that has no numbered sections. A note describing its own cleanup outlived
the cleanup being finished.

Both gaps were closed in #233: the outward `§17` link is gone, and the
enforcement claims say what CI actually does. #269 then built the mechanism the
stronger claim needed — but note what changed and what did not. Publication is
gated; **the tag still is not**, because no workflow can refuse a tag. The
claim was corrected to match a mechanism, rather than a mechanism being bent to
match the claim.
