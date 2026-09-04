# Gateway + upstream + collector, in one command

A working standalone-gateway deployment (§11.3, #57).

```bash
docker compose up --build
```

Three services, and the third is the point of the exercise:

| Service | Role |
|---|---|
| `upstream` | A mock "existing API" — the application the adopter **cannot modify**. Nothing in it knows what MCP is. |
| `gateway` | Reads `openapi.yaml`, serves MCP on `7000`, proxies to `upstream`. |
| `collector` | An OTel collector that receives OTLP **and scrapes the gateway's metrics endpoint**, so the observability path has a real destination. |

## Try it

```bash
# The tool surface, derived from the spec
curl -s localhost:7000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# A call, proxied through to the upstream
curl -s localhost:7000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"listPets","arguments":{}}}'

# Metrics, on their own port
curl -s localhost:9464/metrics

# Readiness, on the MCP port — the one traffic is routed to
curl -s localhost:7000/health/ready
```

`docker compose logs upstream` shows the proxied request arriving, which is the
network hop §11.3 says this topology adds.

## The line that matters

`askturret.gateway.yaml` sets:

```yaml
upstream: http://upstream:8080
```

The spec's own `servers` entry points at `https://petstore.example.com/api/v1`,
which does not exist. The override is what lets **the spec describe a shape
while the deployment decides the destination** — and it is the setting most
worth copying into a real deployment, where the spec was probably written
against production and you are pointing at staging.

## Worth trying: watch Regulated refuse

Edit `askturret.gateway.yaml`:

```yaml
preset: regulated
audit:
  sink: stdout
```

```bash
docker compose up gateway
```

The gateway **refuses to boot**, with core's own §10.2 message, before it opens
a socket. It is the same refusal the embedded library gives — the gateway calls
`regulatedPreset()` and does not re-implement the rule.

Getting Regulated to actually start needs a durable sink, the redaction-review
acknowledgement, and a `verifyEvidence` module. See the
[gateway README](../../packages/gateway/README.md#regulated-mode-needs-a-module-not-just-a-file).

## Notes

- The audit trail is on a **named volume**, so records survive
  `docker compose down`. A gateway auditing to a container filesystem has an
  audit trail that vanishes with the container.
- `upstream` is not published to the host. The gateway is the front door, and
  exposing the upstream would let you bypass the thing being demonstrated.
- The mock upstream serves `POST /pets` too, which the spec does not expose.
  That is realistic rather than sloppy: an upstream generally has more routes
  than the surface you choose to expose, and the spec is what decides.
- The image is built from the **workspace root** so it compiles the gateway and
  its siblings from source. They are on npm, but installing them would build
  whatever version the registry holds rather than the tree you are running.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
