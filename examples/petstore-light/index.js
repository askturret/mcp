/**
 * Petstore Light Example
 *
 * Demonstrates the 5-minute quick start experience with mcpFromOpenApi().
 * This example boots a working MCP server from a Petstore OpenAPI spec — and a
 * tiny in-process backend for that spec to call, so `tools/call` actually
 * returns a result.
 *
 * ## Why the mock upstream is here (#99)
 *
 * `openapi.yaml` declares `https://petstore.example.com/api/v1`, which is a
 * fictional host. Discovery does not care — `tools/list` only needs the spec —
 * but a real `tools/call` has to reach something, and against a host that does
 * not resolve it returns a well-formed `UPSTREAM_UNAVAILABLE`. Correct, and a
 * poor first impression: the quick start could show tools being LISTED but
 * never one being CALLED.
 *
 * So this file serves the spec's own two endpoints locally and points the MCP
 * server at them with `baseUrl`. Nothing is stubbed at the MCP layer: the call
 * goes through the same `viaHttp` executor a production deployment uses, over a
 * real HTTP request. What you see working here is the real call path, with only
 * the upstream swapped for one that exists.
 *
 * The spec is deliberately NOT edited to point at localhost. It is shared with
 * the reliability suite, and a spec that names a real-looking upstream is the
 * honest thing to hand a reader — the local override belongs in the wiring,
 * which is exactly what `baseUrl` is for.
 */

import express from 'express';
import { mcpFromOpenApi } from '@askturret/mcp-adapters-express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get current directory (ESM equivalent of __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = Number(process.env.PORT ?? 3000);

// ---------------------------------------------------------------------------
// The mock upstream — the API the spec describes
// ---------------------------------------------------------------------------

/** Seed data. Enough rows that `limit` visibly does something. */
const PETS = [
  { id: 'pet-1', name: 'Rex', species: 'dog', age: 3 },
  { id: 'pet-2', name: 'Mittens', species: 'cat', age: 5 },
  { id: 'pet-3', name: 'Kiwi', species: 'bird', age: 1 },
];

const petstoreApi = express.Router();

// GET /pets — mirrors the spec's `listPets`, including its `limit` bound.
petstoreApi.get('/pets', (req, res) => {
  const raw = Number.parseInt(String(req.query.limit ?? '20'), 10);
  const limit = Number.isNaN(raw) ? 20 : Math.min(Math.max(raw, 1), 100);
  // `total` is the full count, not the page length — a paged response that
  // reports the page size as the total is the classic version of this bug.
  res.json({ pets: PETS.slice(0, limit), total: PETS.length });
});

// GET /pets/{petId} — mirrors the spec's `getPetById`, 404 included. The spec
// documents a 404 response, so the mock has to be able to produce one.
petstoreApi.get('/pets/:petId', (req, res) => {
  const pet = PETS.find((p) => p.id === req.params.petId);
  if (!pet) {
    res.status(404).json({ error: 'not_found', message: `No pet with id ${req.params.petId}` });
    return;
  }
  res.json(pet);
});

// Mounted on the same app purely to keep the example one process and one
// `npm start`. Note there is deliberately no app-level `express.json()`: a
// global body parser consumes the request stream the MCP transport needs to
// read for itself. These routes are GET-only and need no parser at all.
app.use('/petstore-api', petstoreApi);

// ---------------------------------------------------------------------------
// The MCP server
// ---------------------------------------------------------------------------

// 127.0.0.1 rather than `localhost`: on a dual-stack machine `localhost` can
// resolve to ::1 while the server is listening on IPv4, which surfaces as a
// connection refusal that looks like a bug in the executor.
const upstreamBaseUrl = process.env.PETSTORE_BASE_URL ?? `http://127.0.0.1:${port}/petstore-api`;

const specPath = join(__dirname, 'openapi.yaml');
const mcpRouter = mcpFromOpenApi(specPath, { baseUrl: upstreamBaseUrl });

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
  console.log(`Mock upstream: ${upstreamBaseUrl}/pets`);
  console.log('\nTry: POST http://localhost:' + port + '/mcp with {"jsonrpc":"2.0","method":"tools/list","id":1}');
  console.log('Then: POST the same URL with {"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"listPets","arguments":{"limit":2}}}');
});
