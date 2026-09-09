# @askturret/mcp-observability

Binds AskTurret's telemetry ports to OpenTelemetry, so every MCP call produces
spans and metrics in whatever backend you already run.

The runtime defines *what* is worth recording; this package decides *where* it
goes. Nothing in `@askturret/mcp-core` depends on the OpenTelemetry SDK, which
is why adding observability changes what you can see without changing what
executes.

## Turning it on

```bash
npm install @askturret/mcp-observability
```

```js
import { openTelemetry } from '@askturret/mcp-observability';

const server = createMcpServer({
  sources: [...],
  observability: openTelemetry({ tracerProvider: myTracerProvider }),
});
```

Called with **no configuration, `openTelemetry()` returns an inert
`Observability`** rather than throwing. That is deliberate: no exporter is the
documented default, and a default that throws is not a default. You can wire the
call site first and supply a provider later.

## Also exported

- **`otelExporterPlugin`** — the exporter as a runtime plugin, when you would
  rather configure telemetry through the plugin system than at construction.
- **`createSpanBuffer`** and **`recordingTracer`** — an in-memory tracer and a
  bounded buffer. Useful in tests and for the Explorer's diagnostic panels,
  where you want to assert on the span tree without standing up a collector.

## Requirements

Node 20+. Bring your own `TracerProvider` and `MeterProvider` — this package
does not configure the OpenTelemetry SDK, choose an exporter, or start a
collector for you. That stays your deployment's decision.

## What it does not do

It does not define the span tree or the metric set: those are the telemetry
*ports* in `@askturret/mcp-core`, and this package implements them. If a span
you expect is missing, the question is usually whether the runtime emits it, not
whether this package exported it.

It is also not an audit log. Policy decisions and redaction are core's, and they
happen whether or not any exporter is attached.

---

Full documentation is in the [main README](https://github.com/askturret/mcp#readme).
