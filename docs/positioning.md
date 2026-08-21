# AskTurret MCP — Positioning and Messaging Hierarchy

**Internal reference document.** This guide ensures consistent messaging across all channels. It is not adopter-facing; it is the source of truth for how we talk about AskTurret MCP in public.

## Headline and Supporting Line

**Headline:**  
> Add a production-grade MCP layer to your existing API.

**Supporting line:**  
> Discover from OpenAPI, routes, schemas, or handlers. Shape agent-friendly tools. Govern access. Observe every call.

Use these exact lines when introducing the project to new audiences. They lead with immediate benefit and specificity rather than category.

---

## Four-Item Message Order

When explaining the product to developers, follow this order:

### 1. **Immediate result** — One API becomes a working MCP server.

Lead here. A developer should see that they can add an MCP endpoint to their existing application with minimal effort (Light facade: one function call, one line of YAML).

**Example:** *"Install AskTurret, point it at your OpenAPI, and you have a working MCP server in under five minutes."*

### 2. **Differentiation** — Multiple sources, overlays, direct handlers, and HTTP proxying share one model.

This is where we separate from static generators. Explain that the same operation can come from OpenAPI, framework routes, explicit definitions, or HTTP proxies — they all run through the same execution model. No duplication, no special cases.

**Example:** *"Unlike one-shot generators, AskTurret supports multiple input sources. Switch from HTTP proxying to direct handlers without changing your agent's interface."*

### 3. **Trust** — Policies, confirmation, typed effects, audit, redaction, and bounded execution.

Introduce governance. This is where enterprises and regulated teams listen. Explain that policies are enforced at call time (not just discovery time), and that every action is auditable.

**Example:** *"Define policies once: who can call what, under which conditions, and what requires confirmation. Every call is audited and redacted."*

### 4. **Lifecycle** — Doctor, Explorer, diff, conformance, diagnostics, and OpenTelemetry.

Show that AskTurret comes with operational tools. This builds confidence that the project is production-ready and not just a one-shot library.

**Example:** *"Use `mcp doctor` to score readiness, Explorer to browse and test tools locally, and OpenTelemetry to observe production calls."*

---

## What We DO Say

- **"Production-grade"** — emphasizes safety and observability, not heaviness.
- **"Embeddable"** — one library in your application process, not a separate service.
- **"Agent-facing"** — the tools are shaped for agents, not a mirror of the REST API.
- **"Multiple sources"** — OpenAPI, framework routes, schemas, handlers, HTTP proxies.
- **"One model"** — same Discover → Shape → Govern → Serve → Observe pipeline regardless of source.
- **"Policy"** — use this word for governance rules (authentication, authorization, confirmation, audit).
- **"Operation"** — use this for the basic unit (e.g., "each operation is independently governed").
- **"Direct handler"** — execution from in-process code (preferred).
- **"HTTP proxy"** — execution from an existing remote API (compatibility path).

---

## What We DON'T Say (and Why)

### ❌ Do NOT lead with "enterprise governance."

**Why:** It telegraphs "heavy" before a developer has seen how easy the Light path is. Enterprise features exist, but they come after the developer proves value to themselves.

**Instead:** Lead with the quick win, then mention governance as a feature for when they're ready.

### ❌ Do NOT lead only with "OpenAPI-to-MCP."

**Why:** It positions us in the commoditizing generator category. A generator produces a static artifact; AskTurret is a runtime. The distinction is critical.

**Instead:** Emphasize that we're a runtime that *supports* OpenAPI (among other sources) and can be updated without regeneration.

### ❌ Do NOT say "code generation."

**Why:** Generators produce code; we produce a running server. Avoid confusion.

**Instead:** "Discover," "compile," or "derive" when describing the transformation from input sources to runtime definitions.

### ❌ Do NOT disparage competitors by name.

**Why:** It looks unprofessional and creates noise when someone searches. Address categories, not products.

**Instead:** "Unlike static generators..." or "Unlike single-source solutions..." when comparison is necessary.

### ❌ Do NOT promise "automatic" agent behavior.

**Why:** Agents still make decisions. We help them make safer decisions.

**Instead:** "Governed," "audited," "policy-driven," or "confirmation-required."

### ❌ Do NOT say "REST to MCP" without qualification.

**Why:** Implies REST is the only source. We support multiple sources.

**Instead:** "OpenAPI to MCP," "API to MCP," or "operations to MCP."

---

## Terminology Conventions

Use these terms consistently across docs, copy, and conversations:

| Term | Use | Don't use |
|------|-----|-----------|
| **Operation** | A single unit of work (derived from OpenAPI path, route, or explicit definition) | "endpoint", "function", "method", "tool" (tool is MCP-level) |
| **Tool** | An MCP-level capability (final form sent to agents) | "operation" when describing MCP surface |
| **Policy** | A governance rule (authentication, authorization, confirmation) | "permission", "access control" (too narrow) |
| **Policy engine** | The component that evaluates policies | N/A |
| **Overlay** | Explicit enhancements to discovered operations (names, descriptions, effects, schemas) | "customization", "patch" |
| **Compiler** | The pipeline that turns sources into a RegistrySnapshot | "parser", "generator" |
| **Direct handler** | In-process execution (preferred) | "handler" alone (ambiguous) |
| **HTTP proxy** | Remote/legacy API execution | "HTTP execution", "proxy mode" |
| **Preset** | A pre-configured policy bundle (Light, Production, Regulated) | "mode", "tier" |
| **Explorer** | The UI for browsing, testing, and inspecting operations | "dashboard", "UI" (acceptable but less specific) |
| **Readiness score** | The `doctor` output indicating what operations are safe to expose | "compatibility score", "validation score" |

---

## Buyer Segments and Value Drivers

Understand who we're talking to and why they listen:

### Segment A: Developers (Fast path)
- **Pain:** Sharing APIs with agents requires boilerplate, duplication, or one-off generators.
- **Value:** One library, minimal config, works immediately.
- **Message order:** Immediate result → Differentiation → Lifecycle.
- **Lead channel:** GitHub, npm, code examples.

### Segment B: API/Platform teams (Governance path)
- **Pain:** Agent access to production APIs creates compliance and security gaps. Regenerating tools loses custom policies and audit trails.
- **Value:** One runtime, policies enforced at call time, full audit trail, zero regeneration.
- **Message order:** Immediate result → Differentiation → Trust → Lifecycle.
- **Lead channel:** Architecture docs, compliance/security pages, case studies.

### Segment C: Community/Ecosystem players
- **Pain:** Building framework adapters, executor plugins, or additional sources requires guessing how the runtime works.
- **Value:** Stable plugin API, conformance suite, clear extension points.
- **Message order:** Differentiation → Lifecycle → (Trust for regulated use).
- **Lead channel:** CONTRIBUTING, architecture docs, plugin examples.

---

## Market Position

AskTurret MCP sits at the intersection of four categories:

1. **API management and OpenAPI tooling** — We import OpenAPI, validate it, and compile it into runtime definitions.
2. **MCP server frameworks** — We expose operations over the Model Context Protocol.
3. **OpenAPI → MCP generators** — We are closest to this category but differ fundamentally (runtime, not static code).
4. **Agent security and governance** — We provide policies, confirmation, audit, and redaction.

**Key differentiators:**

- **Canonical model:** Multiple sources run through the same pipeline, not separate code paths.
- **Runtime, not generator:** Policies, overlays, and operations are reloadable without regeneration.
- **Provenance-aware:** Every field can trace its source (OpenAPI, overlay, inference) for debuggability.
- **Quality compiler:** Operations are validated, simplified, and scored for agent usability — not just protocol compliance.

---

## Defensive Messaging

When addressing common concerns:

### "Why not just use a generator?"

Generators produce static code. AskTurret is a runtime. Advantages:

- **No regeneration required:** Overlays and policies change without regenerating code.
- **Call-time authorization:** Policies reevaluate with each request, based on identity and input.
- **Provenance and precedence are explicit:** Explorer and diff tools show where each field came from and why it took a particular value.
- **Multiple sources, one model:** Switch from HTTP proxying to direct handlers without changing tool signatures.

### "Will this work with our existing OpenAPI?"

Probably, but let's check. Use `mcp doctor` to score readiness. Most issues are fixable via overlays (non-invasive customization) without touching the source.

### "What about governance?"

Three presets: Light (development), Production (authentication + basic policies), and Regulated (full audit, redaction, confirmation). All support policies that are enforced at call time, not just discovery time.

### "Does this require a hosted service?"

No. AskTurret is an embedded library. It runs in your application process. Tracing and audit can be sent to your own backend.

### "How does it differ from MCP TypeScript SDK?"

The SDK is the protocol foundation. AskTurret layers on top with discovery, compilation, policy, and execution lifecycle. Most applications should use AskTurret; only custom protocol servers or non-HTTP transports need the SDK directly.

---

## Launch Messaging Sequence

When going public:

1. **Announcement:** Headline + supporting line + five-minute quick start.
2. **Technical deep dive:** Product model (Discover → Shape → Govern → Serve → Observe) + architecture overview.
3. **Use cases:** Developer path (Light) and governance path (Production/Regulated).
4. **Comparison:** Table showing where we fit vs. generators and other solutions.
5. **Community:** How to contribute, roadmap, governance structure.

---

## Approval and Updates

- Marketing maintains this doc.
- Architect reviews technical accuracy.
- Founder approves messaging direction and key claims.
- All public-facing content (README, landing page, copy) should trace back to approved messaging from this document.

Last updated: [Date this was created]
