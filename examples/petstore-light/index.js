/**
 * Petstore Light Example
 *
 * Demonstrates the 5-minute quick start experience with mcpFromOpenApi().
 * This example boots a working MCP server from a Petstore OpenAPI spec.
 */

import express from 'express';
import { mcpFromOpenApi } from '@askturret/mcp-adapters-express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get current directory (ESM equivalent of __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Create MCP router from OpenAPI spec
const specPath = join(__dirname, 'openapi.yaml');
const mcpRouter = mcpFromOpenApi(specPath);

// Mount the MCP router
app.use('/mcp', mcpRouter);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'petstore-mcp' });
});

// Start server
app.listen(port, () => {
  console.log(`Petstore MCP server listening on port ${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`Explorer: http://localhost:${port}/mcp/explorer`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log('\nTry: POST http://localhost:' + port + '/mcp with {"jsonrpc":"2.0","method":"tools/list","id":1}');
});
