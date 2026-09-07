// SPDX-License-Identifier: Apache-2.0
/**
 * The README's headline proof command actually works (#716).
 *
 * The quick start's payoff is a single curl a newcomer pastes to prove the
 * project works. It documented `GET /mcp/tools/list` and returned 404: MCP
 * speaks JSON-RPC 2.0 over `POST` to one endpoint, so `tools/list` is a METHOD
 * NAME, not a URL path. `packages/transports/src/http/index.ts` 404s any path
 * that is not the mounted base path, and `GET` on the base path is already the
 * SSE stream.
 *
 * This is the third defect on this exact surface — #103 / PR #105 fixed
 * `tools/call` on the same path in August, and #716 is `tools/list`. Both
 * shipped because nothing executable covered the README's HTTP examples. That
 * hole is what this file closes.
 *
 * ## Why the README is READ rather than transcribed
 *
 * A test that hardcodes its own copy of the documented command passes forever
 * while the README says something else — the README can change and the test
 * keeps proving the old copy. That is #710, filed against
 * `subpath-export.test.ts` for exactly this shape. So the command executed here
 * is PARSED OUT OF `README.md` at run time: revert the README to the GET form
 * and the parse finds no POST and no JSON-RPC body, and this goes red.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';

import { mcpFromOpenApi } from '../index.js';

/**
 * Resolve the repo root from THIS module, not `process.cwd()` — which is the
 * package root under `npm test` and the repo root under other runners. Same
 * reasoning as `petstore-example.test.ts` next door.
 */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/__tests__ (ts-jest) or dist/__tests__ (built) -> package -> packages -> repo
  return resolvePath(here, '../../../..');
}

const README_PATH = resolvePath(repoRoot(), 'README.md');
const SPEC_PATH = resolvePath(repoRoot(), 'examples/petstore-light/openapi.yaml');

/** The prose marker the quick start's proof command sits under. */
const PROOF_MARKER = 'Your API now exposes tools over MCP';

/**
 * The fenced bash block containing the quick start's proof command.
 *
 * Anchored on the prose marker rather than a line number so ordinary edits to
 * the README above it do not break the parse.
 */
function proofBlock(): string {
  const readme = readFileSync(README_PATH, 'utf8');
  const markerAt = readme.indexOf(PROOF_MARKER);
  if (markerAt === -1) {
    throw new Error(
      `README.md no longer contains the quick-start proof marker ${JSON.stringify(PROOF_MARKER)}. ` +
        'If the marker was reworded, update PROOF_MARKER here in the same change.',
    );
  }
  const fenceEnd = readme.indexOf('```', markerAt);
  if (fenceEnd === -1) {
    throw new Error('README.md quick-start proof block is not closed by a fence.');
  }
  return readme.slice(markerAt, fenceEnd);
}

/**
 * The JSON-RPC request body the README tells the reader to send.
 *
 * Returns `undefined` when the documented command carries no `-d` payload —
 * which is precisely the pre-#716 GET form, and what makes this red on revert.
 */
function documentedRequestBody(block: string): unknown | undefined {
  // `-d '<json>'`, allowing the single-quoted payload to span lines.
  const match = block.match(/-d\s+'([^']*)'/);
  if (match === null) {
    return undefined;
  }
  return JSON.parse(match[1] as string);
}

/** Every markdown file that is ours — node_modules and build output excluded. */
function markdownFiles(root: string): string[] {
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage', 'build']);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md')) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

let app: Express;

beforeAll(() => {
  app = express();
  // Deliberately no app-level `express.json()`: a global body parser consumes
  // the request stream the MCP transport reads for itself. This mirrors the
  // shipped example, and the README snippet, exactly.
  app.use('/mcp', mcpFromOpenApi(SPEC_PATH));
});

afterAll(() => {
  // Nothing to tear down: supertest binds an ephemeral port per request and the
  // facade holds no listener of its own.
});

describe("the README's quick-start proof command (#716)", () => {
  it('documents a POST to the mounted endpoint, not a GET path', () => {
    const block = proofBlock();
    expect(block).toContain('-X POST');
    expect(block).toContain('/mcp');
    // The defect itself: `tools/list` presented as a URL path segment.
    expect(block).not.toContain('/mcp/tools/list');
  });

  it('documents a well-formed JSON-RPC 2.0 tools/list request', () => {
    const body = documentedRequestBody(proofBlock()) as Record<string, unknown> | undefined;
    expect(body).toBeDefined();
    expect(body?.['jsonrpc']).toBe('2.0');
    expect(body?.['method']).toBe('tools/list');
  });

  it('succeeds against a real server, returning the tool list', async () => {
    const body = documentedRequestBody(proofBlock());
    const response = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send(body as object);

    expect(response.status).toBe(200);
    expect(response.body?.result?.tools).toBeInstanceOf(Array);
    // The spec the example ships declares exactly these two operations.
    const names = (response.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('listPets');
  });

  it('404s the form the README used to document, proving the fix was needed', async () => {
    const response = await request(app).get('/mcp/tools/list');
    expect(response.status).toBe(404);
  });
});

describe('no doc surface presents an MCP method as a URL path (#716, #103)', () => {
  it('leaves no copy of the GET-path form behind', () => {
    const offenders: string[] = [];
    for (const file of markdownFiles(repoRoot())) {
      const text = readFileSync(file, 'utf8');
      // The URL-path form specifically. A bare `tools/list` is the legitimate
      // JSON-RPC method name and appears throughout the docs on purpose.
      if (text.includes('/mcp/tools/list') || text.includes('/mcp/tools/call')) {
        offenders.push(file.slice(repoRoot().length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
