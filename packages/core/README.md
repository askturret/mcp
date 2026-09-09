# @askturret/mcp-core

The runtime every other AskTurret package is built on: the canonical operation
model, the compiler that produces it, and the execution path that runs it under
policy.

If you are adding MCP to an Express or Fastify app, you probably want
[`@askturret/mcp-adapters-express`](https://www.npmjs.com/package/@askturret/mcp-adapters-express)
or [`@askturret/mcp-adapters-fastify`](https://www.npmjs.com/package/@askturret/mcp-adapters-fastify)
instead — they depend on this package and give you a mountable handler in one
call. Reach for `mcp-core` directly when you are composing the pieces yourself,
writing a plugin, or building an adapter of your own.

## What it is for

One model, compiled once, executed under policy:

- **Canonical model and compiler** — sources produce `OperationDefinition`s; the
  compiler validates them, applies overlays and presets, and yields a registry.
  Tool shape is derived from operations you already have rather than written a
  second time.
- **Dispatcher and executors** — `createDispatcher` routes an MCP call;
  `viaHandler` runs an in-process function and `viaHttp` proxies to an upstream
  HTTP API, both behind one `OperationExecutor` interface.
- **Policy** — `allOf`, `authenticated`, `confirmationForEffects` and their
  siblings, evaluated at call time rather than baked into tool definitions.
- **Resilience** — bulkheads, retry and circuit breakers, with a shutdown
  lifecycle that drains in a defined order rather than dropping work.
- **Extension points** — plugins, overlays that carry provenance, and telemetry
  *ports* an observability package binds to.

## Installing

```bash
npm install @askturret/mcp-core
```

Node 20+. TypeScript types ship with the package; there is no `@types` install.

## What it does not do

This package is deliberately transport-, framework- and vendor-neutral. It opens
no socket and has no opinion about your HTTP stack:

| You want | Package |
|---|---|
| Serve MCP over Streamable HTTP | `@askturret/mcp-transports` |
| Mount into Express or Fastify | `@askturret/mcp-adapters-express` / `-fastify` |
| Import an OpenAPI spec | `@askturret/mcp-sources-openapi` |
| Export traces and metrics | `@askturret/mcp-observability` |

It defines the telemetry *ports*; it does not depend on the OpenTelemetry SDK.
That separation is why adding observability changes what you can see without
changing what the runtime executes.

---

The quick start, the compatibility matrix and the full documentation live in the
[main README](https://github.com/askturret/mcp#readme).
