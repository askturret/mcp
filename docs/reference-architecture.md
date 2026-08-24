# Production Reference Architecture

The deployment topology we have verified, and the reasoning behind each choice
that is easy to get dangerously wrong.

This is the §11.2 horizontally scaled stateless topology. Two runnable
implementations of it ship in this repository, and they are the same
architecture at two sizes:

| | Where | For |
|---|---|---|
| Helm chart | [`examples/deployments/kubernetes/`](../examples/deployments/kubernetes/) | Orchestrated, multi-node |
| Compose stack | [`examples/deployments/docker-compose/`](../examples/deployments/docker-compose/) | One host, evaluation |

Both run **two instances**, not one. Every property this page is about —
registry consistency, per-instance breaker state, one shared audit sink — is
invisible with a single instance, and a one-instance reference would
demonstrate none of them.

---

## 1. Reference topology

```
                          ┌──────────────┐
             agents ─────►│ Load balancer│
                          └──────┬───────┘
                                 │  (round-robin, no session affinity)
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
      ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
      │  MCP instance │  │  MCP instance │  │  MCP instance │
      │      #1       │  │      #2       │  │      #N       │
      │               │  │               │  │               │
      │ registry.hash │  │ registry.hash │  │ registry.hash │
      │   a1b2c3   ◄──┼──┼── must match ─┼──┼──►  a1b2c3    │
      │               │  │               │  │               │
      │ breakers      │  │ breakers      │  │ breakers      │
      │ bulkheads     │  │ bulkheads     │  │ bulkheads     │
      │ (per-instance)│  │ (per-instance)│  │ (per-instance)│
      └───┬───────┬───┘  └───┬───────┬───┘  └───┬───────┬───┘
          │       │          │       │          │       │
          │       └──────────┴───┬───┴──────────┘       │
          │                      ▼                      │
          │        ┌─────────────────────────┐          │
          │        │  telemetry collector    │          │
          │        │  (Prometheus / OTLP)    │          │
          │        └─────────────────────────┘          │
          │                                             │
          └──────────────┬──────────────────────────────┘
                         ▼
              ┌─────────────────────┐        ┌──────────────────┐
              │ durable audit sink  │        │ upstream services│
              │  (ONE, shared)      │        │    (shared)      │
              └─────────────────────┘        └──────────────────┘
```

**Stateless in the sense that matters:** no instance holds state another
instance needs. Instances hold plenty of *local* state — breaker counters,
bulkhead permits, the compiled registry — but none of it has to be shared for
a request to be served correctly by any instance.

That is what makes round-robin safe and why **no session affinity is
required**. If you find yourself needing sticky sessions to get correct
behaviour, something has been introduced that this topology does not assume,
and the assumptions below stop holding.

---

## 2. Sizing guidance

> **Read this section's caveat first.** The numbers an operator wants here —
> "CPU/memory per instance × QPS band" — **do not exist yet, and are
> deliberately not printed below.**
>
> The [reliability suite](reliability-suite.md) is a fault-injection and
> interaction harness, not a load generator. Its own harness says so
> explicitly: it drives concurrency in-process to test how the primitives
> behave *together* — a reload landing mid-drain, a bulkhead rejection
> reaching a breaker — and it records **no throughput or resource
> measurements** at all.
>
> Publishing a sizing table derived from anything else would mean inventing
> numbers, and a reference architecture is the worst place for that: the
> numbers would be copied into capacity plans and carry the authority of a
> checked-in document. Measuring this properly is tracked in
> [#197](https://github.com/askturret/mcp/issues/197).

What can be said without measurements:

**CPU is the dimension to tune first.** The runtime's per-call work is
JSON serialization, policy evaluation and schema handling — all CPU-bound and
all on one event loop per instance. Memory is dominated by the compiled
registry, which is a function of *spec size*, not of traffic.

**Do not set a CPU limit unless your platform forces you to.** CPU limits
throttle the event loop precisely in the tail-latency region the deadline
budget is defending, and the symptom is a p99 that no profile explains. Set
the *request* so the scheduler places the pod correctly, and leave the limit
off. Memory is different: it is incompressible, so `request == limit` is
right there, and a limit above the request just invites the OOM-killer to reap
a pod mid-request.

**Scale out, not up.** One instance is one event loop. A second core does
comparatively little for a single instance, so past roughly one CPU per
instance the return on a bigger pod falls off and another replica is the
better spend.

### Measuring it for your workload

Your spec, your policies and your upstreams dominate, so measure rather than
extrapolate from anyone's table. From the shipped dashboards:

1. Drive representative traffic and raise it until **p99 tool latency**
   (Overview) starts climbing while upstream latency (Reliability) stays flat.
   The gap is your runtime's own overhead — that knee is the per-instance
   ceiling.
2. Watch **bulkhead queue depth** (Reliability). Depth that stops returning to
   zero means arrival rate has passed service rate: you are already saturated,
   whatever the CPU graph says.
3. Size to roughly **60–70% of the knee** so a rolling deploy — which removes
   capacity while `maxSurge` adds it back — does not push the remaining
   instances over.

---

## 3. Deployment mechanics

### Rolling updates and drain

A rolling update legitimately runs two configurations at once. Everything below
exists to bound that window and to make sure no in-flight call is lost inside
it.

Three settings, and they are ordered by how badly each fails:

| Setting | Reference | Why |
|---|---|---|
| `terminationGracePeriodSeconds` | 60 | Must exceed the pre-stop pause **plus** your longest deadline, or SIGKILL truncates the calls draining exists to protect |
| `preStopDelaySeconds` | 5 | Endpoint removal is asynchronous; without a pause the pod stops accepting while the LB is still routing to it |
| `maxSurge` / `maxUnavailable` | 1 / 0 | Holds capacity flat and bounds how long two registry hashes coexist |

**The pre-stop pause is the one that looks superfluous and is not.** A pod is
removed from Service endpoints and sent SIGTERM at about the same moment, and
in-flight `kube-proxy` updates take a beat to propagate. Without the pause the
runtime begins refusing connections while the load balancer is still sending
them, which reaches clients as connection resets on *every* deploy — including
successful ones.

**`maxSurge` interacts with the divergence alert.** Two hashes coexist for as
long as the rollover takes, and the divergence detector debounces for 5
minutes. A rollout that can exceed that window will fire the alert on a
perfectly correct deploy — and an alert that fires on correct behaviour gets
silenced, after which it no longer fires on the incorrect behaviour either. If
your rollouts are slow, raise the debounce to match; do not lower it toward
your deploy time.

### Canary

The registry hash makes canarying unusually legible: a canary is *by
definition* a deliberate, temporary registry divergence.

Run the canary as a **separate Deployment with its own `job` label**, not as
extra replicas of the main one. The divergence rules group `by (job)`, so a
canary sharing the main job would trip the divergence alert for as long as the
canary runs — teaching everyone to ignore it at exactly the wrong time.

With a separate job you get the opposite: each side is compared against itself,
so the alert still protects both, and comparing the two dashboards side by side
*is* the canary analysis.

### Preserving in-flight calls across restarts

There is no cross-instance handoff, and adding one would require the shared
state this topology exists to avoid. What is guaranteed is that a *draining*
instance finishes what it accepted, provided the grace period is long enough.

The failure mode to understand is `OUTCOME_UNKNOWN`: if a pod dies mid-call,
the caller cannot know whether the upstream side effect happened. That is
**distinct from failure and is not safe to blindly retry.** The Reliability
dashboard panels it separately for that reason, and a non-zero rate means some
callers are unable to reconcile.

---

## 4. Multi-instance registry consistency

The topology assumes every instance compiles the same configuration and
publishes the same `registry.hash`. When that breaks, nothing crashes: two pods
answer `tools/list` differently, and an agent is told a tool exists by one
instance and refused by another — intermittently, by load-balancer luck.

Nothing is down, error rates look normal, and the symptom is a tool that
*"sometimes"* isn't there. That is much harder to diagnose than an outage,
which is why it gets a detector rather than a dashboard panel.

**Full mechanics, both detection options, and the runbook:
[`registry-divergence.md`](registry-divergence.md).** In short:

- **Option A (default)** — Prometheus alerts on more than one live hash per
  `job`, debounced 5 minutes. External, needs no coordination.
- **Option B (opt-in)** — instances compare hashes through a shared store and
  flip `/health/ready` to 503. Costs availability rather than attention, and is
  right when an inconsistent tool surface is worse than being unavailable.

Two structural choices in the reference deployment keep the precondition true:

**One ConfigMap, mounted by every replica.** Per-replica configuration is
precisely how hashes diverge. The chart also stamps a config checksum onto the
pod template, so editing the ConfigMap actually rolls the pods — without it,
`helm upgrade` updates the ConfigMap and leaves every pod on the old config
indefinitely, with no rollout in progress to explain it and no time limit on
how long it lasts.

**Readiness and liveness are different endpoints.** This is the single most
consequential pair of settings in the chart.

> `/health/ready` reports NOT READY while draining and on sustained registry
> divergence — conditions that must pull an instance **out of rotation without
> killing it**. `/health/live` reports whether the process is functioning.
>
> If liveness pointed at `/health/ready`, a sustained divergence would fail
> liveness on every replica at once. Kubernetes would restart them all, they
> would return with the same divergent config, and fail again — a
> CrashLoopBackOff caused entirely by the detector installed to prevent a
> quieter problem.

It is a one-word edit to get wrong and gives no feedback until the day it
matters, so it is asserted by a test rather than only explained here.

---

## 5. Audit sink topology

**Point every instance at ONE durable sink.** N instances writing N separate
files produces N partial audit trails that each look complete — which is worse
than an obvious failure, because it is only discovered when someone tries to
answer a question with them.

The reference uses a shared `ReadWriteMany` volume, which is the simplest thing
that satisfies the requirement and also **the assumption most likely to be
false on your cluster**: the default storage class on EKS, GKE and AKS is
`ReadWriteOnce`, which cannot be mounted by two pods at once. With more than
one replica this surfaces as pods stuck `Pending`.

That failure at least announces itself. **The failure to avoid is "fixing" it
by giving each pod its own volume** — that silently converts one audit trail
into N partial ones. If you have no RWM class, point the sink at a real log
pipeline instead.

### When the sink is unreachable

The dispatcher **back-pressures**. It does not drop records and it does not
carry on regardless — under a mandatory-delivery configuration, audit is in the
request path, and a sink that cannot accept writes slows the calls that produce
them.

This is intended, and it is a deliberate trade: **request latency is spent to
protect the delivery guarantee.** Two consequences worth internalising before
you adopt it:

- A slow audit sink presents as slow *requests*, not as an audit alarm. The
  Audit health dashboard's buffer-depth panel is where that becomes legible —
  a gauge sitting near its bound means dispatch is being throttled by audit.
- `mcp_audit_dropped_total` above zero means the deployment is configured in
  **drop** mode, i.e. to violate the delivery guarantee. It is a configuration
  decision, not a transient, and it does not resolve on its own.

The reference SLO is **zero** dropped audit records, and that panel is the one
number the Audit health dashboard exists for.

---

## 6. Circuit-breaker behaviour across instances

**Breakers and bulkheads are per-instance state, and this is intentional.**

Each instance observes its own upstream failures and reacts locally. There is
no distributed coordination, no shared breaker state, and none is planned for
this architecture.

Why this is the right default:

- **It reacts fastest.** A local breaker opens on local evidence, with no
  consensus round-trip. Coordination would add latency to exactly the failure
  path that most needs to be quick.
- **It fails independently.** Shared breaker state is shared *fate*: a
  coordination bug, or a partition, takes out every instance's protection at
  once. That converts a resilience feature into a correlated failure.
- **The evidence is genuinely local.** A pod with an exhausted connection pool,
  a bad DNS answer, or a wedged NIC is seeing a real problem that its
  neighbours are not. A shared breaker would either ignore it or wrongly
  penalise healthy instances.

**What this means when you read a dashboard.** The consequence is that breaker
state is only meaningful **per instance**, which is why the Reliability
dashboard breaks it out by `instance` rather than summing. One pod with an open
breaker while the rest are closed is a *pod-local* problem — not an upstream
outage — and summing those series averages away the only signal that
distinguishes them.

The cost, stated plainly: each instance must independently learn that an
upstream is unhealthy, so a genuinely failing upstream is discovered N times
rather than once. With the failure threshold applied per instance, a fleet
sends up to N times the trial traffic a coordinated breaker would. That is the
accepted price for independence, and it is bounded by the threshold.

---

## 7. Reference SLO targets

Reference targets, **not a contract**. No SLA is committed for the OSS runtime
— see [Non-goals](#9-non-goals).

| Objective | Target | Read from |
|---|---|---|
| Availability | 99.9% of `tools/call` return a **typed** result — success or typed error — within deadline | Overview → error ratio |
| Redaction correctness | Zero incidents | Redaction snapshot tests |
| Audit completeness | `mcp_audit_dropped_total` == 0 under normal load | Audit health → dropped (24h) |
| Outcome certainty | `OUTCOME_UNKNOWN` investigated, not tolerated as noise | Reliability → OUTCOME_UNKNOWN |

"**Typed** result" is the load-bearing word in the availability target. A
typed error is a *success* of the contract: the caller learns what happened and
can act. An untyped 500, a socket reset, or a hang is a failure of it. That is
why the target counts typed errors as met rather than as downtime.

---

## 8. Dashboards

Five Grafana dashboards ship in [`examples/dashboards/`](../examples/dashboards/):

| Dashboard | Answers |
|---|---|
| **MCP overview** | Request rate, error ratio, p50/p95/p99 latency by tool |
| **Policy activity** | Allow/deny counts per phase, redaction hits by rule and surface |
| **Reliability** | Breaker state, bulkhead depth, retries, `OUTCOME_UNKNOWN` |
| **Audit health** | Append rate, buffer depth, and the drop counter that must be zero |
| **Registry** | Reload outcomes and live hash count across instances |

Alert rules — including the registry-divergence detection — are in
[`alerts.yaml`](../examples/dashboards/alerts.yaml) alongside them.

**These files are checked in CI.** `check-dashboard-metrics.mjs` verifies that
every metric and label a panel queries is one the runtime actually emits. The
reason is that this class of drift is silent: a dashboard querying a renamed
metric renders an **empty panel**, not an error, and an empty panel is
indistinguishable from a metric that is legitimately at zero. It would surface
during an incident, at the moment the panel was supposed to earn its keep.

Both reference deployments **mount that same directory** rather than copying
it, so what an operator imports is the artifact CI verified.

---

## 9. Non-goals

- **No SLA for the OSS runtime.** The targets in §7 are reference values to
  design against. An SLA belongs to the commercial support offering.
- **No hosted reference deployment.** Self-hosted only.
- **No distributed breaker coordination.** Per-instance is the design, for the
  reasons in §6 — not a limitation awaiting a fix.
- **No cross-region divergence detection.** The reference is per-cluster.
- **No auto-remediation of registry divergence.** The runtime cannot know which
  hash is correct, and killing the minority can delete the only instances
  running the *right* configuration.

---

## Related

- [Registry divergence detection and runbook](registry-divergence.md)
- [Reliability suite](reliability-suite.md)
- [Telemetry policy](telemetry-policy.md)
- [Architecture overview](architecture-overview.md)
