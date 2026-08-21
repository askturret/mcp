# Architecture Overview

AskTurret MCP exposes operations from your existing API to agents through the Model Context Protocol. This page explains the architecture in one concise page. For deeper technical detail, see the [full architecture document](../ARCHITECTURE.md).

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
  id: string;                      // Unique operation ID
  name: string;                    // Agent-facing tool name
  description: string;             // What it does
  input: JSONSchema;               // What it accepts (simplified)
  output: JSONSchema;              // What it returns
  effects: Effect[];               // Side-effects (read, write, delete, etc.)
  executors: Executor[];           // How to run it (direct, HTTP, etc.)
  policies: Policy[];              // Who can call it and when
}
```

**Why:** Multiple sources can coexist in one server without duplicate logic or special cases. You can migrate from HTTP proxy execution to direct handlers without changing tool signatures.

### 2. Immutable Registry Snapshots

Compilation produces a frozen, versioned snapshot of all operations:

```typescript
interface RegistrySnapshot {
  version: number;           // Incremented on every compilation
  hash: string;              // Content hash (for diffs and caching)
  createdAt: Date;          // When it was built
  operations: Map<OperationId, OperationDefinition>;
}
```

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
  value: T;
  source: {
    kind: 'openapi' | 'overlay' | 'inference' | 'preset';
    location?: string;
  };
}
```

**Precedence order:**
1. Explicit code enhancement
2. MCP overlay YAML
3. Source-native metadata (x-mcp in OpenAPI)
4. Source definition
5. Conservative inference
6. Preset default

**Why:** When a field has multiple values, conflicts are deterministic and inspectable. Explorer can explain why each field took its final value.

### 5. Multiple Executor Strategies

Operations can be executed via:

- **Direct handler:** In-process function call (preferred, lowest latency)
- **HTTP proxy:** Call an existing remote API (compatibility path)
- **Custom:** Pluggable executors for queues, webhooks, etc.

**Why:** Same operation can use different execution strategies at different times. Migrate HTTP proxy tools to direct handlers without changing the tool definition.

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
  | { effect: 'allow'; evidence: PolicyEvidence[] }
  | { effect: 'deny'; reason: string; evidence: PolicyEvidence[] }
  | { effect: 'confirmation_required'; challenge: ConfirmationChallenge; evidence: PolicyEvidence[] };
```

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
interface OperationSource {
  id: string;
  discover(context: DiscoveryContext): Promise<DiscoveredOperation[]>;
}
```

### Custom Executors

Implement the `OperationExecutor` interface to execute operations via any mechanism:

```typescript
interface OperationExecutor {
  type: string;
  execute(command: OperationCommand, operation: OperationDefinition): Promise<OperationResult>;
}
```

### Custom Policies

Implement the `Policy` interface to add authorization rules:

```typescript
interface Policy {
  id: string;
  evaluate(context: PolicyContext): Promise<PolicyDecision>;
}
```

### Compiler Passes

Hook into the compilation pipeline to transform operations:

```typescript
interface CompilerPass {
  name: string;
  run(operations: CompiledOperation[], context: CompilerContext): Promise<CompiledOperation[]>;
}
```

---

## Next Steps

- **[Quick Start](quick-start.md)** — Get a server running in 5 minutes.
- **[Full Architecture](../ARCHITECTURE.md)** — Deep technical detail (C4 diagrams, code examples).
- **[API Reference](api.md)** — Detailed API documentation.
- **[Policy Configuration](policies.md)** — Write policies for your use case.

---

## See Also

- **[Why not just generate code?](why-not-generate.md)** — How AskTurret differs from static generators.
- **[Comparison table](../README.md#comparison)** — Feature comparison with alternatives.
- **[Examples](../examples)** — Working examples for common scenarios.
