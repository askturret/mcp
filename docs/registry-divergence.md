# Registry hash divergence

The last-line safety net for the §11.2 horizontally-scaled topology (#64).

> **You are probably here because `McpRegistryHashDivergence` fired.** Skip to
> [Responding to the alert](#responding-to-the-alert).

## What divergence is, and why it is worse than an outage

§11.2: *"All instances compile the same configuration and expose the same
registry hash. Readiness should fail or alert if hashes diverge unexpectedly
across a deployment."*

Every instance compiles the same spec and overlays into a registry snapshot, and
stamps that snapshot with a hash. Two instances serving **different** hashes are
serving different tool surfaces — so `tools/list` returns one answer from one pod
and a different answer from another, and a `tools/call` an agent was told would
work is refused by whichever instance the load balancer picked.

That is harder to diagnose than a crash. Nothing is down, error rates look
normal, and the symptom is an agent that "sometimes" cannot find a tool. The
detectors below exist so this shows up as a signal rather than as a support
ticket three weeks later.

**The usual cause is configuration, not code:** a stale ConfigMap, a Deployment
that did not fully roll, a volume mounted from the wrong source, or two overlay
files that were meant to be identical and are not.

## Every instance reports its hash

```bash
curl -s localhost:7000/mcp/health/ready | jq .registryHash
```

Present whether or not the instance is ready — comparing it across pods by hand
is how divergence is confirmed, and a field that only appeared on failure would
be missing exactly when someone went looking for it.

Also emitted as **`mcp_registry_hash_id`**, which is what Option A watches. Its
VALUE is the first 13 hex digits of that hash read as a number, and it carries
no labels of its own.

The identity is a value rather than a label on purpose. A `registry_hash` label
mints a brand-new time series on every reload — one that is never reclaimed, so
the series count grows for as long as the deployment lives (#136). Truncating
the hash does not help: that bounds the label's *width*, not the number of
distinct values it can take. As a value there is exactly one series per
instance, and `count_values` rebuilds the grouping at query time.

To go from a number back to the hash:

```bash
printf '%013x\n' 2844626588163943    # -> a1b2c3d4e5f67
```

which is the leading prefix of the `registryHash` above.

---

## Option A — external check (the default)

**Ship this one unless you have a reason not to.** No coordination between
instances, no shared store, no application configuration: Prometheus already
scrapes every pod, so the comparison is something the monitoring stack makes for
free.

Load [`examples/dashboards/alerts.yaml`](../examples/dashboards/alerts.yaml):

```yaml
- record: mcp:registry_hashes:count
  expr: count by (job) (count_values by (job) ("registry_hash", mcp_registry_hash_id))

- alert: McpRegistryHashDivergence
  expr: mcp:registry_hashes:count > 1
  for: 5m
```

`count_values` rather than `count by (registry_hash)` because the hash is the
metric's value, not a label on it — see [Every instance reports its
hash](#every-instance-reports-its-hash) for why. The synthesised
`registry_hash` label is therefore decimal.

### Why `for: 5m` is the whole design

A rolling update legitimately runs two hashes at once, for as long as the
rollover takes. **Alerting on divergence itself would fire on every successful
deploy** — and an alert that fires on correct behaviour is one that gets
silenced, after which it does not fire on the incorrect behaviour either.

So the signal is not *"hashes differ"* but *"hashes have differed for longer than
a deploy takes"*. Raise the window if your rollouts are slower. Lowering it below
your p99 deploy duration converts this into a deploy-noise alarm.

`by (job)` is §64's scope rule in PromQL: one Prometheus scraping prod and
staging must compare each against itself, or it alerts permanently on a correct
setup. Substitute whatever label identifies a deployment for you — `namespace`,
`cluster`, `env`.

---

## Option B — internal check (opt-in)

Instances announce `(instanceId, registryHash)` to a store you provide, read the
set back on a timer, and flip `/health/ready` to **503** with a
`registry-divergence` reason when a foreign hash persists in scope.

```ts
import { createDivergenceMonitor } from '@askturret/mcp-core';

const monitor = createDivergenceMonitor({
  store,                                  // yours: Redis, a shared file, a ConfigMap
  instanceId: process.env.HOSTNAME!,
  scope: 'petstore-prod',
  currentHash: () => registry.current().hash,
  refreshMs: 15_000,
  graceMs: 300_000,                       // matches Option A's `for: 5m`
});
monitor.start();

expressMcp({
  sources: [...],
  transport: { registryDivergence: () => monitor.state() },
});
```

The store contract is two methods — `put` and `list`. No transactions, no
watches, no locking.

### ⚠️ What Option B costs

**Sustained divergence flips every instance to 503, so the deployment leaves
rotation entirely.**

That is the intended behaviour for an adopter who considers an inconsistent tool
surface worse than being unavailable — a regulated deployment where a
`tools/call` decision must match the `tools/list` that advertised it. For
everyone else it is the wrong trade, and it is why Option A is the default:
**an alert costs a human's attention; this costs availability.**

### Three behaviours that make it safe to switch on

| Situation | What happens | Why |
|---|---|---|
| Rolling update | Ready throughout, for `graceMs` | Otherwise the first new pod would take every old pod out of rotation and the deploy would take the service down |
| Peer store unreachable | `unknown`, stays **ready** | The monitor's dependency failing must not become the application's failure — that is the outage amplification §8.7 forbids |
| A pod dies mid-deploy | Its entry expires after `staleAfterMs` | Without expiry the deployment would diverge against a ghost forever, and the next rollout would wedge readiness for good |

A store outage deliberately does **not** reset the divergence clock. A store
failing intermittently during a real divergence would otherwise postpone the
verdict indefinitely.

---

## Responding to the alert

**1. Confirm it is not a slow rollout.** Check whether a deploy is in progress.
If the rollover is genuinely slower than 5m, the window is too tight — raise it
rather than silencing the alert.

**2. Find the minority side.**

```promql
mcp:registry_instances_by_hash:count{job="your-job"}
```

One instance disagreeing with fifty is a pod that failed to roll. An even split
is a half-applied configuration change. `McpRegistryHashDivergenceMajoritySplit`
fires separately for three or more hashes, which means several configurations
are in flight at once — usually overlapping deploys.

**3. Compare the inputs, not the pods.** The hash is derived from the compiled
snapshot, so identical images can still diverge if their spec or overlays
differ. Check what each pod actually mounted.

**4. Do not auto-remediate.**

> The runtime does not know which hash is correct, and neither does the alert.
> Killing the minority can delete the only pods running the **right**
> configuration — for example when a rollout is correct and the majority is
> stale. §64 puts auto-remediation explicitly out of scope for this reason.

---

## Non-goals

- **Auto-remediation.** See above.
- **Cross-region divergence.** The reference architecture is per-cluster;
  cross-region belongs to the commercial fleet layer (§20.3.A).

---
*Operum Engineer · [operum.ai](https://operum.ai)*
