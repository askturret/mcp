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
 *
 * ## What lives here, and what deliberately does not (#734)
 *
 * This file holds ONLY the assertions that need a real mounted adapter. The
 * text-only ones — the shape of the documented command, the server snippet, and
 * the repo-wide sweeps over every markdown file — moved to
 * `.github/scripts/check-doc-surfaces.mjs`.
 *
 * They moved because of WHERE this file runs, not because of what it asserted.
 * It sits under `packages/adapters-express`, so it is scheduled only when that
 * package's path filter matches — and no filter matches the repo-root
 * `README.md` or `docs/**`. Measured on commit `8600c2a`, a doc-only change:
 * all twelve package suites skipped, `test-integrity` ran. So a doc-only edit
 * — the exact change these assertions guard against — did not schedule them.
 *
 * The guard runs in `test-integrity`, which carries no path filter, so those
 * assertions now run on EVERY pull request rather than only on this package's.
 * They were MOVED rather than copied: a second copy that can disagree with the
 * first is the drift this repository keeps filing issues about.
 *
 * The three below stayed because they mount the adapter, which needs four
 * workspace packages built before it can run at all — genuinely expensive, and
 * genuinely about code rather than prose.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
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

/** The heredoc that writes the quick start's spec (#719). */
const SPEC_HEREDOC_OPEN = "cat > petstore.yaml <<'YAML'";

/**
 * The OpenAPI document the quick start tells the reader to write.
 *
 * #719: the quick start referenced `./petstore.yaml` twice and never provided
 * it, so the documented first run was a guaranteed ENOENT. The spec is now
 * inlined as a heredoc — and inlining it is only worth anything if something
 * proves the inlined bytes actually produce the tools the README then claims.
 * That is what this extracts, and the test below mounts it for real.
 */
function inlinedSpec(): string {
  const readme = readFileSync(README_PATH, 'utf8');
  const open = readme.indexOf(SPEC_HEREDOC_OPEN);
  if (open === -1) {
    throw new Error(
      `README.md no longer writes the quick-start spec with ${JSON.stringify(SPEC_HEREDOC_OPEN)}. ` +
        'If the reader now obtains the spec another way, update this guard in the same change — ' +
        'but do NOT delete it: #719 is the quick start referencing a file it never provided.',
    );
  }
  const bodyStart = readme.indexOf('\n', open) + 1;
  const end = readme.indexOf('\nYAML', bodyStart);
  if (end === -1) {
    throw new Error('README.md quick-start spec heredoc is not terminated by YAML.');
  }
  return readme.slice(bodyStart, end);
}

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
  // The SHAPE of the documented command — POST, the /mcp endpoint, a
  // well-formed JSON-RPC body — is asserted by check-doc-surfaces.mjs, which
  // runs on every PR rather than only this package's (#734). What is left here
  // is the part that needs a server: that the documented command actually
  // WORKS, which no amount of reading the text can establish.
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

describe('the quick start can be followed from a cold start (#719)', () => {
  it('provides the spec it tells the reader to use, and it really serves those tools', async () => {
    // Written to a scratch dir, so this mounts the README's OWN bytes rather
    // than the checked-in example a newcomer does not have.
    const dir = mkdtempSync(join(tmpdir(), 'askturret-quickstart-'));
    const specPath = join(dir, 'petstore.yaml');
    writeFileSync(specPath, inlinedSpec(), 'utf8');

    const coldApp = express();
    coldApp.use('/mcp', mcpFromOpenApi(specPath));

    const response = await request(coldApp)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(response.status).toBe(200);
    const names = (response.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    // Exactly what the README's `Returns:` block advertises immediately below.
    expect(names).toContain('listPets');
    expect(names).toContain('getPetById');
  });

  // The `servers:` entry, the server snippet's EADDRINUSE handling, and the
  // repo-wide sweeps for the port-7000 and URL-path forms are all pure text, so
  // they are asserted by check-doc-surfaces.mjs on every PR (#734). Only the
  // mounting assertion above needs to be here.
});
