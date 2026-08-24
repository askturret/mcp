# AskTurret MCP

Add a production-grade MCP layer to your existing API.

Discover from OpenAPI, routes, schemas, or handlers. Shape agent-friendly tools. Govern access. Observe every call.

[![npm version](https://img.shields.io/npm/v/@askturret/mcp.svg?style=flat-square)](https://www.npmjs.com/package/@askturret/mcp)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5%2B-blue?style=flat-square)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green?style=flat-square)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square)](LICENSE)

---

## Quick Demo

<details>
<summary><strong>Click to expand: 20-second terminal demo</strong></summary>

```bash
# Install
npm install @askturret/mcp

# Check readiness of an OpenAPI spec
npx mcp doctor petstore.yaml
# Output:
# ✓ 8/10 operations ready
# ✓ All schemas valid
# ⚠ 2 operations have side effects (require confirmation)

# Create a working MCP server in 5 lines
```

```javascript
import express from 'express';
import { mcpFromOpenApi } from '@askturret/mcp/express';

const app = express();
app.use('/mcp', mcpFromOpenApi('./petstore.yaml'));
app.listen(7000);
```

```bash
# Your API now exposes tools over MCP
curl http://localhost:7000/mcp/tools/list
# Returns: [{"name": "listPets", ...}, {"name": "createPet", ...}, ...]
```

**Explorer UI.** Visit `http://localhost:7000/mcp/explorer` to browse, test, and inspect all tools with a live UI.

</details>

---

## What You Get

### 1. **Immediate result — One API becomes a working MCP server**

Add MCP to your existing API with one function call. No boilerplate, no regeneration, no separate service.

```ts
// Light facade — production-ready defaults
import { mcpFromOpenApi } from '@askturret/mcp/express';

app.use('/mcp', mcpFromOpenApi('./openapi.yaml'));
```

### 2. **Differentiation — Multiple sources, one model**

Combine OpenAPI specs and explicit TypeScript definitions in a single server. Switch between execution strategies (direct handlers, HTTP proxy) without changing tool signatures.

```ts
// Mix multiple sources
import { createMcpServer, fromOpenApi, fromDefinitions } from '@askturret/mcp';

const server = createMcpServer({
  preset: 'production',
  sources: [
    fromOpenApi('./spec.yaml'),        // Discover from OpenAPI
    fromDefinitions(customOps),        // Explicit TypeScript definitions
  ],
});
```

### 3. **Trust — Governance you can audit**

Define policies once. Enforce them at call time. Every action is audited and redacted.

```ts
import { confirmationForEffects, authenticated, allOf } from '@askturret/mcp/policies';

const server = createMcpServer({
  preset: 'production',
  sources: [...],
  policy: allOf([
    authenticated(),                                    // Require identity
    confirmationForEffects(['financial', 'destructive']), // Require approval for risky operations
  ]),
  observability: openTelemetry(),
});
```

### 4. **Lifecycle — Production tools included**

- **`mcp doctor`** — Readiness score. Identifies which operations are agent-ready.
- **Explorer UI** — Browse, test, and inspect tools locally. See policies, confirmation requirements, and execution outcomes.
- **`mcp diff`** — Compare registry snapshots. Track changes across versions.
- **OpenTelemetry** — Traces, metrics, and structured logs. Observe every call in production.

```bash
# Score readiness
mcp doctor ./openapi.yaml

# Run a local mock server
mcp mock --spec openapi.yaml --policies production

# Compare versions
mcp diff snapshot-v1.json snapshot-v2.json
```

---

## Installation

```bash
npm install @askturret/mcp
```

**Requirements:** Node.js 20+, TypeScript 5.5+ — see the [compatibility matrix](docs/compatibility.md) for the full supported-version contract, and the [compatibility policy](docs/compatibility-policy.md) for what we promise about changing it.

---

## How It Works

AskTurret MCP transforms existing APIs into agent-ready tool servers:

```
Discover         Shape              Govern            Serve             Observe
↓                ↓                  ↓                 ↓                 ↓
OpenAPI      →   Agent-friendly  →  Policies       →  MCP tools    →   Audit
Framework        tool names,        (auth,            over HTTP         traces
routes           schemas            confirm,          or stdio          metrics
Handlers         effects            rate limits)                        logs
```

- **Discover:** Import OpenAPI 3.0/3.1, Express/Fastify routes, JSON schemas, or explicit TypeScript definitions.
- **Shape:** Simplify schemas, rename operations, infer effects, apply overlays.
- **Govern:** Enforce authentication, authorization, confirmation challenges, rate limits, redaction.
- **Serve:** Expose tools over MCP (HTTP or stdio). Direct execution or HTTP proxy.
- **Observe:** Trace every call. Audit who did what, when, and why. Export to OpenTelemetry backends.

Learn more: [Architecture documentation](docs/architecture-overview.md)

---

## Supported Sources

| Source | Status | Example |
|--------|--------|---------|
| OpenAPI 3.0 / 3.1 | ✅ Stable | `fromOpenApi('./api.yaml')` |
| Express routes | 📋 Roadmap (v0.4) | — |
| Explicit TypeScript | ✅ Stable | `fromDefinitions(ops)` |
| Fastify routes | 📋 Roadmap (v0.4) | — |
| JSON Schema | 📋 Roadmap (v0.4) | — |
| HTTP proxy | ✅ Stable | `viaHttp({baseUrl: '...'})` |
| Koa routes | 📋 Roadmap (v0.4) | — |
| gRPC | 📋 Roadmap (future) | — |
| GraphQL | 📋 Roadmap (future) | — |

---

## Framework Adapters

Adapters mount MCP into a server you already have. Both first-tier adapters take
the **same options object** — the type is declared once and aliased by each, so
the compiler enforces the parity rather than this table asserting it.

| Framework | Status | Mount |
|-----------|--------|-------|
| Express 4 / 5 | ✅ Stable | `app.use('/mcp', mcpFromOpenApi('./api.yaml'))` |
| Fastify 4 / 5 | ✅ Stable | `app.register(mcpFromOpenApi('./api.yaml'), { prefix: '/mcp' })` |
| Koa | 📋 Roadmap (v0.4) | — |
| NestJS | 📋 Roadmap (community) | — |

The Fastify adapter registers as a properly **encapsulated** plugin: its
content-type parser, hooks and decorators stay inside its own scope, so mounting
it cannot change how the rest of your app parses requests.

### When you cannot change the application

If the code cannot be modified, run the **standalone gateway** instead — a
separate server that reads your spec and proxies to the API you already have:

```bash
npx @askturret/mcp-gateway \
  --spec ./openapi.yaml --upstream https://api.example.com --port 7000
```

It is the *same* runtime — same compiler, same overlays, same presets, same
audit and metrics — packaged as a process rather than as a middleware. It is
also deliberately **secondary**: it adds a network hop and an auth boundary the
embedded adapters do not have, so prefer an adapter when you have the choice.

A one-command worked setup (gateway + mock upstream + OTel collector) is in
[`examples/gateway-compose`](examples/gateway-compose); see the
[gateway README](packages/gateway/README.md) for configuration.

> Not published to npm yet — every workspace here is currently `private`, so
> build and run it from source in the meantime.

### The adapter conformance contract

Every adapter — ours and yours — must pass the same test bank. This is the
contract a new adapter (NestJS, Koa, a community one) has to satisfy before it
can be called an AskTurret MCP adapter.

```bash
npm run test:conformance                      # every registered adapter
npm run test:conformance -- --adapter express # one of them
```

The bank speaks **only JSON-RPC over a real socket**. It never imports a
framework, so it tests the surface a user actually depends on rather than two
code paths it already knows are different. An adapter joins by supplying one
function — build a listening server from the shared options, and close it:

```ts
registerAdapter('koa', async (options) => {
  const server = /* mount the MCP handler and listen */;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => server.close() };
});
```

Eight required categories, each run against every adapter:

| # | Category | What it pins |
|---|----------|--------------|
| 1 | Discovery | operation count, and an identical surface across adapters |
| 2 | Schema preservation | a nested optional readonly field survives end to end |
| 3 | Context propagation | deadline and request id reach the executor |
| 4 | Cancellation | a client disconnect aborts the executor's `AbortSignal` |
| 5 | Error mapping | all 12 `OperationErrorCode` values reach the wire |
| 6 | Authorization | `tools/call` is refused without a principal |
| 7 | Lifecycle cleanup | `close()` releases the listening socket |
| 8 | Duplicate handling | overlapping operation ids resolve to one deterministic winner |

CI runs the bank on every PR and prints the results side by side, so a parity
divergence is visible as a table rather than as one adapter's test failing:

```
category              | express   | fastify   | parity
----------------------+-----------+-----------+-------
cancellation          | PASS      | PASS      | same
```

A new adapter package cannot land and quietly sit outside the suite: the
membership check discovers `packages/adapters-*` from disk and fails the build
if any of them has no registered factory.

---

## Policies & Governance

Three presets for different maturity levels:

### Light (Development)

Minimal policy. Safe for development and prototyping.

- Read-only operations exposed
- Mutating operations require explicit inclusion
- No authentication required
- No audit

### Production (Recommended)

Suitable for controlled environments and internal use.

- Authentication required (identity context from MCP client)
- Role-based authorization
- Mutating operations require confirmation
- Structured audit logging
- Redaction of sensitive data

### Regulated (Enterprise)

Maximum governance for compliance and security-sensitive environments. Strictly
stricter than Production on every control.

- Discovery is **explicit-only** on both reads and writes
- Authentication required, with call-time authorization
- **Signed-approval evidence** required for *every* guarded operation — not only
  for operations whose effects happen to be classified
- Durable audit sink **required**
- Redaction required, plus an explicit review acknowledgement
- Invalid reload **fails readiness** rather than degrading silently
- Tighter bounds: 512 KiB request, 1 MiB response, 20s deadline

```ts
import { regulatedPreset } from '@askturret/mcp';

const preset = regulatedPreset({
  auditSink: { id: 'postgres-audit', durability: 'durable' },
  customReviewAcknowledged: true,           // you have reviewed your redaction rules
  verifyEvidence: (proof) => verify(proof), // your signature scheme
  permissions: { listPets: ['pets:read'] },
});
```

**Its refusals are boot-time.** A non-durable audit sink, a missing review
acknowledgement, or a missing evidence verifier throws `RegulatedPresetRefusal`
from expansion — so a misconfigured deployment does not start, rather than
starting and being weakened later.

Inspect the full expansion — including which controls are declared but not yet
enforced — with `describePreset('regulated', options)`. For a tighter support
bundle, `askturret-mcp diagnostics --regulated` omits schemas and config paths.

---

## Comparison

How AskTurret MCP differs from static generators and alternative approaches:

| Feature | AskTurret | OpenAPI Generators | MCP SDK | REST API Direct |
|---------|-----------|-------------------|---------|-----------------|
| **Runtime server** | ✅ | ❌ (static code) | ✅ (custom) | ✅ (existing) |
| **Multiple sources** | ✅ | Single source | ✅ (custom) | N/A |
| **Zero regeneration** | ✅ | ❌ | ✅ | ✅ |
| **Call-time policies** | ✅ | ❌ | ❌ | ❌ |
| **Audit trail** | ✅ | ❌ | ❌ | ❌ |
| **Production-ready presets** | ✅ | ❌ | Requires custom | ❌ |
| **Explorer UI** | ✅ | ❌ | ❌ | ❌ |
| **Readiness scoring** | ✅ | ❌ | ❌ | ❌ |

**Why not just generate code?**

Code generators produce static artifacts. Every time your OpenAPI spec changes, you must regenerate and redeploy. Policy changes and overlays disappear. Authorization happens at discovery time, not call time.

AskTurret MCP is a runtime. Policies, overlays, and operations are loaded dynamically. Change your OpenAPI spec, regenerate your registry snapshot (not code), reload — no downtime. Authorization reevaluates at call time with actual request context. Overlays layer non-invasively on top of discovered operations, preserving them across regenerations.

Learn more: [Why not just generate code?](docs/why-not-generate.md)

---

## Examples

### Express + OpenAPI

```ts
import express from 'express';
import { mcpFromOpenApi } from '@askturret/mcp/express';

const app = express();

// Serve the API on its normal routes
app.get('/pets', (req, res) => { /* ... */ });

// Add MCP alongside your API
app.use('/mcp', mcpFromOpenApi('./petstore.yaml'));

app.listen(7000, () => console.log('MCP server at http://localhost:7000/mcp'));
```

### Fastify + OpenAPI

Fastify is a first-class adapter, not a port. It takes **the same options object**
as Express — swap the import and change nothing else.

```ts
import Fastify from 'fastify';
import { mcpFromOpenApi } from '@askturret/mcp/fastify';

const app = Fastify();

// Serve the API on its normal routes
app.get('/pets', async () => { /* ... */ });

// Add MCP alongside your API. Registered as a proper encapsulated plugin:
// it does not change body parsing, hooks or decorators for your other routes.
await app.register(mcpFromOpenApi('./petstore.yaml'), { prefix: '/mcp' });

await app.listen({ port: 7000 });
```

Composable form, identical in shape to the Express one:

```ts
import { fastifyMcp } from '@askturret/mcp/fastify';
import { fromOpenApi } from '@askturret/mcp/openapi';
import { viaHttp } from '@askturret/mcp';

await app.register(
  fastifyMcp({
    sources: [fromOpenApi('./openapi.yaml')],
    transport: {
      executors: new Map([['http', viaHttp({ baseUrl: 'http://localhost:8080' })]]),
    },
  }),
  { prefix: '/mcp' },
);
```

Both facades share one options type, so a config object that type-checks against
one type-checks against the other — that is enforced by the compiler, not by
documentation.

One convenience Fastify gains: `basePath` defaults to the registration `prefix`,
because a Fastify plugin can read its own mount path and an Express router
cannot. `{ prefix: '/tools' }` just works, where Express needs a matching
`basePath: '/tools'`. An explicit `basePath` still wins on both.

### Production Policies

```ts
import { createMcpServer, fromOpenApi, authenticated, authorizationPolicy } from '@askturret/mcp';
import { openTelemetry } from '@askturret/mcp/otel';

const server = createMcpServer({
  preset: 'production',
  sources: [fromOpenApi('./api.yaml')],
  
  policy: allOf([
    authenticated(),  // Require identity
    authorizationPolicy({  // Role-based access
      'admin': ['*'],
      'user': ['listPets', 'createPet'],  // Limited set of operations
    }),
  ]),
  
  observability: openTelemetry({
    tracerProvider: myTracerProvider,
  }),
});

app.use('/mcp', server.httpHandler());
```

### Multiple Sources

```ts
const server = createMcpServer({
  sources: [
    fromOpenApi('./public-api.yaml'),
    fromDefinitions([
      {
        id: 'send-email',
        name: 'sendEmail',
        description: 'Send an email via our internal service',
        input: z.object({
          to: z.string().email(),
          subject: z.string(),
          body: z.string(),
        }),
      },
    ]),
  ],
});
```

[More examples →](examples/)

---

## Documentation

- **[Architecture Overview](docs/architecture-overview.md)** — How AskTurret MCP works internally.
- **[Compatibility Matrix](docs/compatibility.md)** — Supported Node, TypeScript, adapter, OpenAPI and MCP versions. A versioned contract.
- **[Compatibility & Deprecation Policy](docs/compatibility-policy.md)** — Which surfaces are under semver, what a MAJOR means, and the deprecation process. What the 1.0 label will actually promise.
- **[Changelog](CHANGELOG.md)** — Every entry classified against the policy above.
- **[Generated-Output Licensing](docs/generated-output-license.md)** — Who owns the output AskTurret produces. A versioned contract.
- **[Telemetry Policy](docs/telemetry-policy.md)** — Zero telemetry by default; any future collection is opt-in only. A versioned contract.
- **[Roadmap](docs/roadmap.md)** — What's planned for future releases.
- **[Why not just generate code?](docs/why-not-generate.md)** — Comparison with code-gen approaches.

---

## Community & Support

- **[Discussions](https://github.com/askturret/mcp/discussions)** — Ask questions, share ideas.
- **[Report a bug](https://github.com/askturret/mcp/issues)** — Found an issue? Let us know.
- **[Contributing](CONTRIBUTING.md)** — How to contribute to AskTurret MCP.
- **[Security policy](SECURITY.md)** — Reporting security vulnerabilities.
- **[Code of Conduct](CODE_OF_CONDUCT.md)** — Community guidelines.

---

## License

AskTurret MCP is licensed under the [Apache License 2.0](LICENSE). See [TRADEMARK.md](TRADEMARK.md) for trademark and branding guidelines.

**Output you generate with AskTurret belongs to you** — see [Generated-Output Licensing](docs/generated-output-license.md) for the full statement.

---

## Privacy

**No telemetry. Nothing is collected.** AskTurret MCP makes no outbound network call unless you configure one yourself, and there is no AskTurret endpoint to call. If usage telemetry is ever added it will be **opt-in only** and disabled by default — and it will never collect your tool arguments, responses, principal identifiers or API schemas.

See the [Telemetry Policy](docs/telemetry-policy.md) for the full versioned contract.

---

## Acknowledgments

AskTurret MCP is built on the [Model Context Protocol](https://modelcontextprotocol.io/) and benefits from the OpenAPI, TypeScript, and agent ecosystems.

---

*Built by [AskTurret](https://askturret.com/) · Join us on [Discord](https://discord.gg/askturret) · [Read the blog](https://blog.askturret.com/)*
