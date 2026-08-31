#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the CODEOWNERS guard (#58).
 *
 * The guard exists because a wrong CODEOWNERS rule fails silently — it routes
 * nothing while looking like coverage. A guard that itself matched wrongly
 * would be the same failure one level up, so the matcher is exercised against
 * the cases that actually occur in this repository, including the near-misses
 * that would make it cry wolf.
 *
 * Run: node .github/scripts/check-codeowners.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { check, matches, parseCodeowners } from './check-codeowners.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check_(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed++;
  }
}

/** A throwaway repo with the given CODEOWNERS text and package directories. */
function scratch(codeowners, packages = ['core']) {
  const dir = mkdtempSync(join(tmpdir(), 'codeowners-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.github'), { recursive: true });
  writeFileSync(join(dir, '.github', 'CODEOWNERS'), codeowners);
  for (const name of packages) {
    mkdirSync(join(dir, 'packages', name, 'src'), { recursive: true });
    writeFileSync(join(dir, 'packages', name, 'src', 'index.ts'), '// x\n');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

console.log('\n# pattern matching\n');

check_('an anchored directory rule matches a file inside it', matches('/packages/core/', 'packages/core/src/index.ts'), true);
check_('...and the directory itself', matches('/packages/core/', 'packages/core/'), true);
check_('...and does not match a sibling with a shared prefix', matches('/packages/core/', 'packages/core-extra/src/x.ts'), false);
check_('an anchored file rule matches exactly', matches('/LICENSE', 'LICENSE'), true);
check_('...and not the same name nested', matches('/LICENSE', 'packages/core/LICENSE'), false);
check_('an unanchored rule matches at any depth', matches('docs/', 'packages/core/docs/x.md'), true);
check_('a `*` wildcard stays inside one segment', matches('/packages/adapters-*/', 'packages/adapters-express/src/x.ts'), true);
check_('...so it does not leak across a slash', matches('/packages/*/', 'packages/core/src/x.ts'), true);
check_('a dot in a pattern is literal, not "any character"', matches('/.gitattributes', 'xgitattributes'), false);

{
  // The matcher refuses `**` rather than approximating it. A half-correct
  // implementation would be a second set of matching rules free to disagree
  // with GitHub's, which is the thing this guard exists to detect.
  let threw = false;
  try { matches('/packages/**/src/', 'packages/core/src/'); } catch { threw = true; }
  check_('refuses `**` instead of guessing at it', threw, true);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

console.log('\n# parsing\n');

{
  const rules = parseCodeowners('# a comment\n\n/packages/core/  @a @b  # trailing\n*  @c\n');
  check_('drops comments and blank lines', rules.length, 2);
  check_('keeps multiple owners', rules[0].owners.length, 2);
  check_('strips a trailing comment from the owner list', rules[0].owners.includes('#'), false);
  check_('records the line number for the error message', rules[0].line, 3);
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

console.log('\n# guard behaviour\n');

check_(
  'passes on a file where every rule matches something',
  check(scratch('* @founder\n/packages/core/ @founder\n')).code,
  0,
);

{
  // The exact typo this guard is for. §12.4 writes the boundary as
  // `sources/openapi/`, and the directory is `sources-openapi` — a rule copied
  // from the spec matches nothing and routes nobody.
  const dir = scratch('* @founder\n/packages/sources/openapi/ @founder\n', ['sources-openapi']);
  const result = check(dir);

  check_('FAILS on a pattern that matches no path', result.code, 1);
  check_('and quotes the dead pattern', result.message.includes('/packages/sources/openapi/'), true);
  check_('and says what the consequence is', result.message.includes('routes nothing'), true);
}

{
  const dir = scratch('* @founder\n/packages/core/ @founder\n', ['core', 'newpkg']);
  const result = check(dir);

  check_('FAILS when a package has no rule of its own', result.code, 1);
  check_('and names the package', result.message.includes('packages/newpkg/'), true);
}

check_(
  'FAILS when there is no catch-all',
  check(scratch('/packages/core/ @founder\n')).code,
  1,
);

check_(
  'FAILS when the file is missing entirely',
  check(mkdtempSync(join(tmpdir(), 'codeowners-none-'))).code,
  1,
);

check_(
  'FAILS on a file with only comments',
  check(scratch('# nothing but a comment\n')).code,
  1,
);

{
  // The permission half is genuinely uncheckable, and the guard must say so
  // rather than let a green result imply more than it verified.
  const result = check(scratch('* @founder\n/packages/sources/openapi/ @founder\n', ['sources-openapi']));
  check_('failure output states it cannot verify write access', result.message.includes('WRITE ACCESS'), true);
}

// ---------------------------------------------------------------------------
// The real repository
// ---------------------------------------------------------------------------

console.log('\n# this repository\n');

check_('the repository has a CODEOWNERS', existsSync(join(repoRoot, '.github/CODEOWNERS')), true);
check_('and it passes the guard', check(repoRoot).code, 0);

{
  const text = readFileSync(join(repoRoot, '.github/CODEOWNERS'), 'utf-8');
  const rules = parseCodeowners(text);

  // Last-match-wins is the CODEOWNERS footgun: a catch-all placed at the BOTTOM
  // silently overrides every specific rule above it, and the file still looks
  // correct to a reader who expects most-specific-wins.
  check_('the catch-all is the FIRST rule, so specific rules override it', rules[0].pattern, '*');
  check_('and it is the only catch-all', rules.filter((r) => r.pattern === '*').length, 1);

  // §12.4's boundaries, each of which must be present as an owned area.
  for (const area of [
    '/packages/core/',
    '/packages/transports/',
    '/packages/sources-openapi/',
    '/packages/adapters-express/',
    '/packages/adapters-fastify/',
    '/packages/explorer/',
    '/packages/observability/',
    '/examples/',
  ]) {
    check_(`§12.4 boundary present: ${area}`, rules.some((r) => r.pattern === area), true);
  }

  // Separation of duties: the conformance bank must not be swept up by an
  // adapters rule. Asserted so a later "tidy-up" that merged them is caught.
  check_(
    'the conformance bank is owned separately from adapters',
    rules.some((r) => r.pattern === '/packages/adapter-conformance/'),
    true,
  );
}

{
  const doc = join(repoRoot, 'docs/ownership.md');
  check_('docs/ownership.md exists', existsSync(doc), true);

  const text = existsSync(doc) ? readFileSync(doc, 'utf-8') : '';
  // The two-part adapter review rule is the one thing in #58 that CODEOWNERS
  // cannot express, so the document is the only place it can live.
  check_('it states the adapter conformance requirement', /conformance-kit run/.test(text), true);
  check_('it explains how to become a maintainer', /Becoming a maintainer/.test(text), true);
  check_(
    'it warns that an owner without write access is silently ignored',
    /silently ignored/.test(text),
    true,
  );
}

{
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
  // #58's acceptance: "README links to both."
  check_('README links to docs/ownership.md', readme.includes('docs/ownership.md'), true);
  check_('README links to .github/CODEOWNERS', readme.includes('.github/CODEOWNERS'), true);
}

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// The owner-set cardinality note (#330)
//
// A NOTE, never a failure: nothing in the repository can remedy a single-owner
// set, so failing would be a permanent red nobody can clear — which is how an
// alarm becomes something people route around.
//
// The property that makes it worth having is that it is SELF-CLEARING, and that
// is asserted here rather than promised in a comment. #330 exists because a
// status word went stale without anyone touching the file; a sentence that
// recomputes itself every run cannot.
// ---------------------------------------------------------------------------

console.log('\n# the sole-owner note (#330)\n');

{
  const sole = check(scratch('*  @solo\npackages/core/  @solo\n'));
  check_('sole owner: the note is emitted', /name a single owner \(@solo\)/.test(sole.message), true);
  check_('sole owner: ...and it is a NOTE, not a failure', sole.code, 0);
  check_(
    'sole owner: ...and it states the consequence rather than a status',
    /routes to\nno reviewer/.test(sole.message),
    true,
  );
  check_(
    'sole owner: ...and it does not claim to cover the bypass half',
    /only self-authorship/.test(sole.message),
    true,
  );

  // THE SELF-CLEARING PROPERTY. This is the whole argument for the check being
  // worth having, so it is witnessed rather than asserted in prose: add a
  // second distinct owner and the note goes away with nobody deleting it.
  const two = check(scratch('*  @solo\npackages/core/  @second\n'));
  check_('two owners: the note clears itself', /name a single owner/.test(two.message), false);
  check_('two owners: ...and the guard still passes', two.code, 0);

  // A rule naming two owners on one line is also not a sole-owner set.
  const shared = check(scratch('*  @solo @second\npackages/core/  @solo\n'));
  check_('a shared rule counts as two owners', /name a single owner/.test(shared.message), false);
}

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// THE ENTRY POINT ITSELF (#560, D3)
//
// `process.exit(result.code)` was unwitnessed because this file only ever calls
// `check()` directly — so the line that turns a result into an EXIT STATUS
// never executed. That is #110's shape: the exported function had thorough
// coverage while the thing CI actually runs had none.
//
// Both directions, because neutralising this exit makes every run report 0:
// without the passing case the assertion could be satisfied by a guard that
// exits non-zero unconditionally.
// ---------------------------------------------------------------------------
{
  const SCRIPT = join(here, 'check-codeowners.mjs');
  const runIt = (dir) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf-8' });

  const bad = scratch('* @founder\n/packages/sources/openapi/ @founder\n', ['sources-openapi']);
  check_('entry: a failing repo exits NON-ZERO through the entry point', runIt(bad).status, 1);

  const good = scratch('* @founder\n/packages/core/ @founder\n', ['core']);
  check_('entry: CONTROL — a passing repo exits 0', runIt(good).status, 0);
}

console.log(`\n${String(passed)} passed, ${String(failed)} failed\n`);
process.exit(failed === 0 ? 0 : 1);
