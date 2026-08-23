# Reliability suite

The load, chaos and shutdown/reload bank for the resilience tier (§12.1, §17
criterion 10). It lives in `packages/reliability` and can be run whole, or as
individual scenarios against your own deployment.

## What this suite is for — and what it deliberately is not

Every resilience primitive already has unit coverage: bulkheads shed at
capacity (#43), retries respect the effects matrix (#45), breakers open and
recover (#46), a drain waits for in-flight calls (#47), audit survives
shutdown (#48). Repeating those here would add runtime without adding
coverage.

This bank exists for the **seams between them** — the behaviour that only
appears when two primitives meet under load:

| Scenario | Seam |
|---|---|
| `saturationDoesNotTripBreaker` | bulkhead × breaker |
| `retryHoldsBulkheadPermit` | retry × bulkhead |
| `partialFailureIsolatesGroups` | breaker scoping, under concurrency |
| `partialFailureWithoutGrouping` | breaker scoping, **unconfigured** |
| `reloadDuringDrain` | reload × shutdown |
| `overlappingSwapsUnderLoad` | snapshot isolation under load |
| `shutdownUnderLoad` | shutdown × audit durability |
| `chaosPreservesTypedErrors` | the wire contract under random failure |
| `boundedResourceUsage` | §17 criterion 10 |

## Running it

```bash
# PR scale — runs as an ordinary test suite
npm test --workspace=packages/reliability

# Full evidence, printed rather than merely asserted
node packages/reliability/bin/run.mjs
node packages/reliability/bin/run.mjs --json

# Nightly scale
RELIABILITY_SCALE=nightly node --expose-gc packages/reliability/bin/run.mjs
```

Scale knobs: `RELIABILITY_SCALE=nightly`, or individually
`RELIABILITY_CONCURRENCY`, `RELIABILITY_CALLS`, `RELIABILITY_CHAOS_ROUNDS`.

The **shape** asserted is identical at both sizes; only the counts change.
That is what makes the small run meaningful rather than a different test
wearing the same name.

## Layers

| Layer | Covers |
|---|---|
| Load | sustained calls, bounded resources, no unhandled rejections |
| Slow upstream | bulkhead queues then sheds `QUEUE_FULL`; **deadlines fire** |
| Partial failure | breaker opens for the failing group only |
| Shutdown under load | readiness flips, in-flight drain, audit persisted |
| Reload under load | every call completes on the snapshot it entered with |
| Chaos | typed-error invariants hold; no internal detail leaks |
| **Reference Petstore** | every layer above, against a compiled reference spec |

### The reference-Petstore layer

`packages/reliability/src/scenarios/petstore.ts` takes
`examples/petstore-light/openapi.yaml` through the real adopter path —
`fromOpenApi().discover()` then `createCompiler().compile()` — and re-runs
every layer against whatever comes out. Nothing is hand-shaped.

This matters beyond satisfying the acceptance criterion, because compiled
operations differ from the suite's synthetic ones in ways the scenarios care
about. They carry a real `executor.config.baseUrl`, so breaker assignment
resolves by **URL prefix** (rule 2) rather than by annotation (rule 1) — a
branch of `assignBreaker` no other scenario reaches. Their `effects.retryable`
is derived from the spec's verbs rather than set by hand.

The upstream is stubbed: "reference Petstore server" here means a real compiled
Petstore **registry**, not a live host. What is under test is the resilience
tier driving real operations — not whether an example domain resolves, which
would make this suite fail for reasons unrelated to reliability.

### Deadlines

Enforcement lives in the **transport**, not the dispatcher: stage 7 is
explicitly a no-op that hands `deadline` and `signal` to the executor, so an
executor ignoring both would run forever. The transport races dispatch against
a timer.

Every executor in the deadline scenarios therefore **ignores the signal
completely**. A scenario using a well-behaved executor would pass whether or
not the transport raced anything, because the executor would have honoured the
signal itself — leaving the assertion nowhere to fail.

## Three findings this suite surfaced

### Breaker isolation is not the default

`#46` scopes breakers per upstream group. **That scoping is not automatic.**
With no `annotations.breakerGroup` and no `executor.config.baseUrl`,
`assignBreaker` falls through to `default` — so every operation shares one
breaker, and a single failing dependency opens it for the whole server.

```
unconfigured:  { default: 'open',   failingGroup: 'closed' }   healthy: 25/60 ✗
configured:    { failingGroup: 'open', healthyGroup: 'closed' } healthy: 60/60 ✓
```

This is not a defect — the assignment rules are documented and deliberate —
but it is a configuration hazard, and the blast radius it removes is the one
`§8.5` exists to contain. **Give each upstream a group.** Both cases are
pinned by tests so the behaviour is a decision rather than a surprise.

### A retry holds its bulkhead permit

The permit is acquired at stage 6; the retry loop lives inside stage 8. A call
that retries three times occupies its slot for all three attempts plus the
backoff between them, so **effective concurrency falls as the retry rate
rises** — a bulkhead sized for N callers serves fewer than N against a failing
upstream.

That is the correct design (releasing between attempts would let a retry lose
its place and starve), but size for it: `concurrency × maxAttempts` is the
worst-case occupancy.

### A deadline expiry reported itself as `CANCELLED` — fixed

Found by the deadline layer added in QA round 1, and a genuine defect rather
than a spec gap.

The transport's deadline timer called `abortController.abort()` and *then*
resolved the race with `TIMEOUT`. But `abort()` dispatches its event
**synchronously**, so the cancellation branch resolved first and won the
`Promise.race` every time. The `TIMEOUT` branch was unreachable on every
deadline expiry.

The effect: a client could not distinguish *"you ran out of time"* — a property
of their own request, which they may reasonably retry — from *"the server
cancelled you"*, which is a decision made about them. That is the same
collapse-two-distinct-causes-into-one-code class as
[#124](https://github.com/askturret/mcp/issues/124).

The fix is purely ordering: settle the race first, then abort. The deadline now
wins its own race, while an abort from anywhere else — a shutdown drain (§8.6)
or `notifications/cancelled` — still reports `CANCELLED`, because the deadline
timer never fired. Both causes stay distinguishable, and the §8.6 drain
assertions in `packages/transports` continue to pass unchanged.

No test asserted `TIMEOUT` before this, which is why it went unnoticed.

## Measurement honesty

- **Heap growth** is reported always, and only *asserted* when the runtime can
  force a collection (`--expose-gc`). `heapUsed` moves with GC scheduling, and
  a memory assertion that fires on timing rather than on leaks is one that
  gets disabled — which costs more than it catches. The nightly job runs with
  `--expose-gc`, where the 20% ceiling is enforced.
- **Event-loop lag** is the honest complement: sampled continuously, sensitive
  to blocking work rather than allocation. Together the two distinguish
  "leaking" from "busy".
- **Chaos is seeded.** A failing nightly run reproduces exactly from its seed;
  `Math.random` could not offer that.
- **Thresholds are widened on CI** relative to §51's figures (readiness flip,
  event-loop lag) because these machines are shared. The tight figures are
  enforced by the nightly run, and the gap is stated here rather than left as
  an unexplained constant.

## What is mutation-verified, and what is not

These assertions were confirmed by breaking the primitive and watching the
suite go red:

| Broken primitive | Caught by |
|---|---|
| breaker assignment always returns `default` | partial-failure isolation |
| drain resolves immediately | shutdown-under-load audit-at-close |
| retry attempt budget ignored | retry-holds-permit |
| `INTERNAL_ERROR` leaks the underlying message | chaos typed-error invariants |
| audit record re-reads the registry mid-flight | reload-during-drain audit hashes |
| deadline timer aborts before settling the race | deadlines-fire-correctly |
| annotated breaker group silently falls back to `default` | breaker-group-not-configured warning |

### The reload/drain scenario is a real guard — corrected

An earlier revision of this document called the reload/drain scenarios
*regression witnesses rather than verified guards*, on the grounds that four
separate edits failed to flip them. **That was too weak, and QA was right to
push back on it.**

The four edits that failed all targeted the **context** path — re-reading the
registry when the context is built, or when the executor is invoked. Those
cannot flip, and for a sound reason: the guarantee there is structural. The
snapshot is captured once at dispatch entry and threaded as immutable data, so
no live reference exists to re-read.

The **audit** path is different, because it composes its record *after* the
executor returns. Replacing `registryHash: context.registryHash` with
`this.registry.current().hash` in the dispatcher's audit-record builder fails
the audit-hash assertion, and only that one. So the scenario does guard a real
and plausible bug class — an audit record attributing a call to a contract it
never ran under.

The distinction still matters and is worth keeping in mind when reading the
suite: **structural guarantees cannot be mutation-tested, and an assertion that
cannot fail proves nothing about the code.** The honest statement is narrower
than either extreme — the context half is structural and untestable, the audit
half is genuinely guarded.

## Golden dashboards

`packages/reliability/dashboards/reliability.json` is importable into Grafana
and is **generated** from `METRIC_DEFINITIONS`, not hand-written:

```bash
node packages/reliability/bin/generate-dashboard.mjs
```

A test asserts the committed file equals the generated one, so a metric added
without a panel fails CI instead of silently producing a dashboard that shows
less than the runtime emits. Expressions are chosen per metric kind — counters
get `rate()`, histograms get `histogram_quantile`, gauges get neither, since a
gauge wrapped in `rate()` is meaningless and a counter graphed raw is a rising
line that says nothing.

## Running subsets against your own deployment

Every scenario is exported and takes a `ReliabilityScale`, so you can import
the ones relevant to your configuration:

```ts
import { partialFailureIsolatesGroups, PR_SCALE } from '@askturret/mcp-reliability';

const evidence = await partialFailureIsolatesGroups(PR_SCALE);
console.log(evidence.breakerStates);
```

Each returns **structured evidence** rather than asserting, so you can apply
thresholds appropriate to your own deployment rather than inheriting ours.

## Scope

Deliberately limited to what this runtime controls. Distributed correctness of
external systems — jepsen-style testing — is out of scope per §51, and nothing
here should be read as a claim about it.

## CI

- **Pull requests** run the suite at PR scale, as an ordinary test job.
- **Nightly** runs it at load with `--expose-gc` and reports the evidence.

§51 asks for load and chaos on merge rather than per PR because they are slow.
The scaled PR run keeps the *shape* verified on every change while the nightly
run carries the load figures.
