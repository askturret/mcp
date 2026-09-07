#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The quick start's DOCUMENTED surfaces, checked in a lane that doc-only pull
 * requests actually schedule (#734).
 *
 * ## The defect this closes is WHERE a guard ran, not what it asserted
 *
 * PR #732 shipped `readme-quickstart.test.ts`, and it is a good guard: it
 * PARSES the command out of `README.md` instead of transcribing it, so the
 * README cannot drift away from it (#710). Nothing about its assertions was
 * wrong.
 *
 * It lives under `packages/adapters-express`, so it ran only when that
 * package's path filter matched — and no filter in `test.yml` matched the
 * repo-root `README.md` or `docs/**`. **The exact change it guards against, a
 * doc-only edit, scheduled it not at all.**
 *
 * MEASURED on the commit the issue cites, rather than reasoned from the filter
 * block. Commit `8600c2a` (PR #632) touched exactly `README.md` and
 * `docs/readiness.md`:
 *
 *   test-adapters-express   skipped      <- the guard did not run
 *   ...all 12 package suites skipped
 *   test-integrity          success      <- this job did
 *
 * That is the whole reason this file exists and the whole reason it is wired
 * into `test-integrity`: that job carries no path filter and `needs:` nothing,
 * so it runs on every non-dependabot pull request whatever the diff touches.
 * The destination was chosen from that check-run evidence, not from reading
 * the workflow and believing it.
 *
 * ## Why these assertions MOVED rather than being copied
 *
 * A second copy of "the README documents a POST" that can disagree with the
 * first is the drift class this repository keeps filing issues about. So the
 * text assertions were REMOVED from `readme-quickstart.test.ts` in the same
 * change. There is exactly one copy of each, and it is here.
 *
 * The split is along a real seam — cost:
 *
 *   - Everything here reads FILES. Builtins only, no install, milliseconds.
 *   - What stayed behind MOUNTS THE ADAPTER, which needs four workspace
 *     packages built before it can run at all.
 *
 * So the free assertions now run on every pull request, and the expensive ones
 * still run where the adapter can actually change. Coverage strictly INCREASES:
 * these seven previously ran only when `adapters-express` was scheduled.
 *
 * ## The one new failure mode the split creates, and its guard
 *
 * Both files anchor on the same README prose markers. Reword the README, update
 * this file's constant, forget the test's, and the test throws — loudly, but
 * only later, on the next pull request that happens to schedule it.
 *
 * Check G closes that: it asserts the surviving test file carries the same
 * marker literals this guard does. The two cannot drift apart silently, and the
 * check costs one `readFileSync`.
 *
 * Usage:
 *   node .github/scripts/check-doc-surfaces.mjs [rootDir]
 *
 * Exit codes:
 *   0  every documented surface holds
 *   1  a violation, or a structural anchor the guard depends on is gone
 *   2  cannot check (the documents themselves are missing)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { isProcessEntryPoint } from './lib/entry-point.mjs';

const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_CANNOT_CHECK = 2;

/**
 * The prose markers the quick start's blocks sit under.
 *
 * Anchored on prose rather than line numbers so ordinary edits above them do
 * not break the parse. Check G asserts the jest test still agrees with these.
 */
export const PROOF_MARKER = 'Your API now exposes tools over MCP';
export const SPEC_HEREDOC_OPEN = "cat > petstore.yaml <<'YAML'";
export const SERVER_MARKER = 'Save this as `server.mjs`';

/** The test file that keeps the server-mounting half of this guard. */
const SERVER_TEST = 'packages/adapters-express/src/__tests__/readme-quickstart.test.ts';

/** Directories that are never ours to police. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'build']);

/** Every markdown file that is ours — build output and vendored code excluded. */
export function markdownFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) found.push(full);
    }
  };
  walk(root);
  return found;
}

/**
 * The fenced block holding the quick start's proof command.
 *
 * Returns null when the marker is gone, so the caller can report that as the
 * structural failure it is rather than as a passing check over empty text.
 */
export function proofBlock(readme) {
  const markerAt = readme.indexOf(PROOF_MARKER);
  if (markerAt === -1) return null;
  const fenceEnd = readme.indexOf('```', markerAt);
  if (fenceEnd === -1) return null;
  return readme.slice(markerAt, fenceEnd);
}

/** The OpenAPI document the quick start tells the reader to write (#719). */
export function inlinedSpec(readme) {
  const open = readme.indexOf(SPEC_HEREDOC_OPEN);
  if (open === -1) return null;
  const bodyStart = readme.indexOf('\n', open) + 1;
  const end = readme.indexOf('\nYAML', bodyStart);
  if (end === -1) return null;
  return readme.slice(bodyStart, end);
}

/** The fenced javascript block holding the quick start's server file (#719). */
export function serverSnippet(readme) {
  const markerAt = readme.indexOf(SERVER_MARKER);
  if (markerAt === -1) return null;
  const fenceStart = readme.indexOf('```javascript', markerAt);
  if (fenceStart === -1) return null;
  const fenceEnd = readme.indexOf('```', fenceStart + 3);
  if (fenceEnd === -1) return null;
  return readme.slice(fenceStart, fenceEnd);
}

/**
 * The JSON-RPC request body the README tells the reader to send.
 *
 * Returns undefined when the documented command carries no `-d` payload —
 * which is precisely the pre-#716 GET form, and what makes this red on revert.
 */
export function documentedRequestBody(block) {
  const match = block.match(/-d\s+'([^']*)'/);
  if (match === null) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

export function check(root) {
  const violations = [];
  const readmePath = resolve(root, 'README.md');

  if (!existsSync(readmePath)) {
    return { code: EXIT_CANNOT_CHECK, violations: [`${readmePath} does not exist`] };
  }
  const readme = readFileSync(readmePath, 'utf8');

  // A + B: the headline proof command (#716, #103).
  const proof = proofBlock(readme);
  if (proof === null) {
    violations.push(
      `README.md no longer contains the quick-start proof marker ${JSON.stringify(PROOF_MARKER)} ` +
        'followed by a closed fence. If the marker was reworded, update PROOF_MARKER in ' +
        '.github/scripts/check-doc-surfaces.mjs in the SAME change — do not delete this check.',
    );
  } else {
    if (!proof.includes('-X POST')) {
      violations.push("the README's proof command does not POST — MCP speaks JSON-RPC over POST (#716)");
    }
    if (!proof.includes('/mcp')) {
      violations.push("the README's proof command does not name the mounted /mcp endpoint");
    }
    // The defect itself: a METHOD NAME presented as a URL path segment.
    if (proof.includes('/mcp/tools/list')) {
      violations.push(
        "the README's proof command documents `/mcp/tools/list` as a URL path — " +
          'that 404s. `tools/list` is a JSON-RPC method name (#716)',
      );
    }
    const body = documentedRequestBody(proof);
    if (body === undefined) {
      violations.push("the README's proof command carries no parseable -d JSON payload (the pre-#716 GET form)");
    } else {
      if (body.jsonrpc !== '2.0') violations.push("the README's documented body is not jsonrpc 2.0");
      if (body.method !== 'tools/list') violations.push("the README's documented body does not call tools/list");
    }
  }

  // C: the quick start provides the spec it tells the reader to use (#719).
  const spec = inlinedSpec(readme);
  if (spec === null) {
    violations.push(
      `README.md no longer writes the quick-start spec with ${JSON.stringify(SPEC_HEREDOC_OPEN)}. ` +
        'If the reader now obtains it another way, update SPEC_HEREDOC_OPEN in the same change — ' +
        'but do NOT delete this check: #719 is the quick start referencing a file it never provided.',
    );
  } else if (!spec.includes('servers:')) {
    // Without this the runtime logs "Could not resolve an upstream base URL"
    // and every tools/call fails.
    violations.push("the README's inlined spec declares no `servers:` entry, so tools/call cannot resolve an upstream (#719)");
  }

  // D: the documented server names a port collision instead of throwing (#719).
  const snippet = serverSnippet(readme);
  if (snippet === null) {
    violations.push(
      `README.md no longer contains the quick-start server marker ${JSON.stringify(SERVER_MARKER)} ` +
        'followed by a closed javascript fence. If it was reworded, update SERVER_MARKER in the same change.',
    );
  } else {
    if (!snippet.includes('EADDRINUSE')) {
      violations.push("the README's server snippet does not handle EADDRINUSE — a bare listen prints a raw stack trace on the reader's FIRST command (#719)");
    }
    if (!snippet.includes("server.on('error'")) {
      violations.push("the README's server snippet does not attach its own 'error' listener");
    }
    if (!snippet.includes('process.env.PORT')) {
      violations.push("the README's server snippet offers no PORT override");
    }
    // express 5's `app.listen(port, cb)` does `server.once('error', cb)`, so a
    // callback that logs "listening" prints on a FAILED bind too — measured on
    // express 5.2.1.
    if (/app\.listen\([^)]*,\s*\(/.test(snippet)) {
      violations.push(
        "the README's server snippet logs from the listen callback — express 5 also calls it on a FAILED bind, " +
          'so that prints success for a port collision (#719)',
      );
    }
  }

  // E + F: repo-wide sweeps. These are why the guard's subject is EVERY
  // markdown file rather than README.md alone — a fact no path filter in
  // test.yml expressed, and the reason this belongs in an unfiltered lane.
  const port7000 = [];
  const urlPathForm = [];
  for (const file of markdownFiles(root)) {
    const text = readFileSync(file, 'utf8');
    const rel = file.slice(root.length + 1);
    // The runnable forms only. Prose ABOUT port 7000 is legitimate and is
    // exactly what the README now uses to explain why the default moved.
    if (text.includes('localhost:7000') || text.includes('--port 7000') || text.includes('port: 7000')) {
      port7000.push(rel);
    }
    // The URL-path form specifically. A bare `tools/list` is the legitimate
    // JSON-RPC method name and appears throughout the docs on purpose.
    if (text.includes('/mcp/tools/list') || text.includes('/mcp/tools/call')) {
      urlPathForm.push(rel);
    }
  }
  if (port7000.length > 0) {
    violations.push(`doc surface documents a demo server on macOS-occupied port 7000 (#719): ${port7000.join(', ')}`);
  }
  if (urlPathForm.length > 0) {
    violations.push(`doc surface presents an MCP method as a URL path (#716, #103): ${urlPathForm.join(', ')}`);
  }

  // G: the split's own drift guard. See the header.
  const testPath = resolve(root, SERVER_TEST);
  if (!existsSync(testPath)) {
    violations.push(
      `${SERVER_TEST} is gone. It holds the server-mounting half of this guard — the assertions that ` +
        'need a real adapter. Removing it silently drops them; if the move was deliberate, update ' +
        'SERVER_TEST here in the same change.',
    );
  } else {
    const testText = readFileSync(testPath, 'utf8');
    // Only the markers BOTH files parse. `SERVER_MARKER` is deliberately absent:
    // the server snippet is pure text, so all of its assertions moved here and
    // the test has no reason to anchor on it. Asserting a marker the test does
    // not use would be a guard demanding dead code.
    for (const [name, marker] of [
      ['PROOF_MARKER', PROOF_MARKER],
      ['SPEC_HEREDOC_OPEN', SPEC_HEREDOC_OPEN],
    ]) {
      if (!testText.includes(marker)) {
        violations.push(
          `${SERVER_TEST} no longer anchors on ${name}. Both files parse the same README, so a marker ` +
            'reworded in one and not the other leaves the test throwing on some later pull request. ' +
            'Update both in the same change.',
        );
      }
    }
  }

  return { code: violations.length > 0 ? EXIT_VIOLATION : EXIT_OK, violations };
}

export function main(argv) {
  const root = resolve(argv[2] ?? '.');
  const { code, violations } = check(root);

  if (code === EXIT_CANNOT_CHECK) {
    console.error('check-doc-surfaces: CANNOT CHECK');
    for (const v of violations) console.error(`  - ${v}`);
    return EXIT_CANNOT_CHECK;
  }
  if (code === EXIT_VIOLATION) {
    console.error('check-doc-surfaces: FAILED');
    for (const v of violations) console.error(`  - ${v}`);
    return EXIT_VIOLATION;
  }
  console.log('check-doc-surfaces: OK — the documented quick-start surfaces hold.');
  return EXIT_OK;
}

if (isProcessEntryPoint(import.meta.url)) {
  process.exit(main(process.argv));
}
