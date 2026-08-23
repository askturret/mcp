# Explorer panels

§13, ADR-020. The primary **operator diagnostic surface** — it sits alongside
the `diagnostics` bundle, which is the offline-sharing counterpart.

**Dev-only, unchanged.** The Explorer is off when `NODE_ENV=production`;
enabling it there is an explicit opt-in that logs a startup warning. #56 added
panels, not access — that gate is exactly where Epic #1 #19 left it.

## The six panels

| # | Panel | Data source | State when unavailable |
|---|---|---|---|
| 1 | Provenance explainer | `OperationDefinition.provenance` (#55) | `available: false` |
| 2 | Policy explanation | `PolicyEvidence` (#33) | absent unless a decision is supplied |
| 3 | Principal-aware surface | `policyEngine.visibleOperations()` | absent unless operations supplied |
| 4 | Traces | span buffer (**new**, opt-in) | `available: false` + reason |
| 5 | Breaker / bulkhead | `breakerStats()` / bulkhead `stats()` | `breakersConfigured: false` |
| 6 | Version diff | `diffSnapshots` + `controller.retained()` | `available: false` + reason |

Every panel distinguishes **"not configured"** from **"nothing to show"**. An
empty trace list and a trace buffer that was never wired look identical
otherwise, and the second sends an operator hunting for requests that were
never recorded.

## No panel bypasses redaction

Every builder returns through `redactExplorerModel`, and `buildExplorerPanels`
applies it **again** over the assembled set. The second pass is not redundant —
it is what catches a seventh panel added by someone who did not read the file
header. Redaction is idempotent, so the double pass costs nothing.

### What that does and does not buy you

The pipeline's built-ins are `keyNameRule`, `pemRule`, `bearerRule`, `jwtRule`
and `creditCardRule` — a key *named* like a secret, plus four value *shapes*.

**High-entropy detection is opt-in** (§9.4, #49). So a vendor key like
`sk_live_…` sitting under an innocuous field name — a provenance `location`, a
diff `detail` — **passes through every panel**. There is a test asserting
exactly that, so the limitation is discovered here rather than in a screenshot.

§56's text says redaction "already ensures no sensitive data reaches this
panel". That is true of the routing and overstates the coverage. Add a rule if
your data needs value-shape matching.

## Panel 4's source did not exist

#56 names the trace source as "an in-process ring buffer populated by the OTel
exporter (Epic #2 #39)". No such buffer existed — #39 forwards spans to an
adopter's SDK and retains nothing, deliberately, because a forwarder that also
buffered would hold request data nobody asked it to hold.

So `createSpanBuffer` / `recordingTracer` are new, and **opt-in**:

```ts
import { createSpanBuffer, recordingTracer, openTelemetry } from '@askturret/mcp-observability';

const buffer = createSpanBuffer();
const base = openTelemetry({ tracer, meter });
const observability = { ...base, tracer: recordingTracer(base.tracer, buffer) };
```

`openTelemetry()` is unchanged and still retains nothing. Attributes are
redacted **on the way in**, so the buffer never holds a raw secret — better
than redacting on the way out, which leaves a heap-dump risk and one more thing
to remember at every future read site. It is bounded (50 spans by default),
because an unbounded debugging tail is a leak that only shows up on the servers
that stay up longest.

## Panel 5 polls; it does not use SSE

§56 asks for the choice to be documented, and the model carries
`refreshStrategy: 'polling'` so the page and these docs cannot disagree.

SSE would hold an open connection per open tab, for as long as the tab exists,
on a server whose bulkheads this panel exists to watch — a diagnostic that
consumes the resource it measures. Polling costs one request per interval, stops
when the tab closes, and leaves no server-side state to leak on disconnect.

## Panel 6 matches the CLI exactly

It is fed the **same `DiffReport`** `diffSnapshots` produces for the `diff` CLI,
and only reshapes it for rendering. Calling the same classifier is the only way
to make "matches the CLI" true rather than approximately true.

Its snapshot list comes from `controller.retained()`, which is bounded by
`retainCount` — so the two-panel selector offers exactly what rollback could
actually restore.
