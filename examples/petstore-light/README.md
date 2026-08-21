# Petstore Light Example

This example demonstrates the 5-minute quick start experience with AskTurret MCP.

## Quick Start

```bash
npm install
npm start
```

The server will start on port 3000 (or PORT environment variable).

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

## What's Included

- **openapi.yaml** - Petstore OpenAPI 3.0 specification
- **index.js** - Minimal MCP server using `mcpFromOpenApi()`
- **package.json** - Dependencies and start script

This example uses the Light preset, which automatically exposes read-only operations and requires explicit inclusion for mutations.
