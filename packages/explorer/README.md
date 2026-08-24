# @askturret/mcp-explorer

Local, **dev-only** Explorer UI — a Swagger-like human view of the effective MCP
tool surface, with a safe test-invoke panel.

It renders from the same `RegistrySnapshot` the transport serves, so what it
shows cannot drift from what `tools/list` returns, and it invokes tools through
the same `/mcp` endpoint any MCP client uses. There is no Explorer-private
endpoint.

## What it shows

- Every visible tool in the current snapshot, filterable.
- Per-tool detail: description, input **and output** schema as a JSON Schema
  tree with per-field docs, effect flags, and executor type.
- A test-invoke form derived from the input schema, submitted as `tools/call`.
- A response viewer showing the pretty-printed result or the typed error.
- Registry hash, version and `createdAt` in the header.

## Usage from an adapter

```ts
import { buildExplorerViewModel, renderExplorerHtml } from '@askturret/mcp-explorer';

const html = renderExplorerHtml(buildExplorerViewModel(registry.current(), basePath));
```

`buildExplorerViewModel` is pure — snapshot in, view model out — so an adapter
only has to serve the string. The Express adapter mounts it at
`${basePath}/explorer`.

### Diagnostic panels (#56)

`renderExplorerHtml` takes an optional second argument — the six diagnostic
panels from `buildExplorerPanels`:

```ts
const html = renderExplorerHtml(model, buildExplorerPanels({ /* live state */ }));
```

Omit it and the page is unchanged apart from per-tool provenance, which rides
on the view model and needs nothing from the host. Adapters expose this as the
`explorerPanels` option, called per request. See
[`docs/explorer-panels.md`](../../docs/explorer-panels.md).

Everything embedded in the page is redacted at serialization, so a hand-built
panel set cannot route around the pipeline the builders apply.

## Production

Per §10.1 invariant 9, the Explorer is **disabled by default when
`NODE_ENV=production`**, where the route returns `404`. An operator can opt in
explicitly (`enableExplorer: true`), which is not blocked but logs a startup
warning naming the setting.

Enabling it in production is risky and deliberately so: the Explorer publishes
the full tool surface and can invoke tools. **It has no authentication of its
own** — it inherits only whatever the host app puts in front of
`${basePath}/explorer`. Protecting that route is the adopter's responsibility.

Executor `config` is never sent to the browser; only the executor *type* is,
since config can hold upstream URLs and credential references.

## Delivery

A single self-contained HTML document with inline CSS and JS — no framework, no
build step, no runtime dependency. A typical page is **~5 KB gzipped**, against
the 100 KB budget in the architecture doc.

## Scope

This is the v0.1 developer inner-loop. Provenance UI, policy explanation,
trace/audit history, breaker/bulkhead state, version diff and the
principal-aware effective surface ship with their owning epics.
