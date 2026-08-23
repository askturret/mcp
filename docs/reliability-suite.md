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

## Two findings this suite surfaced

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

Four assertions were confirmed by breaking the primitive and watching the
suite go red:

| Broken primitive | Caught by |
|---|---|
| breaker assignment always returns `default` | partial-failure isolation |
| drain resolves immediately | shutdown-under-load audit-at-close |
| retry attempt budget ignored | retry-holds-permit |
| `INTERNAL_ERROR` leaks the underlying message | chaos typed-error invariants |

The **reload/drain** scenarios are regression witnesses rather than verified
guards. Four separate edits — re-reading the registry when the context is
built, when the executor is invoked, and when the audit record is composed —
all failed to flip them, because the guarantee is structural: the snapshot is
captured once and threaded as immutable data, so no live reference exists to
re-read. That is the strongest answer to "is this safe?" and the weakest to
"does this test guard it?". They would catch a future refactor that
reintroduced a live read; they are not evidence of a live guard, and are not
counted as such.

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
