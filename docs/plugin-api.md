# Plugin API

§6 "Plugin author API", ADR-018.

A plugin receives **scoped, typed setters** — never a handle on anything mutable
the runtime owns. That is the whole design.

Epics 1–3 built a fixed execution envelope, an immutable registry snapshot, a
redaction pipeline whose built-ins win ties, and an audit path that cannot be
skipped. Every one of those invariants holds because the runtime keeps the only
reference to the thing that could break it. Hand a plugin the dispatcher and all
of it becomes advisory.

## Writing one

```ts
import { PLUGIN_API_VERSION, type AskTurretPlugin } from '@askturret/mcp-core';

export const acmeMetrics: AskTurretPlugin<'observability'> = {
  manifest: {
    name: 'acme-metrics',
    version: '2.1.0',            // YOUR version
    apiVersion: PLUGIN_API_VERSION, // the ASKTURRET plugin API you built against
    capabilities: ['observability'],
  },

  async setup(context) {
    context.registerObservabilityExporter({ id: 'acme', observability });
  },
};
```

Load them:

```ts
import { loadPlugins } from '@askturret/mcp-core';

const registrations = await loadPlugins([acmeMetrics]);
```

`loadPlugins` returns the registrations as **data** for you to wire — sources
into the compiler, executors into the dispatcher, rules into the redaction
pipeline. It does not reach into a running server, because `createMcpServer` is
still a v0.1 stub (#131); returning data keeps that honest rather than implying
a wiring that does not exist.

Two **runnable examples** exist, one per common seam:

| Example | Seam | Where the plugin lives |
|---|---|---|
| [`examples/plugin-otel-exporter/`](../examples/plugin-otel-exporter/) | exporter | `otelExporterPlugin` in `@askturret/mcp-observability` — the example only *loads* it |
| [`examples/plugin-source/`](../examples/plugin-source/) | source | the example itself, because a source plugin is adopter code and there is no shipped one to load |

Start with the source example if you are contributing operations. It walks the
whole lifecycle — declare, implement, register, use, and watch the capability
gate refuse an undeclared call — and it feeds what the plugin registered into
the real compiler, so what you read is what actually works.

Both are EXECUTED by CI rather than merely built, so neither can rot into a
reference that no longer runs.

### Run it

Each example needs the packages it imports built first — and they import
different things, so the build commands differ. Run these from the repository
root:

```bash
# examples/plugin-source — imports @askturret/mcp-core
npm run build -w packages/core
node examples/plugin-source/index.mjs
```

```bash
# examples/plugin-otel-exporter — also imports @askturret/mcp-observability
npm run build -w packages/core -w packages/observability
node examples/plugin-otel-exporter/index.mjs
```

The order in that second command matters: `observability` is built *from* core,
and `npm run build -w packages/observability` on its own fails.

Either example can also be run through its own `start` script, which is
equivalent once the build above has been done:

```bash
cd examples/plugin-source && npm start
```

> **If the example fails with `ERR_MODULE_NOT_FOUND` after a build that
> reported success**, the build emitted nothing because `tsconfig.tsbuildinfo`
> says the package is already up to date while its `dist/` is missing. This is a
> known trap rather than a broken step —
> [CONTRIBUTING.md](../CONTRIBUTING.md#on-typecheck-and-build-being-the-same-command)
> names the symptom and gives the escape hatch, `npx tsc -b --force`.

## Capabilities

| Capability | Authorises |
|---|---|
| `source` | `registerSource` |
| `executor` | `registerExecutor` |
| `policy` | `registerPolicy` |
| `compiler-pass` | `registerCompilerPass` |
| `observability` | `registerObservabilityExporter` |
| `redaction-rule` | `addRedactionRule` |

A manifest is a **code-review artifact**: one line tells a reviewer the blast
radius. `redaction-rule` and `policy` together is worth a closer look;
`observability` alone is not.

Calling a method you did not declare is refused **at setup**, by name:

```
Plugin 'rogue' called registerExecutor() without declaring the 'executor'
capability. Declared: [observability]. …
```

Typing `setup` with your capability list (`AskTurretPlugin<'observability'>`)
makes it a **compile** error too. Both checks exist and neither subsumes the
other — types vanish at runtime, plugins arrive as compiled JavaScript, and a
manifest can be edited without recompiling.

## API versioning

`apiVersion` is **ours**, not yours, and it is deliberately not the
`@askturret/mcp` package version. The package version moves whenever anything
changes; a plugin author cares about one question only — will the methods I call
still exist?

So `PLUGIN_API_VERSION` bumps **only** when a `PluginContext` method changes
signature or a capability is removed.

A plugin loads when its **MAJOR matches** and its **MINOR is no higher** than the
runtime's:

| Plugin | Runtime | Loads | Why |
|---|---|---|---|
| 1.0.0 | 1.2.0 | ✅ | additive within a major — everything it calls exists |
| 1.2.0 | 1.0.0 | ❌ | may call a method 1.0 lacks |
| 1.0.9 | 1.0.0 | ✅ | PATCH is ignored |
| 2.0.0 | 1.0.0 | ❌ | major mismatch |

The asymmetry runs the opposite way to intuition, and it is the point. Without
it a newer plugin fails as `undefined is not a function` deep inside `setup`,
**after partially registering**. Refusing at load turns that into one sentence.

Version mismatch is refused at **load**, before `setup` runs — a plugin speaking
an API we do not must not execute a line.

## What plugins cannot do

Enforced by **absence**. There is no method for any of it:

- **Bypass the execution envelope** or reorder its stages (§5.6, ADR-010).
- **Mutate a registry snapshot.**
- **Reach dispatcher internals.**
- **Remove or replace a built-in redaction rule.**
- **Access another plugin's state** — each plugin gets its own context object,
  and the shared accumulator is captured in a closure, not exposed.

### Redaction: extend, never replace

Two things make this hold, and **ordering alone is not one of them**:

1. Plugin rules are **appended** after the built-ins, and the pipeline takes the
   first match. That is the pipeline's own guarantee.
2. Plugin rules are constrained to **leaf values**.

The second exists because the first is insufficient, which the #53 test suite
found. `walk()` evaluates rules at every node **including the root**, and a match
returns `transform(value)` *without descending*. So this rule:

```ts
{ id: 'passthrough', matches: () => true, transform: (v) => v }
```

matches the root object, returns it untouched, and every secret inside survives —
without removing a single built-in. It neutralises them instead, which is the
same outcome for an adopter.

Constraining plugin rules to leaves means containers fall through to the walk,
the built-ins get their turn on every leaf, and a plugin rule still applies to
each leaf individually. Coverage is unchanged; only the shape of a whole-subtree
replacement is lost.

This constraint applies at the **plugin** boundary only. A rule you add yourself
via `pipeline.add` is unconstrained — you are trusted with your own process; a
plugin is third-party code you installed.

## Not a sandbox

A plugin runs in the same process, on the same event loop, with the same
filesystem and network access as the host. Nothing here changes that: a
malicious plugin can still `require('fs')`. §53 puts sandboxing explicitly out of
scope.

What this API contains is **accident** — a plugin cannot break an invariant it
did not mean to touch, and its manifest states in one line what it can affect.
An adopter who believed this contained hostile code would make a worse decision
than one who knows it does not.
