// SPDX-License-Identifier: Apache-2.0
/**
 * Real integration tests with actual Express app and HTTP requests
 *
 * These tests catch routing bugs that mocked tests miss,
 * particularly Express prefix-stripping behavior.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mcpFromOpenApi } from '../index.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Express facade integration (real HTTP)', () => {
  it('should handle POST /mcp with tools/list', async () => {
    // Create a real Express app
    const app = express();

    // Mount the facade at /mcp
    const petstoreSpec = join(__dirname, '../../../sources-openapi/src/__tests__/fixtures/petstore.json');
    app.use('/mcp', mcpFromOpenApi(petstoreSpec));

    // Make a real HTTP request
    const response = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      })
      .expect('Content-Type', /json/)
      .expect(200);

    // Verify response structure
    expect(response.body).toHaveProperty('jsonrpc', '2.0');
    expect(response.body).toHaveProperty('id', 1);
    expect(response.body).toHaveProperty('result');
    expect(response.body.result).toHaveProperty('tools');
    expect(Array.isArray(response.body.result.tools)).toBe(true);
  });

  it('should handle POST /mcp with initialize', async () => {
    const app = express();
    const petstoreSpec = join(__dirname, '../../../sources-openapi/src/__tests__/fixtures/petstore.json');
    app.use('/mcp', mcpFromOpenApi(petstoreSpec));

    const response = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body).toHaveProperty('jsonrpc', '2.0');
    expect(response.body).toHaveProperty('result');
    expect(response.body.result).toHaveProperty('protocolVersion');
    expect(response.body.result).toHaveProperty('serverInfo');
  });

  it('should serve GET /mcp/explorer in development mode', async () => {
    const app = express();
    const petstoreSpec = join(__dirname, '../../../sources-openapi/src/__tests__/fixtures/petstore.json');

    // Mount with explorer enabled (development mode)
    app.use('/mcp', mcpFromOpenApi(petstoreSpec, { enableExplorer: true }));

    const response = await request(app)
      .get('/mcp/explorer')
      .expect('Content-Type', /html/)
      .expect(200);

    // Verify it's HTML content
    expect(response.text).toContain('<!DOCTYPE html>');
    expect(response.text).toContain('AskTurret MCP Explorer');
  });

  it('should return 404 for GET /mcp/explorer in production mode', async () => {
    const app = express();
    const petstoreSpec = join(__dirname, '../../../sources-openapi/src/__tests__/fixtures/petstore.json');

    // Mount with explorer disabled (production mode)
    app.use('/mcp', mcpFromOpenApi(petstoreSpec, { enableExplorer: false }));

    const response = await request(app)
      .get('/mcp/explorer')
      .expect('Content-Type', /json/)
      .expect(404);

    expect(response.body).toHaveProperty('error');
    expect(response.body.error).toContain('not available in production');
  });

  it('should handle tools/call with actual tool invocation', async () => {
    const app = express();
    const petstoreSpec = join(__dirname, '../../../sources-openapi/src/__tests__/fixtures/petstore.json');
    app.use('/mcp', mcpFromOpenApi(petstoreSpec));

    const response = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'listPets',
          arguments: { limit: 10 },
        },
      })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body).toHaveProperty('jsonrpc', '2.0');
    expect(response.body).toHaveProperty('id', 2);
    // Note: result or error, depending on executor implementation
    expect(response.body).toHaveProperty('result');
  });

  it('should handle basePath other than /mcp', async () => {
    const app = express();
    const petstoreSpec = join(__dirname, '../../../sources-openapi/src/__tests__/fixtures/petstore.json');

    // Mount at /api/mcp instead of /mcp
    app.use('/api/mcp', mcpFromOpenApi(petstoreSpec, { basePath: '/api/mcp' }));

    const response = await request(app)
      .post('/api/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body).toHaveProperty('jsonrpc', '2.0');
    expect(response.body).toHaveProperty('result');
  });

  it('should return 404 for unknown paths', async () => {
    const app = express();
    const petstoreSpec = join(__dirname, '../../../sources-openapi/src/__tests__/fixtures/petstore.json');
    app.use('/mcp', mcpFromOpenApi(petstoreSpec));

    const response = await request(app)
      .post('/mcp/unknown')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      })
      .expect(404);

    expect(response.body).toHaveProperty('error');
  });
});
