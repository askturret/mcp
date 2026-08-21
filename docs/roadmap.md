# AskTurret MCP — Public Roadmap

AskTurret MCP develops through a series of delivery slices, each focused on a specific market phase and customer outcome. This roadmap shows what we're building, when, and what to expect from each phase.

**Current status: Shipping v0.1 Viral Core**

## v0.1 — Viral Core

**Goal:** First success in under five minutes. Developers can add an MCP layer to an existing API with one line of code.

- Minimal Light facade (`mcpFromOpenApi()` for Express)
- OpenAPI 3.0/3.1 import
- Direct handler execution
- Basic `tools/list` and `tools/call` over MCP
- Explorer UI for local development
- `mcp doctor` CLI for readiness scoring
- Streamable HTTP transport

**Timeline:** Public release Q3 2026

---

## v0.2 — Trust

**Goal:** Production governance. Teams can safely delegate agent access to real APIs with policies, confirmation, redaction, and audit.

- Production policy preset (authentication, authorization, effects-based confirmation)
- Call-time policy reevaluation
- Typed effects and confirmation challenges
- Audit sink with structured logging
- OpenTelemetry integration (traces, metrics)
- Redaction pipeline for sensitive data
- Safe error mapping and bounded execution

**Timeline:** Q4 2026

---

## v0.3 — Resilience

**Goal:** Reliable at scale. Degraded operation, bulkheads, circuit breakers, and conformance testing.

- Bulkhead management and circuit breakers
- Timeout propagation and deadline tracking
- Graceful degradation and readiness probes
- Atomically reloadable registry (zero-downtime updates)
- Conformance test suite for adapters and overlays
- Health check endpoints

**Timeline:** Q1 2027

---

## v0.4 — Ecosystem

**Goal:** Multiple sources and executors. Teams can compose OpenAPI, framework routes, custom handlers, and HTTP proxies in one server.

- Additional framework adapters (Fastify, Koa, Hono)
- HTTP proxy executor for legacy/remote APIs
- Explicit TypeScript/Zod operation definitions
- Overlay system for non-invasive customization
- Plugin API for custom sources and executors
- Multi-source conflict resolution
- Discovery adapters for additional schema formats

**Timeline:** Q2 2027

---

## v1.0 — Stable Contract

**Goal:** Production ready. API, schema, and behavior guarantees for teams building on top.

- Semantic versioning guarantees for all public APIs
- Registry snapshot versioning and diffs
- Stable plugin API and adapter interfaces
- Comprehensive security and compliance documentation
- SLA and support commitments
- Production reference implementations

**Timeline:** H2 2027

---

## How to Contribute

We welcome contributions at every stage. See [CONTRIBUTING](../CONTRIBUTING.md) for:

- **`good first issue`** — Small, well-scoped tasks perfect for new contributors (documentation, examples, small features)
- **`help wanted`** — Larger work that needs community or specialist input (framework adapters, executor strategies, corpus contributions)
- **Design discussions** — Propose features or architectural changes in GitHub Discussions or Slack

The roadmap is public and evolves based on community feedback. File an issue or join our community if you'd like to influence priorities.
