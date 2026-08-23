# Adapter conformance

§12.2. *"Shared conformance matters more than maximizing the number of official
adapters."*

Every adapter — ours and yours — is held to the same test bank. This page is the
public record.

## Results

| adapter | kit | discovery | schema-preservation | context-propagation | cancellation | error-mapping | authorization-context | lifecycle-cleanup | duplicate-handling | result |
|---|---|---|---|---|---|---|---|---|---|---|
| `express` | 1.0.0 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **PASS** |
| `fastify` | 1.0.0 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **PASS** |

_Generated 2026-08-23._

Regenerate with:

```bash
npm run conformance:table -w @askturret/mcp-adapter-test
```

**Generated from real runs, never hand-written.** A hand-typed table is a claim
about adapters rather than a measurement of them, and it goes stale silently —
which is the exact failure a conformance table exists to prevent.

The two official adapters are measured through the **same public
`AdapterUnderTest` shape** a community adapter uses. If they were measured
through a privileged internal path, their PASS would not mean what your PASS
means and the table would be comparing two different things.

## Testing your adapter

```bash
npx @askturret/mcp-adapter-test ./my-adapter
npx @askturret/mcp-adapter-test ./my-adapter --json --out results.json
npx @askturret/mcp-adapter-test ./my-adapter --category cancellation
npx @askturret/mcp-adapter-test ./my-adapter --generate-badge conformance.svg
```

Your module exports an `AdapterUnderTest`:

```ts
export default {
  name: 'my-adapter',
  async createServer(config) {
    // config is McpFacadeOptions — sources, executor, policies
    const server = await startYourFramework(config);
    return { url: 'http://127.0.0.1:1234/mcp', close: () => server.close() };
  },
};
```

The kit drives it **over HTTP** and never imports your framework. That is why
one bank can hold every adapter to the same standard.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | every category run passed |
| `1` | a category **failed** — your adapter |
| `2` | the kit could not run — bad path, malformed adapter, unknown category |

`1` and `2` are deliberately distinct. A CI job that cannot tell them apart
reports a broken harness as a conformance failure and sends you to debug the
wrong thing.

## The 8 categories (§12.2)

1. **discovery** — tools are listed
2. **schema-preservation** — nested schemas survive the round trip
3. **context-propagation** — request context reaches the executor
4. **cancellation** — a client disconnect aborts the call
5. **error-mapping** — typed errors map to the right JSON-RPC codes
6. **authorization-context** — the principal reaches the policy engine
7. **lifecycle-cleanup** — shutdown releases handles
8. **duplicate-handling** — duplicate operation ids resolve deterministically

## The `--json` contract

The document shape is a **public contract**. The conformance table and adopters'
CI both parse it.

```json
{
  "schemaVersion": 1,
  "kitVersion": "1.0.0",
  "adapter": "my-adapter",
  "passed": true,
  "categories": [{ "id": 1, "category": "discovery", "passed": true, "note": "listed 2 tools" }],
  "knownCategories": ["discovery", "…"],
  "complete": true
}
```

- **`schemaVersion`** bumps when a field is removed or repurposed; additive
  fields keep it. It is **separate from `kitVersion`** because they change for
  different reasons — a parser breaks when the *shape* changes, not when a
  category is added. One number for both would make every new category look like
  a breaking change to every consumer.
- **`complete`** is `false` for a `--category` run. Without it a filtered pass
  would be indistinguishable from a full pass, so **the table generator refuses
  partial results**.

**stdout carries the document and nothing else**, so `--json > results.json` is
safe. The kit diverts everything the run prints to stderr — including whatever
your adapter prints on startup, which it cannot audit.

## Versioning

The kit has **its own semver**, scoped to conformance results. It moves when the
categories change or an existing one gets stricter — not when `@askturret/mcp`
releases.

**A result is scoped to the kit version that produced it.** Passing v1.0 does not
imply passing v1.1 if v1.1 added a category. That is why `kitVersion` is on every
result, in the badge, and in a table column: a green badge that does not say what
it passed is not a claim anyone can check.

## Adding your adapter to this table

1. Run the kit with `--json --out results.json` (a full run — no `--category`).
2. Open a PR adding your row, with the JSON in the description.

Automatic PR opening is deliberately out of scope; a manual PR is fine.
Certification badge issuance is a separate commercial program (§20.3.D) and is
not what the `--generate-badge` SVG is.
