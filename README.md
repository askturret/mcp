# AskTurret MCP

Agent-facing API layer - discover, shape, govern, and serve operations through Model Context Protocol.

## Architecture

AskTurret MCP is an embeddable library that:
- Discovers existing application operations from OpenAPI, framework routes, or explicit definitions
- Shapes them into agent-friendly capabilities
- Governs their visibility and execution through policy
- Exposes them via the Model Context Protocol (MCP)

## Installation

```bash
npm install @askturret/mcp
```

## Quick Start

```typescript
import { createMcpServer } from '@askturret/mcp';
import { fromOpenApi } from '@askturret/mcp/openapi';
import { expressMcp } from '@askturret/mcp/express';
import { openTelemetry } from '@askturret/mcp/otel';

// Light mode - minimal configuration
const server = createMcpServer({
  sources: [
    fromOpenApi('./api-spec.yaml')
  ]
});

// Mount on Express
app.use('/mcp', expressMcp({ server }));

// Add telemetry
server.use(openTelemetry({ serviceName: 'my-api' }));
```

## Workspace Structure

This is a monorepo using npm workspaces:

```
packages/
├── core/              # Core runtime - canonical model, compiler, registry
├── transports/        # MCP transport adapters
├── sources-openapi/   # OpenAPI import
├── adapters-express/  # Express framework adapter
├── observability/     # OpenTelemetry integration
├── explorer/          # Local Explorer UI (stub)
├── cli/               # CLI tools (doctor, inspect, diff)
└── examples/          # Example applications
```

## Subpath Exports

The package provides the following subpath exports:

- `@askturret/mcp` - Main server API
- `@askturret/mcp/openapi` - OpenAPI import
- `@askturret/mcp/express` - Express adapter
- `@askturret/mcp/otel` - OpenTelemetry integration

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Type check
npm run typecheck
```

## Requirements

- Node.js >= 20.0.0
- TypeScript >= 5.5.0

## License

MIT

## Status

This is the initial v0.1 release focused on foundational scaffolding. Full implementations coming in subsequent releases.
