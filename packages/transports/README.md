# @askturret/mcp-transports

The wire layer: MCP's **Streamable HTTP** transport, plus the session storage it
needs. This is what carries JSON-RPC between an agent and the runtime.

Most people never install this directly — the Express and Fastify adapters pull
it in and wire it up. Install it yourself when you are serving MCP from a
framework we do not ship an adapter for, or when you need to control session
storage.

## What it is for

```js
import { createHttpTransport, createInMemorySessionStore } from '@askturret/mcp-transports';

const transport = createHttpTransport({
  sessionStore: createInMemorySessionStore(),
});
```

`createHttpTransport` gives you the request-handling half of a server;
`createInMemorySessionStore` is a `SessionStore` implementation suitable for a
single process.

## Sessions

Streamable HTTP is stateless per request but MCP conversations are not, so
session state is an explicit dependency rather than a hidden global. The
in-memory store is the default and is the right choice for one process. It is
**not** shared across instances: behind a load balancer, or anywhere requests
for one session can land on different processes, implement `SessionStore`
against something shared.

Making the store an interface rather than an implementation detail is the point
— the transport does not care where session data lives.

## Requirements

```bash
npm install @askturret/mcp-transports
```

`@modelcontextprotocol/sdk` is a **peer dependency** (`^1.24.0`) — install it
yourself so there is exactly one copy of the protocol types in your tree. Node 20+.

## What it does not do

It moves bytes and tracks sessions. It does not discover operations, compile
them, apply policy or execute anything — all of that is
[`@askturret/mcp-core`](https://www.npmjs.com/package/@askturret/mcp-core).

It is also not a framework binding: it does not know about Express routers or
Fastify plugins. If that is what you want, the adapters are thinner than doing
it by hand.

---

Full documentation is in the [main README](https://github.com/askturret/mcp#readme).
