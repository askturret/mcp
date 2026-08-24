# Petstore Light Example

This example demonstrates the 5-minute quick start experience with AskTurret MCP.

## Quick Start

```bash
npm install
npm start
```

The server will start on port 3000 (or PORT environment variable).

## Calling a tool

Tool calls are proxied to the upstream API named in the spec's `servers` entry,
using each operation's own method and path — `listPets` becomes
`GET {server}/pets`, and `getPetById` becomes `GET {server}/pets/{petId}`.

The spec points at `https://petstore.example.com/api/v1`, an illustrative host
that does not exist. So this example also **serves that API locally** and points
the MCP server at it with `baseUrl`, which means `tools/call` works out of the
box:

```js
const upstreamBaseUrl = `http://127.0.0.1:${port}/petstore-api`;
app.use('/mcp', mcpFromOpenApi('./openapi.yaml', { baseUrl: upstreamBaseUrl }));
```

Nothing is stubbed at the MCP layer. The call runs through the same `viaHttp`
executor a production deployment uses, over a real HTTP request — only the
upstream is swapped for one that exists. Point `baseUrl` at a real API (or set
`PETSTORE_BASE_URL`) and the same code talks to it:

```js
app.use('/mcp', mcpFromOpenApi({
  spec: './openapi.yaml',
  baseUrl: 'https://your-real-api.example.com',
}));
```

`baseUrl` overrides the spec's `servers` entry. Supply it when the spec declares
no absolute server, declares several and you want a specific one, or points at
an environment you are not targeting.

The spec itself is deliberately left pointing at the illustrative host rather
than at localhost: it is shared with the reliability suite, and the local
override belongs in the wiring, which is what `baseUrl` is for.

## Endpoints

- **MCP JSON-RPC**: `POST http://localhost:3000/mcp`
- **Explorer UI**: `GET http://localhost:3000/mcp/explorer` (development only)
- **Health Check**: `GET http://localhost:3000/health`

## Test with curl

List available tools:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

Expected response should include 2 read-only operations:
- `listPets` - List all pets
- `getPetById` - Get a pet by ID

Now actually call one:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":2,
       "params":{"name":"listPets","arguments":{"limit":2}}}'
```

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text",
  "text":"{\"pets\":[{\"id\":\"pet-1\",\"name\":\"Rex\",\"species\":\"dog\",\"age\":3},{\"id\":\"pet-2\",\"name\":\"Mittens\",\"species\":\"cat\",\"age\":5}],\"total\":3}"}]}}
```

Note `total` is 3 while two pets came back — `limit` was applied by the upstream,
not by the MCP layer. Fetch one by id:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":3,
       "params":{"name":"getPetById","arguments":{"petId":"pet-2"}}}'
```

## What's Included

- **openapi.yaml** - Petstore OpenAPI 3.0 specification
- **index.js** - Minimal MCP server using `mcpFromOpenApi()`, plus the small
  in-process backend the spec describes (three pets, `limit`, and a 404)
- **package.json** - Dependencies and start script

This example uses the Light preset, which automatically exposes read-only operations and requires explicit inclusion for mutations.
