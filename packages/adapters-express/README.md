# @askturret/mcp-adapters-express

Mount an MCP server into an existing Express app. For most people this is the
package to install first: one line turns an OpenAPI spec into MCP tools your
agents can call.

## Five-minute version

```bash
npm install express @askturret/mcp-adapters-express
```

```js
import express from 'express';
import { mcpFromOpenApi } from '@askturret/mcp-adapters-express';

const app = express();
app.use('/mcp', mcpFromOpenApi('./openapi.yaml'));
app.listen(7078);
```

`/mcp` now speaks MCP over JSON-RPC 2.0. `tools/list` returns the operations
discovered from your spec; `tools/call` executes them.

## The composable form

When the one-call form stops fitting — several sources, a custom executor, your
own policy — `expressMcp` takes the same runtime with the parts named
explicitly:

```js
import { expressMcp } from '@askturret/mcp-adapters-express';

app.use('/mcp', expressMcp({ sources: [...], executor: ... }));
```

Both forms produce a standard Express `Router`, so ordinary middleware,
mounting and error handling apply.

## Defaults you are opting into

The one-call form applies the **Light preset**, which is chosen to be safe
before it is complete:

- read-only operations are exposed automatically, provided their schemas validate;
- **mutating operations require explicit inclusion** — they do not appear by accident;
- stateless HTTP transport, payloads bounded at 1 MiB, 30-second deadline;
- the local Explorer UI is mounted only when `NODE_ENV !== 'production'`.

## Requirements and scope

Express is a **peer dependency**, `^4.18.0 || ^5.0.0` — install it yourself, and
both majors are exercised by CI. Node 20+.

This package is the Express-shaped part and nothing else. Discovery,
compilation, policy and execution all come from
[`@askturret/mcp-core`](https://www.npmjs.com/package/@askturret/mcp-core); the
same facade backs the Fastify adapter, which is how we know the design is not
accidentally Express-shaped. If you are on Fastify, use
[`@askturret/mcp-adapters-fastify`](https://www.npmjs.com/package/@askturret/mcp-adapters-fastify)
— the entry points are identical.

---

Full documentation and the compatibility matrix are in the
[main README](https://github.com/askturret/mcp#readme).
