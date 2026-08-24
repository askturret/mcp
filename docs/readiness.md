# Architectural Readiness for 1.0

This document certifies that the architecture defined in [§17](architecture-overview.md#section-17-definition-of-architectural-readiness) has met all 12 acceptance criteria for a 1.0 release.

Every criterion links to the test or deliverable that verifies it. The release process refuses to tag `1.0.0` if any row is red.

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
| 12 | A new source or executor can be added as a plugin without modifying core control flow | ✅ met | [`registerSource` / `registerExecutor` on `PluginContext`](../packages/core/src/plugin/types.ts), capability-gated in [`host.ts`](../packages/core/src/plugin/host.ts); [plugin tests](../packages/core/src/plugin/__tests__/plugin.test.ts) register a real `OperationSource` through a plugin and assert it is usable as compiler input. The [reference example](../examples/plugin-otel-exporter/) shows the adopter-facing lifecycle, for an exporter — a source/executor example is tracked in #233. | Architecture | 2026-08-24 |

---

## Verification

**CI readiness gate** (`test-readiness` job in `.github/workflows/test.yml`):

1. Runs all 12 test suites referenced above.
2. On every commit to `main`, verifies all rows are `✅ met`.
3. Refuses to create a tag matching `v1.0.0` or `v1.0.*` if any row is not `met`.
4. Reports the readiness matrix as a structured output.

**The gate will NOT:**
- Create a `1.0.0` release if ANY criterion is red
- Allow overrides for individual criteria
- Accept evidence from unmerged branches

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
- [x] Release automation refuses `1.0.0` tag on any red row
- [x] Doc merged into `docs/readiness.md`

---

## Related

- [Architecture overview](architecture-overview.md) — the design these criteria are assessed against

This page is itself the §17 readiness definition. It previously linked to a
`§17 Architectural Readiness` section of the architecture overview and to a
`releasing.md` release checklist; **neither has ever existed**, so both are
removed rather than left pointing at nothing. Both are tracked in #233.
