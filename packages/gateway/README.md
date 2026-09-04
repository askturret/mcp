# @askturret/mcp-gateway

Standalone compatibility gateway — serves MCP from an OpenAPI spec and proxies
to an existing API (§11.3, ADR-020, #57).

```bash
npx @askturret/mcp-gateway \
  --spec ./openapi.yaml \
  --overlay ./askturret.mcp.yaml \
  --upstream https://api.example.com \
  --port 7000
```

> **`@askturret/mcp-gateway` is on npm**, so the `npx` line above resolves
> without a checkout. No version is quoted here on purpose — `npm view
> @askturret/mcp-gateway version` is the authoritative answer and cannot go
> stale, whereas a number written on this page can.
> [`docs/releasing.md`](https://github.com/askturret/mcp/blob/main/docs/releasing.md)
> lists which workspaces are public.

## What it is for

The gateway is the topology for adopters whose **application code cannot be
modified**. §11.3 is explicit that this is a *secondary* path: it adds a network
hop and an auth boundary the embedded runtime does not have. Prefer
`expressMcp()` / `fastifyMcp()` when you can change the application.

It is **not** a replacement for the embedded runtime, and **not** the
multi-tenant fleet layer (§20.3.A, commercial).

## It is the same runtime

Discovery, compilation, the overlay pass, the dispatcher, the policy engine, the
audit sink and the transport are all `@askturret/mcp-*`. What the gateway adds
is process-shaped: argument parsing, a config file, two listeners and a shutdown
sequence. Nothing in it re-decides anything §10.2 or §5.3 already decides.

That matters most for the **presets**. `--preset regulated` calls core's
`regulatedPreset()` and lets its refusals propagate untouched — so
`--audit-sink stdout` refuses at boot with core's own message and its stable
`control` field, rather than with a gateway paraphrase that could drift from
§10.2.

## Configuration

Every setting is available as a CLI flag and as a config-file key. **Flags beat
the file.** Unknown keys are *refused*, not ignored — a typo would otherwise
boot a gateway that looks configured and is not.

```yaml
# askturret.gateway.yaml
spec: ./openapi.yaml
overlay:
  - ./askturret.mcp.yaml
upstream: https://api.example.com
port: 7000
basePath: /mcp
preset: production
audit:
  sink: jsonl
  path: /var/lib/askturret/audit.jsonl
metricsPort: 9464
permissions:
  listPets: [pets:read]
```

```bash
npx @askturret/mcp-gateway --config ./askturret.gateway.yaml --port 8080
```

Run `--help` for the full flag list. YAML is parsed by core's deliberately small
subset parser, which **refuses what it does not understand** rather than
guessing — a mis-parsed `upstream` is a gateway proxying somewhere nobody asked
for.

### Regulated mode needs a module, not just a file

`RegulatedPresetOptions.verifyEvidence` is a **function**, and no YAML can hold
one. Core refuses to ship a default on purpose: a verifier that accepted any
proof would make the evidence policy decorative, and one that rejected every
proof would fail each guarded call at runtime instead of at boot.

So the gateway takes a module path:

```bash
--preset regulated \
--audit-sink jsonl --audit-path /var/lib/askturret/audit.jsonl \
--acknowledge-redaction-review \
--verify-evidence ./verify-evidence.js
```

```js
// verify-evidence.js
export function verifyEvidence(evidence, context) { /* your scheme */ }
```

Omit it and core refuses at boot — which is the correct outcome, and is the
*library's* refusal rather than one the gateway invented.

## Observability

- **Audit** — core's sinks (`stdout`, `jsonl`), forwarded to the dispatcher.
- **Metrics** — a Prometheus scrape endpoint on its own port (default `9464`),
  driven off core's `METRIC_DEFINITIONS` so the exposition cannot drift from the
  catalogue. Label cardinality is *enforced* via `assertLabelsAllowed`.
- **Traces** — core's no-op tracer by default (§Delivery makes no-exporter the
  default). Wire an OTel SDK to export spans; the compose example runs a
  collector.

Two ports is deliberate: an operator can publish the MCP port and keep the
scrape endpoint on an internal interface.

Histograms expose `_sum` and `_count` but **no `_bucket` series**, so no
quantiles — bucket boundaries are a per-metric choice §9.2 does not specify, and
guessing them would bake the guess into an exposition format. Use the OTel path
if you need quantiles.

## Health

`/health/live` and `/health/ready` are served on the **MCP port**, not the
metrics port: an orchestrator probes the port it routes traffic to, and a probe
answered by a different listener can report healthy while the one carrying
requests is wedged.

## Docker

```bash
# From the workspace root — the image compiles the gateway and its siblings
# from source rather than installing them, so it builds the working tree.
docker build -f packages/gateway/Dockerfile -t askturret/mcp-gateway .
```

A full worked setup — gateway + mock upstream + OTel collector, in one command —
is in [`examples/gateway-compose`](https://github.com/askturret/mcp/tree/main/examples/gateway-compose).

## Publishing

Three acceptance items on #57 are **release steps, not engineering steps**, and
are tracked separately:

| Step | State |
|---|---|
| npm publish | **done** — the package is on the registry; `npm view @askturret/mcp-gateway version` is the authoritative answer |
| Docker image publish | outstanding — registry choice + credentials |
| MCP Registry entry | outstanding — the above, plus the §18.8 metadata process |

The gateway is installable from npm and runnable from source. What remains is
the Docker and MCP-Registry distribution, not npm. See the follow-up issue
linked from #57.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
