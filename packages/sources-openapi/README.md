# @askturret/mcp-sources-openapi

Turns an OpenAPI document into the canonical operations the AskTurret runtime
compiles. It is the bridge between a spec you already maintain and the tools an
agent sees.

## What it is for

```js
import { fromOpenApi } from '@askturret/mcp-sources-openapi';

const source = fromOpenApi('./openapi.yaml');
```

Hand the result to the runtime — or, more often, let an adapter do it: the
`mcpFromOpenApi(...)` one-liner in the Express and Fastify adapters is this
source wired up for you.

It supports **OpenAPI 3.0 and 3.1**, resolves `$ref`, preserves where each
operation came from, and extracts `x-mcp` extension metadata so a spec can carry
MCP-specific hints without a second file.

## MCP metadata goes in a nested `x-mcp` object

```yaml
paths:
  /pets:
    post:
      operationId: createPet
      x-mcp:
        effects: [destructive]
```

The extractor reads `x-mcp` and merges path-level with operation-level, the
operation winning. Flat `x-mcp-*` keys are a different shape and are not read
here.

## Installing

```bash
npm install @askturret/mcp-sources-openapi
```

Node 20+.

## What it does not do

This package **discovers**; it does not serve and it does not execute. It
produces `OperationDefinition`s and stops there:

- it does not open a port — that is `@askturret/mcp-transports`, or an adapter;
- it does not decide what is exposed — presets and the include filter, in
  `@askturret/mcp-core`, do that, and mutating operations are opt-in;
- it does not call your API — executors do, and which executor runs is your choice.

Nor does it validate that your spec is *good*. `turret doctor` in
[`@askturret/mcp-cli`](https://www.npmjs.com/package/@askturret/mcp-cli) is the
tool that scores a spec for agent-readiness and tells you what is missing.

---

Full documentation is in the [main README](https://github.com/askturret/mcp#readme).
