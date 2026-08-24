# Reference deployment — docker-compose

The §11.2 topology at the smallest size that still demonstrates it. See
[`docs/reference-architecture.md`](../../../docs/reference-architecture.md) for
the reasoning behind each choice here.

```bash
docker compose up --build
open http://localhost:3000        # Grafana — dashboards already imported
```

| Service | Port | What it is |
|---|---|---|
| `lb` | 7000 | nginx, round-robin across both instances |
| `mcp-a`, `mcp-b` | — | Two gateway instances sharing one config |
| `upstream` | — | Mock upstream the spec describes |
| `prometheus` | 9090 | Scrapes both instances, loads the real alert rules |
| `grafana` | 3000 | Dashboards pre-provisioned |

## Two instances, not one

Registry-hash consistency, per-instance breaker state and a shared audit sink
are all invisible with a single instance. A one-instance example would be
simpler and would demonstrate none of them.

## Try the divergence detector

The Registry dashboard should show **1** distinct hash. To watch [#64's
detector](../../../docs/registry-divergence.md) work, give one instance a
different tool surface:

1. Copy `../../gateway-compose/openapi.yaml`, delete an operation from the copy.
2. Mount the copy into `mcp-b` only, in place of the shared spec.
3. `docker compose up -d mcp-b`.

The Registry dashboard's hash count goes to **2** within a scrape interval. The
alert does **not** fire for 5 minutes — that debounce is what stops a normal
rolling update from alerting, and watching it *not* fire immediately is the
part worth seeing.

## What is mounted, and why it is mounted rather than copied

Prometheus and Grafana mount [`examples/dashboards/`](../../dashboards/) — the
same directory CI checks with `check-dashboard-metrics.mjs`. The dashboards you
see here are the verified artifact, not a copy that can drift. The spec and
mock upstream are reused from `../../gateway-compose/` for the same reason.

## Not production-ready as written

- **Anonymous Grafana admin** — evaluation convenience only.
- **No TLS** anywhere.
- **`/metrics` is reachable from the host.** Metric labels carry tool names and
  error codes; keep that port internal in a real deployment.
- **Both instances share one audit file** on a local volume. That is the right
  *topology* (one durable sink) with the wrong *storage* for production.
