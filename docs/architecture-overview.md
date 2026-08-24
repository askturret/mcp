# Architecture Overview

AskTurret MCP exposes operations from your existing API to agents through the Model Context Protocol. This page explains the architecture in one concise page. For the deployment topology and the reasoning behind it, see the [production reference architecture](reference-architecture.md).

## Product Model

```
Discover → Shape → Govern → Serve → Observe
```

**Discover:** Import operations from OpenAPI specs, framework routes, schemas, or explicit definitions.

**Shape:** Normalize operations into agent-friendly tools. Simplify schemas, infer effects, apply overlays.

**Govern:** Enforce policies. Authenticate agents, authorize access, require confirmation for risky operations, audit every call.

**Serve:** Expose operations over MCP (HTTP or stdio). Use direct in-process handlers or HTTP proxy to existing APIs.

**Observe:** Export traces, metrics, logs, and audit events to OpenTelemetry backends.

---

## Core Components

```
┌─────────────────────────────────────────────────────┐
│  AskTurret MCP Server                               │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Discovery Layer                                    │
│  ├─ OpenAPI 3.0/3.1 importer                        │
│  ├─ Framework route scanner (Express, Fastify)      │
│  ├─ Explicit TypeScript definitions                 │
│  └─ JSON Schema validator                           │
│                                                     │
│  Compilation Layer                                  │
│  ├─ Normalizer (canonical OperationDefinition)      │
│  ├─ Overlay engine (non-invasive customization)     │
│  ├─ Agent-friendly naming and description generator │
│  └─ Contract snapshot (immutable, versioned)        │
│                                                     │
│  Runtime Layer                                      │
│  ├─ Policy engine (auth, authz, confirmation)       │
│  ├─ Command dispatcher (safe execution envelope)    │
│  ├─ Executor strategies (direct, HTTP proxy)        │
│  └─ Bulkheads & circuit breakers                    │
│                                                     │
│  Observability Layer                                │
│  ├─ OpenTelemetry traces & metrics                  │
│  ├─ Structured audit logging                        │
│  ├─ Redaction pipeline                              │
│  └─ Diagnostics & health checks                     │
│                                                     │
│  Tools                                              │
│  ├─ MCP transport (HTTP or stdio)                   │
│  ├─ Explorer UI (local development & debugging)     │
│  ├─ CLI (doctor, inspect, diff, mock)               │
│  └─ Conformance test suite                          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. Canonical Operation Model

Every source (OpenAPI, routes, schemas, handlers) is normalized into an immutable `OperationDefinition`:

```typescript
interface OperationDefinition {
  readonly id: OperationId;            // Unique within a registry snapshot
  readonly name: string;               // Agent-facing tool name
  readonly description: string;        // What it does
  readonly input: JSONSchema;          // What it accepts (simplified)
  readonly output: JSONSchema;         // What it returns
  readonly effects: EffectMetadata;    // Safety and retry characteristics
  readonly executor: ExecutorBinding;  // How to run it — exactly one binding
  readonly annotations?: Readonly<Record<string, unknown>>;  // Non-canonical metadata
  readonly provenance?: readonly ProvenanceEntry[];          // Where each field came from
}
```

`effects` is a single `EffectMetadata` object, not a list: it answers *is this
read-only, is it idempotent, is it safe to retry, does it need an idempotency
key, and what does it touch* — questions about one operation, each with one
answer.

**Policies are deliberately not a field here.** An operation does not carry the
rules that govern it; policies are composed by the preset and evaluated per
call against a `PolicyContext` that includes the caller and the actual input.
Binding them to the definition would make authorization a property of the tool
rather than of the call, which is the distinction §3 below exists to draw.

**Why:** Multiple sources can coexist in one server without duplicate logic or special cases. You can migrate from HTTP proxy execution to direct handlers without changing tool signatures.

### 2. Immutable Registry Snapshots

Compilation produces a frozen, versioned snapshot of all operations:

```typescript
interface RegistrySnapshot {
  readonly version: number;   // Incremented on every compilation
  readonly hash: string;      // Content hash (for diffs and caching)
  readonly createdAt: Date;   // When it was built
  readonly operations: ReadonlyMap<OperationId, OperationDefinition>;
}
```

`ReadonlyMap`, not `Map` — a snapshot handed to a request handler cannot be
added to or cleared. The immutability this section is named for is enforced by
the type, not just intended.

**Why:** In-flight requests see coherent state. No tearing, no race conditions. Snapshots enable safe hot-reload, rollback, and audit trails. Explorer and diff tools can compare snapshots.

### 3. Call-Time Authorization

Policies evaluate twice:

1. **Discovery-time:** Filters `tools/list` response based on what the agent can see.
2. **Call-time:** Reevaluates with actual request context (identity, input, time).

**Why:** Authorization rules may depend on the agent's identity and the specific input. Just because a tool appears in `tools/list` doesn't mean the agent can call it with every input.

### 4. Provenance-Aware Overlays

Every material field retains its source:

```typescript
interface SourcedValue<T> {
  readonly value: T;
  readonly source: ProvenanceSource;   // { kind: ProvenanceKind; location?: string }
}
```

`ProvenanceKind` is named rather than spelled out here on purpose: an inline
copy of a union is a second definition that drifts silently the moment a member
is added, which is exactly how this block came to be missing three of them.
`PROVENANCE_PRECEDENCE` in `packages/core/src/overlay/types.ts` is the single
source of both the members and their order.

**Precedence order:**
1. Explicit code enhancement (`code`)
2. MCP overlay YAML (`overlay`)
3. Source-native metadata (`x-mcp`)
4. Source definition — `openapi` and `framework`, which **rank equally**
5. Conservative inference (`inference`)
6. Preset default (`preset`)

Six levels, seven kinds: `openapi` and `framework` are two flavours of "the
source definition itself" and tie deliberately, so two overlays touching the
same field is a defined situation rather than a race.

**Why:** When a field has multiple values, conflicts are deterministic and inspectable. Explorer can explain why each field took its final value.

### 5. Interchangeable Executor Strategies

An operation can be executed via:

- **Direct handler:** In-process function call (preferred, lowest latency)
- **HTTP proxy:** Call an existing remote API (compatibility path)
- **Custom:** Pluggable executors for queues, webhooks, etc.

**One binding at a time.** `OperationDefinition.executor` is a single
`ExecutorBinding`, not a list. An operation is not dispatched to several
executors, and there is no fan-out or fallback between them — the binding is
chosen when the registry is compiled, and changing it is a recompilation that
produces a new snapshot.

**Why:** ADR-014 requires that `viaHandler` and `viaHttp` produce *identical*
golden output for the same operation definition. Because the strategies are
interchangeable in that strict sense, an operation can move from HTTP proxy to
a direct handler between one snapshot and the next without its tool signature
changing — the migration story, and the reason the binding is deliberately
opaque to the canonical model.

---

## Deployment Topology

### In-Process (Recommended)

```
Your Application (Node.js)
├─ Existing API routes (/api/...)
├─ AskTurret MCP server
│  ├─ /mcp/tools/list
│  ├─ /mcp/tools/call
│  ├─ /mcp/explorer        (local dev UI)
│  └─ /mcp/health          (readiness probes)
└─ Database, cache, etc.
```

**Advantages:**
- No network hop between MCP and handlers.
- Authentication context shared safely.
- Single release/deployment cycle.
- Local-first, audit-friendly.

### Standalone Proxy (Legacy APIs)

```
MCP Client → MCP Server (standalone) → Existing API
```

**Advantages:** Integrating with APIs you don't control. Disadvantages: Separate deployment, credentials, version mismatch risk.

---

## Quality Attributes

AskTurret prioritizes these in order:

| Priority | Attribute | How | Example |
|----------|-----------|-----|---------|
| 1 | **Safety** | Policies at call time, typed effects, confirmation, redaction | Mutating operations require approval |
| 2 | **Adoption** | One-line quick start, useful defaults | Light facade, doctor CLI, explorer |
| 3 | **Correctness** | Canonical model, schema validation, snapshot contracts | Same operation definition across sources |
| 4 | **Availability** | Bulkheads, circuit breakers, graceful degradation | Timeouts, failure isolation, readiness checks |
| 5 | **Maintainability** | Clear boundaries, thin adapters, stable plugin API | Hex architecture, conformance suite |
| 6 | **Observability** | OpenTelemetry, structured errors, separate audit channel | Traces, metrics, logs, audit events |
| 7 | **Performance** | Immutable lookup, bounded queues, no internal HTTP hop | O(1) tool lookup, streaming support |

---

## Policy Engine

Policies are composable rules that govern operation visibility and execution:

```typescript
type PolicyDecision =
  | { effect: 'allow'; evidence: readonly PolicyEvidence[] }
  | { effect: 'deny'; code: string; safeReason: string; evidence: readonly PolicyEvidence[] }
  | { effect: 'confirmation_required'; challenge: ConfirmationChallenge; evidence: readonly PolicyEvidence[] };
```

A denial carries **two** separate fields, and the split is deliberate: `code`
is machine-readable and for branching, `safeReason` is for humans. It is called
`safeReason` rather than `reason` as a standing reminder that it crosses a
trust boundary — whatever a policy puts there may be returned to the caller, so
it must not leak anything the caller has not already established.

**Policies compose via:**
- `allOf()` — All policies must allow
- `anyOf()` — At least one must allow
- `not()` — Invert a policy

**Three presets:**

1. **Light** — Minimal policies. Development and prototyping.
2. **Production** — Authentication, authorization, confirmation for risky effects.
3. **Regulated** — Maximum governance. Mutual TLS, mandatory audit, immutable logs.

---

## Observability

### OpenTelemetry Integration

Every operation execution generates:

- **Trace spans:** Captures the execution timeline, latency, and errors.
- **Metrics:** Counter (calls), histogram (latency), updown gauge (active requests).
- **Logs:** Structured logs with operation, identity, input (redacted), output (redacted).

### Audit Trail

Separate, immutable audit events log:

- Who called what operation
- When and why (policy evidence)
- What input was provided (redacted)
- What output was returned (redacted)
- How long it took
- If it failed, why
- Registry version active during the call

---

## Extension Points

### Custom Sources

Implement the `OperationSource` interface to discover operations from any system:

```typescript
interface OperationSource<TExtensions = Record<string, never>> {
  readonly id: string;
  discover(context: DiscoveryContext<TExtensions>): Promise<DiscoveredOperation[]>;
}
```

`TExtensions` defaults to empty, so a source that needs nothing extra from the
discovery context implements the interface without naming it. It is the seam
for a source that *does* — the typed channel by which a source declares what it
expects the context to carry.

### Custom Executors

Implement the `OperationExecutor` interface to execute operations via any mechanism:

```typescript
interface OperationExecutor {
  execute(
    operation: OperationDefinition,
    input: unknown,          // already validated against operation.input
    context: DispatchContext, // principal, deadline, AbortSignal
  ): Promise<OperationResult>;
}
```

The interface has **one** member. There is no `type` field on the executor
itself — the strategy identifier lives on the operation's `ExecutorBinding`, so
an executor is a behaviour and the binding is the reference to it.

An executor must respect the deadline and `AbortSignal` independently of the
client's own timeout, and must map exceptions to a typed `OperationError` at
the boundary rather than letting an internal stack or type name escape.

### Custom Policies

Implement the `Policy` interface to add authorization rules:

```typescript
interface Policy {
  readonly id: string;
  evaluate(context: PolicyContext): Promise<PolicyDecision>;
}
```

`id` appears in the evidence attached to every decision, so it should identify
the rule to an operator reading an audit entry. Combinators derive their own
ids from their children.

### Compiler Passes

Hook into the compilation pipeline to transform operations:

```typescript
interface CompilerPass {
  readonly name: string;
  run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]>;
}
```

Both arrays are `readonly`: a pass receives operations it may not mutate and
returns a new array. Transformation is by replacement, which is what lets the
pipeline be reasoned about one pass at a time.

---

## Multi-instance consistency

Every instance compiles the same configuration into a registry snapshot and
stamps it with a hash. Two instances serving **different** hashes serve
different tool surfaces — so `tools/list` answers differ by which pod the load
balancer picked, and a `tools/call` an agent was told would work is refused by
its neighbour. Nothing is down; the symptom is an agent that "sometimes" cannot
find a tool.

Two detectors ship, and both tolerate a rolling update — which legitimately runs
two hashes at once — by requiring divergence to **persist** for five minutes
before it means anything:

| | How | Cost |
|---|---|---|
| **A — external** (default) | Prometheus alerts when the number of distinct `mcp_registry_hash_id` values exceeds one for longer than the debounce | A human's attention |
| **B — internal** (opt-in) | Instances announce their hash to an operator-provided store; sustained divergence flips `/health/ready` to 503 | **Availability** — the deployment leaves rotation |

Every instance reports its hash on `/mcp/health/ready` regardless, so the
comparison can always be made by hand.

Full detail, the store contract, and the alert runbook:
[`registry-divergence.md`](registry-divergence.md).

---

## The MCP SDK boundary

§17 criterion 11: *"An MCP SDK upgrade can be completed inside the transport
boundary without changes to operation definitions."*

`@modelcontextprotocol/sdk` is reachable from exactly one place. Everything else
speaks the canonical model, and the transport translates at the edge:

```
   ┌───────────────────────────────────────────────────────────────┐
   │  sources/  compiler/  policy/  executors/  audit/  telemetry/  │
   │                                                                │
   │   speak ONLY the canonical model —                             │
   │   OperationDefinition · OperationCommand · OperationResult     │
   └───────────────────────────┬────────────────────────────────────┘
                               │  canonical types only
                               │  (no SDK type crosses this line)
   ════════════════════════════╪════════════════════════════════════
        THE BOUNDARY           │   enforced by CI, not convention
   ════════════════════════════╪════════════════════════════════════
                               │
   ┌───────────────────────────┴────────────────────────────────────┐
   │  packages/transports/src/                                      │
   │                                                                │
   │   • the ONLY package that may import the SDK                   │
   │   • translates canonical types ⇄ MCP wire shapes               │
   │   • negotiates the protocol version, and refuses one it does   │
   │     not speak — with a JSON-RPC error, never exit()            │
   └───────────────────────────┬────────────────────────────────────┘
                               │  JSON-RPC over HTTP
                               ▼
                         MCP clients
```

**Enforced, not observed.** `.github/scripts/check-sdk-boundary.mjs` runs on
every PR and fails on two things:

1. an SDK import — static, type-only, `export … from`, dynamic `import()` or
   `require()` — from anywhere outside `packages/transports/src/`;
2. an SDK type reaching any emitted `.d.ts`. That is the subtler breach: no
   package names the SDK, the source looks clean, and yet **adopters** now
   compile against the SDK's shape, so an SDK upgrade breaks *them*.

There is deliberately **no allowlist file**. An allowlist is how a boundary
becomes a suggestion — the first exception is always justified, and it is the
entry that makes the second one arguable.

### Upgrading the SDK

```bash
npm install @modelcontextprotocol/sdk@<new-version>
npm run build

node .github/scripts/check-sdk-boundary.mjs   # nothing else imports it
node .github/scripts/sdk-upgrade-drill.mjs    # nothing else breaks when it changes
npm test --workspaces
```

**If those pass, no package outside `packages/transports/` needs a diff.** That
is the whole content of criterion 11, and it is checkable rather than asserted.

Then update the SDK row in [`compatibility.md`](compatibility.md) and
[`compatibility.json`](compatibility.json) — a versioned contract, so leaving
them stale makes one of them untrue. If the new SDK changes the protocol
version, `MCP_PROTOCOL_VERSION` in `packages/core/src/protocol/versions.ts` is
the single place it is defined.

### What the drill does and does not prove

`sdk-upgrade-drill.mjs` injects a synthetic breaking change at the boundary — a
renamed export, the commonest shape of real SDK churn — rebuilds the workspace,
and reports **every** package that failed to compile. It passes only if that set
is a subset of `packages/transports`, and it restores the file afterwards even
if interrupted.

It also prints **how much SDK surface it broke**, and that number is how the
verdict should be read. Today the project touches the SDK through a single
type-only import that nothing references — the transport implements JSON-RPC by
hand — so a pass currently means *the boundary is intact and lightly loaded*,
not *isolation has been proven under a realistic upgrade*.

Stated plainly because the alternative is worse: a drill printing PASS without
that context would let a reader infer a guarantee the code does not support,
which is the failure §12.3's boundary exists to prevent.

### Protocol-version negotiation

The transport negotiates at `initialize` and records the result on the session,
so `mcp.protocol.version` on every span reports what that session actually
agreed rather than a build-time constant.

An unsupported version is **refused** with JSON-RPC `-32602`, carrying both the
requested version and the supported set. It is never `process.exit()`: this code
runs inside an adopter's own server process, and exiting would let a remote
client halt every unrelated route in their application by sending one field.

---

## Next Steps

- **[Quick Demo](../README.md#quick-demo)** — Get a server running in 5 minutes.
- **[Production Reference Architecture](reference-architecture.md)** — The verified deployment topology, and what breaks without it.
- **[Plugin API](plugin-api.md)** — The extension surface in detail: scoped setters, and what the runtime never hands out.
- **[Policies & Governance](../README.md#policies--governance)** — The three presets and what each enforces.
- **[Overlays](overlays.md)** — Customize operations without touching the source.

---

## See Also

- **[Why not just generate code?](why-not-generate.md)** — How AskTurret differs from static generators.
- **[Comparison table](../README.md#comparison)** — Feature comparison with alternatives.
- **[Examples](../examples)** — Working examples for common scenarios.
