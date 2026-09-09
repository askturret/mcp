# @askturret/mcp-adapters-fastify

Register an MCP server as a Fastify plugin. Same runtime and the same two entry
points as the Express adapter — what differs is the plugin shape Fastify expects.

## Registering it

```bash
npm install fastify @askturret/mcp-adapters-fastify
```

```js
import Fastify from 'fastify';
import { mcpFromOpenApi } from '@askturret/mcp-adapters-fastify';

const app = Fastify();
await app.register(mcpFromOpenApi('./openapi.yaml'), { prefix: '/mcp' });
await app.listen({ port: 7078 });
```

Note the `prefix`: unlike Express, where the mount path is an argument to
`app.use`, a Fastify plugin takes it as a registration option. Forgetting it
mounts MCP at the root.

## The composable form

`fastifyMcp` is the explicit counterpart, for when you are supplying sources,
an executor or policy yourself:

```js
import { fastifyMcp } from '@askturret/mcp-adapters-fastify';

await app.register(fastifyMcp({ sources: [...] }), { prefix: '/mcp' });
```

## Defaults you are opting into

The one-call form applies the **Light preset**, identical to the Express
adapter's: read-only operations exposed automatically when their schemas
validate, **mutating operations only when explicitly included**, stateless HTTP
transport, 1 MiB payload bound, 30-second deadline, and the Explorer mounted
only outside production.

## Requirements and scope

Fastify is a **peer dependency**, `^4.0.0 || ^5.0.0` — install it yourself.
Node 20+.

CI currently exercises **Fastify 5**; the 4.x range is declared and expected to
work but is not covered by a job, so treat it as best-effort until it is. The
[compatibility matrix](https://github.com/askturret/mcp/blob/main/docs/compatibility.md)
is the authority on that and says so explicitly.

Everything framework-neutral — discovery, compilation, the include filter, the
user-context allowlist — lives in
[`@askturret/mcp-core`](https://www.npmjs.com/package/@askturret/mcp-core).
What remains here is the Fastify-shaped part, and it is deliberately short:
none of it is policy.

There is **no `fromFastify` export** and there never has been. The entry points
are `mcpFromOpenApi` and `fastifyMcp`. If you are porting from material that
names `fromFastify`, there is nothing to port to.

---

Full documentation is in the [main README](https://github.com/askturret/mcp#readme).
