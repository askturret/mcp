# Why Not Just Generate Code?

When evaluating how to expose an API to agents, you'll encounter tools that generate static code from an OpenAPI spec — a single tool definition, written to disk, ready to check in. AskTurret MCP is different: a runtime that compiles your spec on demand.

This essay explains why a runtime beats code generation for most use cases.

---

## The Problem with Code Generation

### 1. Regeneration is Destructive

You change your OpenAPI spec. You run the generator again. It overwrites your code.

Any customizations you've made — renamed parameters for clarity, added field examples, changed descriptions for agents, added custom metadata — **disappear**. You're forced to either:

- Accept the generated output as-is (losing customizations), or
- Reapply customizations by hand every regeneration cycle (error-prone and tedious), or
- Maintain a separate customization layer (duplicate state, version mismatch risk).

**AskTurret solution:** Overlays are non-invasive. You can customize operations without touching the source spec. Regenerate the snapshot (not code); overlays stay in place.

```yaml
# openapi.yaml (yours, unchanged)
paths:
  /users:
    get:
      summary: "retrieve users"
      ...

# askturret.overlays.yaml (your customizations)
operations:
  - id: listUsers
    description: "List all users" # Override for agents
    examples: 
      - input: { limit: 10 }
        output: { count: 2 }
```

### 2. Policy Changes Require Redeploy

Your policy changes. Alice can't call `deleteUser` anymore. Bob must confirm destructive operations.

In a code-generated world, policies are baked into the generated code. Changing them means regenerating and redeploying. In a complex system, this might mean:

- Regenerating 50 tools
- Re-testing all 50 (even the ones you didn't change)
- Redeploying the bundle
- Downtime or canary rollout

**AskTurret solution:** Policies are loaded at runtime. Change a policy, reload the server (zero-downtime registry swap). No regeneration, no redeploy. Same immutable registry snapshot, different execution behavior.

```ts
// Old policy
const policy = allOf([
  authenticated(),
  rolesBased({ user: ['listPets'], admin: ['*'] }),
]);

// New policy (just update and reload)
const policy = allOf([
  authenticated(),
  rolesBased({ 
    user: ['listPets', 'createPet'],  // Alice can now create
    admin: ['*'] 
  }),
  confirmationForEffects(['financial']),  // Bob must confirm
]);

server.reload(newPolicy); // Atomic, zero-downtime
```

### 3. Authorization Happens at Discovery Time

Most generators evaluate authorization once: when the code is generated. The generated tool is either visible to an agent or it isn't.

But real authorization is contextual. Alice can call `listUsers`, but she can only see users in her department. Bob can call `deleteUser`, but only for test accounts, not production.

Static code can't express this. You'd need to generate per-user variants, or generate `delete_user_test` and `delete_user_production` as separate tools — explosion of surface area.

**AskTurret solution:** Policy evaluation happens twice.

1. **Discovery-time:** Filter `tools/list` based on broad rules.
2. **Call-time:** Reevaluate with actual request context (identity, input, time).

```ts
// Broad: Alice sees all tools
const discoveryPolicy = authenticated();

// Granular: Alice can only delete test accounts
const callTimePolicy = allOf([
  authenticated(),
  authorizationPolicy({
    'alice': ['delete_user_test'],
    'bob': ['*'],
  }),
]);

// Tools/list shows what's broadly accessible
// tools/call reevaluates with actual identity and input
```

### 4. Provenance and Precedence Become Invisible

Code generation flattens the decision tree. The final generated code doesn't explain why a field has its current value.

For example, why is this parameter optional?

- Was it optional in the OpenAPI spec?
- Did we make it optional during generation?
- Did someone override it in a customization layer?
- Is it inferred from the type?

If you need to debug or update it later, you're left guessing.

**AskTurret solution:** Every field retains provenance.

```ts
interface SourcedValue<T> {
  readonly value: T;
  readonly source: ProvenanceSource;  // { kind: ProvenanceKind; location?: string }
}
```

`location` records where the value came from — e.g.
`"askturret.overlays.yaml line 42"`. The `ProvenanceKind` members and their
precedence are defined once, in `packages/core/src/overlay/types.ts`, and
explained in
[the precedence chain](architecture-overview.md#4-provenance-aware-overlays).

Explorer shows you exactly where each field came from and why it took its value. If you need to trace a bug or update something, the trail is clear.

### 5. Multiple Source Paths Become Separate Artifacts

Your API exists in OpenAPI. Your Express app has additional routes. You also have some custom handlers.

A generator can't easily combine them. You end up with:
- `generated_tools_from_openapi.ts`
- `custom_handlers.ts`
- `express_routes.ts`
- Plus custom logic to merge them, dedup, handle conflicts

Multiple source paths → multiple code artifacts → version mismatch risk → operator burden.

**AskTurret solution:** All sources feed one compilation pipeline.

```ts
const server = createMcpServer({
  sources: [
    fromOpenApi('./spec.yaml'),
    fromExpress(app),
    fromDefinitions(customOps),
  ],
  // Conflicts are resolved deterministically
  // One canonical OperationDefinition per operation
  // No duplication
});
```

You can even switch sources. Use HTTP proxy today, add direct handlers later — same tool definition, no regeneration.

---

## When Generators Win

Code generators are useful in specific contexts:

- **One-off scripts:** Single-use, disposable code. Regenerate every time.
- **Exploration:** Quick prototyping before building a runtime solution.
- **No customization:** Specs that are well-curated and rarely change.

But for production systems with governance, policy evolution, and customization needs, a runtime is superior.

---

## Comparison

| Scenario | Generator | AskTurret |
|----------|-----------|-----------|
| **Spec changes** | Regenerate, retest, redeploy | Recompile snapshot (instantaneous) |
| **Policy changes** | Regenerate, redeploy, downtime | Reload, zero-downtime |
| **Contextual authorization** | Hard or impossible | Built-in |
| **Multiple sources** | Manual merge, version mismatch | Unified pipeline |
| **Provenance tracking** | Lost | Preserved |
| **Customization survival** | Requires layering | Non-invasive overlays |
| **Development cycle** | Slow (regen loop) | Fast (live reload) |
| **Audit trail** | Optional / manual | Automatic |
| **One-off prototype** | Fast | Overkill |

---

## Runtime vs Code Generation

The key insight: **Code is static. Operations are dynamic.**

A generator produces static code. It captures a moment in time. After generation, that code is decoupled from your spec. They drift. Policy changes require regeneration. Customizations are fragile.

A runtime stays synchronized with your spec. Policy changes are immediate. Customizations are explicit and durable. Your audit trail is built in. Debugging is transparent.

For most production environments — especially those with governance, audit, and policy needs — **a runtime wins**.

---

## AskTurret's Commitment

AskTurret MCP is designed to replace code generation for agent access:

- **Zero regeneration:** Change your spec, recompile the snapshot (not code).
- **Call-time authorization:** Policies reevaluate with every request.
- **Provenance tracking:** Every field shows its origin.
- **Overlay system:** Customize without duplicating state.
- **Multiple sources:** OpenAPI, routes, handlers, HTTP proxy in one server.

The result: a development workflow that feels like a runtime, not a build tool.

---

## Next Steps

- **[Quick Demo](../README.md#quick-demo)** — Try AskTurret.
- **[Architecture Overview](architecture-overview.md)** — Understand the design.
- **[Overlays and Customization](overlays.md)** — Non-invasive customization patterns.
