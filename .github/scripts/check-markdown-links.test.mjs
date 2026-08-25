#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the markdown link guard (#188).
 *
 * The guard exists because a broken link fails silently — the diff shows a
 * plausible path and nobody leaves the diff to check it. A guard that itself
 * matched wrongly would be the same failure one level up, so this exercises
 * both directions: the breaks it must catch, and the near-misses that would
 * make it cry wolf and get it switched off.
 *
 * Every "does NOT flag" case below is paired with a case proving the guard
 * would have flagged the same target in a position where it IS a link. A
 * false-positive test on its own cannot tell "correctly ignored" apart from
 * "never looked".
 *
 * Run: node .github/scripts/check-markdown-links.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-markdown-links.mjs');
const repoRoot = resolve(here, '../..');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed++;
  }
}

/**
 * A throwaway tree. `files` maps repo-relative path -> contents.
 *
 * The guard is run as a SUBPROCESS against the real script, not by importing
 * its internals: the thing under test is "does the check fail the build", and
 * an in-process unit test of a matcher would pass while the entry point never
 * ran — the exact defect #128/#184 record.
 */
function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mdlinks-'));
  tmpDirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

function run(dir) {
  const r = spawnSync('node', [GUARD, dir], { encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ---------------------------------------------------------------------------
// The core claim: a link to a file that is not there fails the build.
// ---------------------------------------------------------------------------

check(
  'flags a relative link whose target does not exist',
  run(scratch({ 'a.md': 'See [the guide](docs/nope.md).' })).code,
  1,
);

check(
  'accepts a relative link whose target exists',
  run(scratch({ 'a.md': 'See [the guide](docs/real.md).', 'docs/real.md': '# Real' })).code,
  0,
);

check(
  'flags a broken image, which is the same syntax',
  run(scratch({ 'a.md': '![diagram](img/missing.png)' })).code,
  1,
);

{
  const r = run(scratch({ 'a.md': 'See [the guide](docs/nope.md).' }));
  check('names the file, line and target', /a\.md:1 — link -> docs\/nope\.md/.test(r.out), true);
}

// ---------------------------------------------------------------------------
// Fenced blocks. The pair below is the whole point: the SAME target must be
// ignored inside a fence and caught outside one.
// ---------------------------------------------------------------------------

check(
  'does NOT flag a link inside a fenced block',
  run(scratch({ 'a.md': '```markdown\n[Code of Conduct](CODE_OF_CONDUCT.md)\n```\n' })).code,
  0,
);

check(
  'DOES flag that same link outside a fence',
  run(scratch({ 'a.md': '[Code of Conduct](CODE_OF_CONDUCT.md)\n' })).code,
  1,
);

// The real construct from docs/GITHUB_METADATA_CHECKLIST.md: template content
// for a ROOT-level CONTRIBUTING.md, where the link is correct for the root it
// describes. #187 nearly "fixed" it to ../CODE_OF_CONDUCT.md, which would have
// pointed outside the repository.
check(
  'does NOT flag template content in a ```markdown fence',
  run(
    scratch({
      'docs/x.md': '## Template\n\n```markdown\n# Contributing\n\nSee [CoC](CODE_OF_CONDUCT.md).\n```\n\nDone.\n',
      'CODE_OF_CONDUCT.md': '# CoC',
    }),
  ).code,
  0,
);

// The real construct from docs/adr/ADR-021: TypeScript that parses as markdown
// link syntax under a loose regex.
check(
  'does NOT flag TypeScript that looks like a link',
  run(scratch({ 'a.md': '```ts\nlogger[level](message, (meta ?? {}) as LogFields);\n```\n' })).code,
  0,
);

// A ```` fence may contain ``` as content. A naive toggle closes early here and
// would then read the following line as prose.
check(
  'handles a longer fence containing a shorter one',
  run(scratch({ 'a.md': '````markdown\n```\n[x](nope.md)\n```\n````\n' })).code,
  0,
);

check(
  'treats ~~~ as a fence too',
  run(scratch({ 'a.md': '~~~\n[x](nope.md)\n~~~\n' })).code,
  0,
);

check(
  'does NOT flag link syntax inside an inline code span',
  run(scratch({ 'a.md': 'Write it as `[text](docs/nope.md)` in the file.\n' })).code,
  0,
);

// ---------------------------------------------------------------------------
// Unbalanced fence: under-scanning must not read as success.
// ---------------------------------------------------------------------------

{
  const r = run(scratch({ 'a.md': 'intro\n\n```markdown\n[x](nope.md)\n' }));
  check('FAILS on a file that ends inside an unclosed fence', r.code, 1);
  check(
    '...and says the scan narrowed rather than passing quietly',
    /unbalanced code fence/.test(r.out),
    true,
  );
}

// ---------------------------------------------------------------------------
// Out of scope, stated rather than silently dropped.
// ---------------------------------------------------------------------------

check(
  'does NOT flag external URLs',
  run(scratch({ 'a.md': '[site](https://example.com/x.md) [mail](mailto:a@b.c)' })).code,
  0,
);

// The three expectations below were written for #188, which deferred anchor
// validation and pinned the deferral so it could not be forgotten. #232 is the
// deliberate edit those pins were waiting for, so they are FLIPPED rather than
// deleted — removing them would lose the record that anchors were once unchecked,
// and the anchor cases further down would be the only trace.

check(
  'a bare anchor is now resolved against the file it sits in',
  run(scratch({ 'a.md': '# Introduction\n\n[top](#introduction)' })).code,
  0,
);

check(
  'a fragment on an existing file is now checked, not discarded',
  run(scratch({ 'a.md': '[s](docs/real.md#anything-at-all)', 'docs/real.md': '# Real' })).code,
  1,
);

check(
  'still flags a missing file when a fragment is present',
  run(scratch({ 'a.md': '[s](docs/nope.md#section)' })).code,
  1,
);

{
  // The summary line still reports the anchor situation on EVERY run — it now
  // says how many were VALIDATED rather than how many were skipped. The
  // reporting requirement outlived the limitation it described.
  const r = run(scratch({ 'a.md': '[s](docs/real.md#real)', 'docs/real.md': '# Real' }));
  check('reports anchor validation in its summary', /Anchors validated:/.test(r.out), true);
  check('...with a count of what it checked', /Anchors validated: 1 link/.test(r.out), true);
  check('...and no longer claims anchors are unvalidated', /Anchors are NOT validated/.test(r.out), false);
}

// ---------------------------------------------------------------------------
// Repo-internal absolute URLs — the form that hid two real breaks (#187).
// ---------------------------------------------------------------------------

check(
  'flags a repo-internal absolute URL whose target does not exist',
  run(
    scratch({
      'a.md': '- [ ] [Quick Start](https://github.com/askturret/mcp/blob/main/docs/quick-start.md)',
    }),
  ).code,
  1,
);

check(
  'accepts a repo-internal absolute URL whose target exists',
  run(
    scratch({
      'a.md': '[Testing](https://github.com/askturret/mcp/blob/main/docs/TESTING.md)',
      'docs/TESTING.md': '# Testing',
    }),
  ).code,
  0,
);

check(
  'accepts a /tree/main/ directory URL that exists',
  run(
    scratch({
      'a.md': '[docs](https://github.com/askturret/mcp/tree/main/docs)',
      'docs/x.md': '# x',
    }),
  ).code,
  0,
);

// ---------------------------------------------------------------------------
// Reference-style definitions.
// ---------------------------------------------------------------------------

check(
  'flags a reference definition pointing at a missing file',
  run(scratch({ 'a.md': 'Use [the guide][g].\n\n[g]: docs/nope.md\n' })).code,
  1,
);

check(
  'accepts a reference definition pointing at a real file',
  run(scratch({ 'a.md': 'Use [the guide][g].\n\n[g]: docs/real.md\n', 'docs/real.md': '# Real' })).code,
  0,
);

check(
  'does NOT flag a reference definition holding an external URL',
  run(scratch({ 'a.md': '[homepage]: https://www.contributor-covenant.org\n' })).code,
  0,
);

// ---------------------------------------------------------------------------
// Link-target spellings that are easy to get wrong.
// ---------------------------------------------------------------------------

check(
  'handles the angle-bracket target form',
  run(scratch({ 'a.md': '[s](<docs/real.md>)', 'docs/real.md': '# Real' })).code,
  0,
);

check(
  'handles a percent-encoded space in the target',
  run(scratch({ 'a.md': '[s](docs/a%20b.md)', 'docs/a b.md': '# Spaced' })).code,
  0,
);

check(
  'ignores a link title after the target',
  run(scratch({ 'a.md': '[s](docs/real.md "The Guide")', 'docs/real.md': '# Real' })).code,
  0,
);

check(
  'resolves ../ relative to the linking file, not the root',
  run(scratch({ 'docs/a.md': '[coc](../CODE_OF_CONDUCT.md)', 'CODE_OF_CONDUCT.md': '# CoC' })).code,
  0,
);

check(
  'flags ../ that escapes past the root',
  run(scratch({ 'docs/a.md': '[coc](../../outside.md)' })).code,
  1,
);

// ---------------------------------------------------------------------------
// Fail closed.
// ---------------------------------------------------------------------------

{
  const r = run(scratch({ 'notes.txt': 'not markdown' }));
  check('FAILS when the scan found no markdown at all', r.code, 1);
  check(
    '...rather than reporting success on an empty scan',
    /examined nothing/.test(r.out),
    true,
  );
}

// ---------------------------------------------------------------------------
// Anchors (#232). The failure a file-existence check cannot see: the path
// resolves, so the link reads as correct in review, and the reader still lands
// at the top of the document instead of the section named.
// ---------------------------------------------------------------------------

check(
  'flags a link whose file exists but whose anchor does not',
  run(
    scratch({
      'a.md': 'See [the section](docs/real.md#nope).',
      'docs/real.md': '# Real\n\n## Actual Section\n',
    }),
  ).code,
  1,
);

check(
  'accepts the same link when the anchor DOES resolve',
  run(
    scratch({
      'a.md': 'See [the section](docs/real.md#actual-section).',
      'docs/real.md': '# Real\n\n## Actual Section\n',
    }),
  ).code,
  0,
);

{
  const r = run(
    scratch({ 'a.md': 'See [the section](docs/real.md#nope).', 'docs/real.md': '# Real\n' }),
  );
  check(
    'names the fragment and the file it was not found in',
    /a\.md:1 — #nope not found in docs\/real\.md/.test(r.out),
    true,
  );
}

// --- GitHub's slug rules. The double hyphen is the case most likely to be got
// --- wrong and the most likely to appear in a real document.

check(
  '"Policies & Governance" slugs to policies--governance, keeping both hyphens',
  run(
    scratch({ 'a.md': '[Policies](b.md#policies--governance)', 'b.md': '## Policies & Governance\n' }),
  ).code,
  0,
);

check(
  'and the single-hyphen spelling of that same anchor is REJECTED',
  // The paired negative. Punctuation is removed WITHOUT collapsing the space
  // around it; a slugger that collapsed runs would accept this and be wrong.
  run(
    scratch({ 'a.md': '[Policies](b.md#policies-governance)', 'b.md': '## Policies & Governance\n' }),
  ).code,
  1,
);

check(
  'strips a trailing period and lowercases: "## 9. Non-goals" -> 9-non-goals',
  run(scratch({ 'a.md': '[x](b.md#9-non-goals)', 'b.md': '## 9. Non-goals\n' })).code,
  0,
);

check(
  'keeps underscores, so an identifier heading resolves',
  run(scratch({ 'a.md': '[x](b.md#posix_run-behaviour)', 'b.md': '## POSIX_RUN behaviour\n' })).code,
  0,
);

check(
  'resolves a heading containing a markdown link by its TEXT',
  run(
    scratch({
      'a.md': '[x](b.md#see-the-guide)',
      'b.md': '## See [the guide](c.md)\n',
      'c.md': '# C',
    }),
  ).code,
  0,
);

check(
  'resolves a heading containing a code span by its contents',
  run(scratch({ 'a.md': '[x](b.md#the-run-helper)', 'b.md': '## The `run` helper\n' })).code,
  0,
);

check(
  'duplicate headings get -1, exactly as GitHub does',
  run(scratch({ 'a.md': '[x](b.md#notes-1)', 'b.md': '## Notes\n\ntext\n\n## Notes\n' })).code,
  0,
);

check(
  'an explicit <a name> anchor resolves',
  run(
    scratch({ 'a.md': '[x](b.md#manual-anchor)', 'b.md': '<a name="manual-anchor"></a>\n\n# B\n' }),
  ).code,
  0,
);

// --- Same-document anchors, which the file-only version skipped entirely.

check(
  'flags a bare #anchor that does not exist in the SAME file',
  run(scratch({ 'a.md': '# Title\n\nSee [above](#nope).\n' })).code,
  1,
);

check(
  'accepts a bare #anchor that does exist in the same file',
  run(scratch({ 'a.md': '# Title\n\n## Real Heading\n\nSee [above](#real-heading).\n' })).code,
  0,
);

// --- The fenced-block rule applied to the OTHER side of the link. Getting this
// --- wrong lets a template's headings vouch for anchors no reader can reach.

check(
  'a heading inside a fenced block does NOT provide an anchor',
  run(
    scratch({
      'a.md': '[x](b.md#fenced-heading)',
      'b.md': '# B\n\n```markdown\n## Fenced Heading\n```\n',
    }),
  ).code,
  1,
);

check(
  'DOES resolve that same heading when it is outside the fence',
  run(scratch({ 'a.md': '[x](b.md#fenced-heading)', 'b.md': '# B\n\n## Fenced Heading\n' })).code,
  0,
);

// --- The GITHUB_METADATA_CHECKLIST case, named explicitly in #232's acceptance:
// --- a ```markdown template whose links are correct for the file they are
// --- DESTINED for, not the one they appear in. A guard that "fixes" these makes
// --- the repository worse, so it is pinned with a file link AND an anchor link.

check(
  'does NOT flag a ```markdown template block (the checklist case)',
  run(
    scratch({
      'docs/GITHUB_METADATA_CHECKLIST.md':
        '# Checklist\n\nRoot `CONTRIBUTING.md` should contain:\n\n' +
        '```markdown\n' +
        '[Code of Conduct](CODE_OF_CONDUCT.md)\n' +
        '[Coding Standards](CONTRIBUTING.md#coding-standards)\n' +
        '```\n',
    }),
  ).code,
  0,
);

check(
  'DOES flag that same target once it is outside the fence',
  run(
    scratch({ 'docs/GITHUB_METADATA_CHECKLIST.md': '# Checklist\n\n[CoC](CODE_OF_CONDUCT.md)\n' }),
  ).code,
  1,
);

// --- Query strings: a GitHub-UI convention, not part of the path.

check(
  'strips a query string before resolving the file',
  run(
    scratch({ 'a.md': '[x](t/conformance.test.ts?grep=Express)', 't/conformance.test.ts': 'x' }),
  ).code,
  0,
);

check(
  'DOES still flag that link when the underlying file is missing',
  // Proves the query string was STRIPPED rather than the link skipped — an
  // ambiguity a lone "does not flag" case cannot resolve.
  run(scratch({ 'a.md': '[x](t/conformance.test.ts?grep=Express)' })).code,
  1,
);

// --- A fragment on a non-markdown target is a line reference, not an anchor.

check(
  'does NOT anchor-check a fragment on a non-markdown file',
  run(scratch({ 'a.md': '[x](src/foo.ts#L10)', 'src/foo.ts': 'const x = 1;\n' })).code,
  0,
);

check(
  'DOES flag that same link when the .ts file is missing',
  run(scratch({ 'a.md': '[x](src/foo.ts#L10)' })).code,
  1,
);

// ---------------------------------------------------------------------------
// The repository itself must pass, or the guard is unshippable.
// ---------------------------------------------------------------------------

{
  const r = run(repoRoot);
  check('this repository has no broken markdown links', r.code, 0);
  check(
    '...and validates anchors rather than announcing it skipped them',
    /Anchors validated: \d+ link\(s\)/.test(r.out),
    true,
  );
  check('...and reports what it actually scanned', /Scanned \d+ markdown file\(s\)/.test(r.out), true);
}

// ---------------------------------------------------------------------------

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${String(passed)} passed, ${String(failed)} failed\n`);
process.exit(failed === 0 ? 0 : 1);
