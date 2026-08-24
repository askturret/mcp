# Reference deployment — Kubernetes (Helm)

The §11.2 topology as a Helm chart. See
[`docs/reference-architecture.md`](../../../docs/reference-architecture.md) for
the reasoning; this file covers only how to run it.

```bash
helm install mcp . \
  --set-file openapiSpec=../../gateway-compose/openapi.yaml \
  --set config.upstream=http://your-upstream.svc.cluster.local:8080
```

With the Prometheus Operator installed, add monitoring and the
registry-divergence alerts:

```bash
helm upgrade mcp . \
  --set monitoring.serviceMonitor.enabled=true \
  --set monitoring.prometheusRule.enabled=true \
  --set-file monitoring.prometheusRule.rules=../../dashboards/alerts.yaml
```

The alert rules are **injected from the canonical file**, never copied into the
chart. A copy would be a second source of truth for the alert that detects
configuration drift, and nothing would check it. Enabling the flag without
`--set-file` fails the render on purpose: an empty `PrometheusRule` installs
cleanly, appears in `kubectl get prometheusrules`, and alerts on nothing.

## The settings worth reading before you copy this

| Setting | Default | Consequence if wrong |
|---|---|---|
| `livenessProbe` path | `/health/live` | Pointing it at `/health/ready` turns a sustained registry divergence into a fleet-wide CrashLoopBackOff |
| `rollout.terminationGracePeriodSeconds` | 60 | Below pre-stop + longest deadline, SIGKILL truncates draining calls |
| `rollout.preStopDelaySeconds` | 5 | Without it, clients see connection resets on every deploy |
| `rollout.maxSurge` | 1 | An unbounded surge can hold two registry hashes past the 5m debounce and alert on a correct deploy |
| `audit.persistence.accessMode` | `ReadWriteMany` | Most managed clusters default to `ReadWriteOnce`, which cannot be mounted by two pods |
| `resources.limits.cpu` | *unset* | A CPU limit throttles the event loop in the tail-latency region the deadline budget defends |

## `ReadWriteMany` will probably be your first failure

The default storage class on EKS, GKE and AKS is `ReadWriteOnce`. With
`replicaCount: 2` the second pod stays `Pending`.

**Do not fix that by giving each pod its own volume.** One audit trail becomes
N partial ones that each look complete. Either provision an RWM class, or point
the sink at a real log pipeline.

## Scope

Deliberately readable rather than exhaustive: no autoscaling, no ingress, no
service mesh, no external-secrets. Its job is to show the topology and the two
or three settings that are easy to get dangerously wrong.

**Not rendered in CI.** Neither `helm` nor `kubectl` is available in this
repository's test environment, so the chart is not linted or `helm template`d.
The gateway config in `values.yaml` **is** parsed by the gateway's real config
parser, and the probe/rollout invariants above are asserted, by
`packages/gateway/src/__tests__/deployment-examples.test.ts`. Running
`helm lint` and `helm template` against a real cluster is a smoke-test item.
