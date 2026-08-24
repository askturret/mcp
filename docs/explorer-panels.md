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

## Where they appear in the page

Panels 1 and 2 are **per-tool** and render on the tool's own detail view;
panels 3–6 are server-wide and render under **Diagnostics** in the sidebar.

That split follows the question each answers. "Where did *this* field come
from" and "why is *this* tool denied" are properties of the selected tool;
breaker depth and the retained snapshot list are properties of the server.

**Panel 1 needs no wiring.** Provenance travels per tool on the view model —
`buildExplorerViewModel` builds it with the same `buildProvenanceView` the
panels API exposes — because the page routes between tools *in the browser*,
long after the server rendered the document. One provenance panel chosen at
render time could only ever have been correct for one tool.

## Wiring the other five

Both adapters take an `explorerPanels` supplier:

```ts
expressMcp({
  sources: [source],
  explorerPanels: () => buildExplorerPanels({
    allOperations: [...registry.current().operations.values()],
    breakers: breakerStats(),
    bulkheads: bulkheadStats(),
    spans: buffer.spans(),
    diff: report,
    retained: controller.retained(),
  }),
});
```

It is a **function**, called per request, because four of the six panels are
live state. A value captured when the server was constructed would render
startup's breaker states as though they were current — which is worse than
showing nothing, because it looks right.

It may be async. If it **throws**, the page still serves: you get the tool
browser and per-tool provenance, the diagnostic panels report that the host
supplied none, and the failure is named in the log. The Explorer is what an
operator opens *when something is already wrong*, so a failing metrics read
must not take the whole surface away — but it is degraded, never silent.

Supply nothing and the page is what it was before #56, plus provenance.

## The page renders; it never derives

Precedence labels, policy effects, breaker states and diff severities are all
computed server-side and arrive as finished models. Re-deriving any of them in
the browser would be a second implementation free to disagree with the CLI.

That has one visible consequence, and the page states it rather than hiding it.
Panel 6's two-panel selector lists every retained snapshot, but the changes on
screen are the one pair the host supplied — carried in the model as
`comparing`. Pick a different pair and the panel says so plainly, instead of
relabelling somebody else's diff. A control that looked live while showing the
wrong classification would be worse than one that admits its limit.

The same reasoning governs panel 5's refresh: with no Explorer-private
endpoint, polling means reloading the document. It runs **only** while
Diagnostics is open, and unticks, so it can never reload the page out from
under a half-filled invoke form.

## No panel bypasses redaction

Every builder returns through `redactExplorerModel`, and `buildExplorerPanels`
applies it **again** over the assembled set. The second pass is not redundant —
it is what catches a seventh panel added by someone who did not read the file
header. Redaction is idempotent, so the double pass costs nothing.

**And a third pass runs at serialization.** §9.4 names Surface 5 as "the
Explorer view model, before serialization to the client", and that moment is
`renderExplorerHtml`, which now redacts everything it embeds. Before #56 the
rendered path relied entirely on the builders — but `ExplorerPanels` is a plain
interface, so a host that assembles one by hand never visits a builder, and the
`explorerPanels` supplier is exactly that door. The pass at the boundary is what
closes it.

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
