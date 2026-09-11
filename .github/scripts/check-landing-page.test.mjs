#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the landing-page guard (#860).
 *
 * EVERY CHECK IS WITNESSED FIRING, not merely passing. A guard asserted only in
 * its green state is one nobody has proven can go red — the vacuous-block class
 * this repository found in `doctor.test.ts` during #762, where a describe block
 * named for the policy survived that policy being INVERTED.
 *
 * So each fixture below comes in a pair: a tree the guard must accept, and the
 * same tree with one thing wrong that it must reject. The reasons are asserted
 * too, because a guard that fails for the wrong reason is a guard that will pass
 * for the wrong reason later.
 *
 * AND AGAINST THE REAL TREE at the end, through the real entry point in a
 * subprocess. An injected call cannot witness `process.exit`, and that line is
 * what CI actually depends on.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  checkLandingPage,
  commandLines,
  extractPreBlocks,
  findForbiddenClaims,
  visibleText,
  decodeEntities,
} from './check-landing-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'check-landing-page.mjs');
const REPO_ROOT = resolve(HERE, '..', '..');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed += 1;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed += 1;
  }
}

/** Build a throwaway repo: a page, a README and a core manifest. */
function fixture({ page, readme = '', version = '9.9.9' }) {
  const dir = mkdtempSync(join(tmpdir(), 'landing-guard-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'site'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
  writeFileSync(join(dir, 'site', 'index.html'), page);
  writeFileSync(join(dir, 'README.md'), readme);
  writeFileSync(join(dir, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@askturret/mcp-core', version }));
  return dir;
}

const OK_PAGE = `<html><body>
<pre><code>npm install express @askturret/mcp-adapters-express</code></pre>
</body></html>`;
const OK_README = 'Some prose\n\n```bash\nnpm install express @askturret/mcp-adapters-express\n```\n';

// ---------------------------------------------------------------------------
// The extractor. Hand-rolled, so the shapes it must handle are pinned.
// ---------------------------------------------------------------------------
{
  check('extracts a plain <pre>', extractPreBlocks('<pre>a</pre>').length, 1);
  check('strips the inner <code> wrapper', extractPreBlocks('<pre><code>a</code></pre>')[0].text, 'a');
  check('extracts several blocks', extractPreBlocks('<pre>a</pre><pre>b</pre>').length, 2);

  const declared = extractPreBlocks('<pre data-page-only="a stated reason"><code>x</code></pre>')[0];
  check('reads a data-page-only reason', declared.pageOnlyReason, 'a stated reason');

  // An empty reason is NOT a declaration. This is the hole a lazy escape would
  // open: `data-page-only=""` would otherwise silence check A with no argument.
  const empty = extractPreBlocks('<pre data-page-only=""><code>x</code></pre>')[0];
  check('an EMPTY data-page-only is not a reason', empty.pageOnlyReason, null);
  check('...and is recorded as a declared-empty defect', empty.declaredEmpty, true);

  check('decodes entities', decodeEntities('a &amp;&lt;b&gt; &quot;c&quot; &#39;d&#39;'), 'a &<b> "c" \'d\'');
}

// ---------------------------------------------------------------------------
// Command-line selection. Comments are prose and may differ; commands may not.
// ---------------------------------------------------------------------------
{
  check('drops blank lines', commandLines('a\n\n b \n').length, 2);
  check('drops shell comments', commandLines('# a comment\nreal command').length, 1);
  check('drops js comments', commandLines('// a comment\nreal command').length, 1);
  check('keeps the command itself', commandLines('# c\n npm install x ')[0], 'npm install x');
}

// ---------------------------------------------------------------------------
// CHECK A — drift from the README.
// ---------------------------------------------------------------------------
{
  const ok = checkLandingPage(fixture({ page: OK_PAGE, readme: OK_README }));
  check('a matching command passes', ok.problems.length, 0);
  check('...and reports what it compared', ok.comparedLines, 1);

  // THE INVERSION: the same page against a README that does not carry the line.
  const drifted = checkLandingPage(fixture({ page: OK_PAGE, readme: 'nothing relevant here' }));
  check('a command absent from the README fails', drifted.problems.length, 1);
  check('...and names the offending command', /npm install express/.test(drifted.problems[0]), true);

  // A one-character change is drift. This is the case the guard exists for:
  // the README is corrected and the page silently is not.
  const oneChar = checkLandingPage(
    fixture({ page: OK_PAGE, readme: OK_README.replace('mcp-adapters-express', 'mcp-adapters-fastify') }),
  );
  check('a one-token divergence fails', oneChar.problems.length, 1);

  // The declared escape works...
  const declared = checkLandingPage(
    fixture({
      page: '<pre data-page-only="no README equivalent, and here is why"><code>some-page-only-command</code></pre>',
      readme: 'unrelated',
    }),
  );
  check('a declared page-only block is exempt', declared.problems.length, 0);
  check('...and is excluded from the compared count', declared.comparedBlocks, 0);

  // ...but cannot be claimed without a reason.
  const empty = checkLandingPage(
    fixture({ page: '<pre data-page-only=""><code>some-page-only-command</code></pre>', readme: 'unrelated' }),
  );
  check('an empty declaration is rejected', empty.problems.length, 1);
  check('...for being a reasonless declaration', /EMPTY reason/.test(empty.problems[0]), true);
}

// ---------------------------------------------------------------------------
// CHECK B — unsourceable claims. Each phrase witnessed firing.
// ---------------------------------------------------------------------------
{
  check('clean prose passes', findForbiddenClaims('Serve your OpenAPI spec over MCP.').length, 0);

  for (const [label, text] of [
    ['trusted by', 'Trusted by leading teams'],
    ['used by', 'Used by thousands of teams'],
    ['an adoption count', 'Over 5,000 developers'],
    ['production-ready', 'A production-ready MCP layer'],
    ['production-grade', 'Add a production-grade MCP layer'],
    ['battle-tested', 'Battle-tested in the field'],
    ['enterprise-grade', 'Enterprise-grade governance'],
    ['benchmarks', 'See our benchmarks'],
    ['blazing fast', 'Blazing fast tool dispatch'],
    ['Nx faster', '3x faster than the alternative'],
    ['high-performance', 'A high-performance gateway'],
    ['low-latency', 'Low-latency dispatch'],
    ['zero-overhead', 'Zero-overhead middleware'],
    ['in production at', 'Running in production at scale-ups'],
  ]) {
    check(`rejects "${label}"`, findForbiddenClaims(text).length > 0, true);
  }

  // NON-VACUITY, and the reason this matters: a bare-word list would fire on
  // ordinary prose and would then be loosened until it caught nothing.
  check('allows the ordinary word "user"', findForbiddenClaims('what the user sees').length, 0);
  check('allows "fast" in ordinary prose', findForbiddenClaims('a fast path to MCP').length, 0);
  check('allows the word "production" alone', findForbiddenClaims('the production branch').length, 0);

  // Claims hidden in markup or comments must still be caught / not caught
  // respectively — the visitor reads the text, not the tags.
  check('reads through tags', findForbiddenClaims(visibleText('<p>Trusted by <b>many</b></p>')).length > 0, true);
  check('ignores HTML comments', findForbiddenClaims(visibleText('<!-- trusted by nobody -->')).length, 0);
  check('ignores <style> contents', findForbiddenClaims(visibleText('<style>.benchmark{}</style>')).length, 0);

  const claimed = checkLandingPage(
    fixture({ page: '<html><body><p>Trusted by leading teams</p>' + OK_PAGE + '</body></html>', readme: OK_README }),
  );
  check('the guard rejects a claim end to end', claimed.problems.length, 1);
}

// ---------------------------------------------------------------------------
// CHECK C — a pinned core version must track the manifest.
// ---------------------------------------------------------------------------
{
  const agreeing = checkLandingPage(
    fixture({
      page: OK_PAGE + '<pre data-page-only="verification"><code>npm view @askturret/mcp-core@1.2.3 dist.attestations</code></pre>',
      readme: OK_README,
      version: '1.2.3',
    }),
  );
  check('a pin equal to the manifest passes', agreeing.problems.length, 0);
  check('...and is counted', agreeing.pins, 1);

  const stale = checkLandingPage(
    fixture({
      page: OK_PAGE + '<pre data-page-only="verification"><code>npm view @askturret/mcp-core@1.2.3 dist.attestations</code></pre>',
      readme: OK_README,
      version: '2.0.0',
    }),
  );
  check('a stale pin fails', stale.problems.length, 1);
  check('...and names both versions', /1\.2\.3.*2\.0\.0/s.test(stale.problems[0]), true);

  // The pin check reads the block even though it is page-only: the declaration
  // exempts it from the README comparison, NOT from version truth.
  check('a page-only block is still version-checked', stale.comparedBlocks, 1);
}

// ---------------------------------------------------------------------------
// CANNOT CHECK is distinct from a pass. Nothing here may succeed by not looking.
// ---------------------------------------------------------------------------
{
  const noPage = mkdtempSync(join(tmpdir(), 'landing-guard-'));
  tmpDirs.push(noPage);
  const r1 = checkLandingPage(noPage);
  check('a missing page cannot-checks', typeof r1.cannotCheck === 'string', true);
  check('...rather than passing', r1.problems.length, 0);

  const badManifest = fixture({ page: OK_PAGE, readme: OK_README });
  writeFileSync(join(badManifest, 'packages', 'core', 'package.json'), '{ not json');
  check('an unparseable manifest cannot-checks', typeof checkLandingPage(badManifest).cannotCheck === 'string', true);

  const noBlocks = fixture({ page: '<html><body><p>no code here</p></body></html>', readme: OK_README });
  check('a page with no <pre> cannot-checks', typeof checkLandingPage(noBlocks).cannotCheck === 'string', true);
}

// ---------------------------------------------------------------------------
// THE REAL TREE, through the real entry point in a subprocess.
// ---------------------------------------------------------------------------
{
  const real = checkLandingPage(REPO_ROOT);
  check('the real page passes its own guard', real.cannotCheck === null && real.problems.length === 0, true);
  check('...having actually compared something', real.comparedLines > 0, true);

  const r = spawnSync(process.execPath, [GUARD, REPO_ROOT], { encoding: 'utf-8' });
  check('the guard exits 0 through its real entry point', r.status, 0);
  check('...and says what it compared', /command line\(s\)/.test(`${r.stdout}${r.stderr}`), true);
}

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
