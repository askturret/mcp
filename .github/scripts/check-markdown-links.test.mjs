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
  // `process.execPath` rather than a bare 'node' (#337). Resolving through PATH
  // means that off PATH every spawn fails to start, and the suite reports
  // 5 passed / 91 failed — an ENVIRONMENTAL failure that reads exactly like a
  // code defect and sends the reader hunting through the guard. execPath is the
  // interpreter already running this file, so it is exact and cannot drift.
  const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf-8' });
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

// --- Emoji and their invisible modifiers (#289).
//
// `\p{M}` is kept so decomposed accents survive, but that category also holds
// the VARIATION SELECTORS and the keycap mark, which are emoji modifiers. The
// base character was stripped as a symbol while the modifier survived, so
// `### <U+26A0><U+FE0F> What Option B costs` slugged to
// `<U+FE0F>-what-option-b-costs`.
//
// Worse than an ordinary miss: the surviving character is INVISIBLE, so the
// guard's own error message rendered the right and wrong anchors identically.
// Written with explicit escapes below for exactly that reason — a literal here
// would be unreviewable.

const WARNING = '\u26A0\uFE0F'; // U+26A0 WARNING SIGN + U+FE0F VARIATION SELECTOR-16
const HEADING_289 = `### ${WARNING} What Option B costs`;

check(
  'an emoji heading resolves without its variation selector (the #289 heading)',
  run(
    scratch({ 'a.md': `[cost](b.md#-what-option-b-costs)`, 'b.md': `${HEADING_289}\n` }),
  ).code,
  0,
);

check(
  'the slug with the variation selector RETAINED is rejected',
  // The paired negative, and the whole point: before the fix this was the form
  // the guard accepted, while rejecting the one a reader can actually reach.
  run(
    scratch({
      'a.md': `[cost](b.md#\uFE0F-what-option-b-costs)`,
      'b.md': `${HEADING_289}\n`,
    }),
  ).code,
  1,
);

check(
  'the same heading WITHOUT the variation selector slugs identically',
  // The real invariant: an invisible modifier must not change the anchor. If
  // these two ever diverge again, the bug is back in some other form.
  run(
    scratch({
      'a.md': '[cost](b.md#-what-option-b-costs)',
      'b.md': '### \u26A0 What Option B costs\n',
    }),
  ).code,
  0,
);

check(
  'an emoji-prefixed heading keeps its LEADING hyphen',
  // Not a quirk to be tidied away. The emoji goes, the space after it stays and
  // becomes `-`. Verified against a real rendered document rather than reasoned
  // about: `prompts`' readme heads a section `## <U+276F> Prompt Objects` and its
  // own working table of contents links to `#-prompt-objects`.
  //
  // #289's acceptance text said this heading anchors as `#what-option-b-costs`
  // with no leading hyphen. It does not, and accepting that spelling would make
  // the guard bless a link that 404s on GitHub.
  run(scratch({ 'a.md': '[x](b.md#what-option-b-costs)', 'b.md': `${HEADING_289}\n` })).code,
  1,
);

check(
  'a keycap sequence loses both of its invisible parts',
  run(
    scratch({
      'a.md': '[x](b.md#1-first-step)',
      'b.md': '## 1\uFE0F\u20E3 First step\n',
    }),
  ).code,
  0,
);

check(
  'an emoji in the MIDDLE of a heading leaves a double hyphen',
  // Same rule as `Policies & Governance`: the symbol goes, both spaces stay.
  run(scratch({ 'a.md': '[x](b.md#status--done)', 'b.md': '## Status ✅ Done\n' })).code,
  0,
);

check(
  'a decomposed accent is NOT stripped along with the modifiers',
  // The paired guard against over-correcting. `e` + U+0301 is a real combining
  // mark that GitHub keeps; excluding all of `\p{M}` would have silently
  // broken every accented heading while fixing the emoji case.
  run(
    scratch({ 'a.md': '[x](b.md#cafe\u0301-configuration)', 'b.md': '## Cafe\u0301 Configuration\n' }),
  ).code,
  0,
);

// --- The same defect class, reached by PROPERTY rather than enumeration (#296).
//
// #289 excluded three hand-picked ranges. That closed the cases it was filed
// for and left four more invisible combining marks behind, because the fix
// named the examples rather than the property they shared. The rule is now
// `\p{Default_Ignorable_Code_Point}` — "the code points a renderer is expected
// to show nothing for" — which is what "invisible modifier" always meant.
//
// The keycap U+20E3 stays enumerated beside it on purpose: it is VISIBLE (it
// draws the box around the digit), so the property correctly does not cover it
// and removing its explicit entry would regress the keycap case above.
//
// These cover both ends: characters the old list missed, and the accented
// headings the `\p{M}` retention exists to protect.

const CGJ = '͏'; // U+034F COMBINING GRAPHEME JOINER
const MFVS1 = '᠋'; // U+180B MONGOLIAN FREE VARIATION SELECTOR ONE
const MFVS4 = '᠏'; // U+180F MONGOLIAN FREE VARIATION SELECTOR FOUR

check(
  'a combining grapheme joiner does not survive into the slug',
  run(
    scratch({
      'a.md': '[x](b.md#cafe-configuration)',
      'b.md': `## Cafe${CGJ} Configuration\n`,
    }),
  ).code,
  0,
);

check(
  'the slug with the grapheme joiner RETAINED is rejected',
  // The paired negative, exactly as #289 has for the variation selector. Without
  // it, a "fix" that kept the character AND accepted both spellings would pass.
  run(
    scratch({
      'a.md': `[x](b.md#cafe${CGJ}-configuration)`,
      'b.md': `## Cafe${CGJ} Configuration\n`,
    }),
  ).code,
  1,
);

check(
  'a Mongolian free variation selector does not survive into the slug',
  run(
    scratch({
      'a.md': '[x](b.md#suffix-form)',
      'b.md': `## Suffix${MFVS1} Form\n`,
    }),
  ).code,
  0,
);

check(
  'a heading with an invisible modifier slugs identically to one without',
  // The invariant behind all of these, stated once: an invisible character must
  // not change the anchor. Both files below must produce the SAME slug.
  run(
    scratch({
      'a.md': '[x](b.md#suffix-form)',
      'b.md': '## Suffix Form\n',
    }),
  ).code,
  0,
);

check(
  'U+180F is covered too, though no issue enumerated it',
  // Mongolian FVS4 was added in Unicode 14, AFTER U+180B-U+180D. A hand-picked
  // list written to #296's text would already be stale; the property is not.
  // This is the case that justifies the method change rather than a longer list.
  run(
    scratch({
      'a.md': '[x](b.md#suffix-form)',
      'b.md': `## Suffix${MFVS4} Form\n`,
    }),
  ).code,
  0,
);

check(
  'a PRECOMPOSED accent is still not stripped',
  // The precomposed half of the over-correction guard: U+00E9 is a Letter, not
  // a Mark, so it travels a different path through the slug rules than the
  // decomposed `e` + U+0301 case above. Both must survive.
  run(
    scratch({ 'a.md': '[x](b.md#café-configuration)', 'b.md': '## Café Configuration\n' }),
  ).code,
  0,
);

check(
  'a combining cedilla is still not stripped',
  // Named in #296 as a character the property must NOT match. Asserted rather
  // than trusted: `\p{Default_Ignorable_Code_Point}` excluding combining marks
  // that carry visible meaning is the whole reason this fix is safe.
  run(
    scratch({ 'a.md': '[x](b.md#français-notes)', 'b.md': '## Français Notes\n' }),
  ).code,
  0,
);

// --- A malformed percent-escape must REPORT, never crash (#244).
//
// `decodeURIComponent('%ZZ')` throws `URIError`. Every decode in this guard
// goes through one try/catch'd helper, whose documented policy is that a
// malformed escape is not a broken link — it is left to render as written and
// judged as an ordinary path.
//
// The distinction these assert is between the two red outcomes, which an exit
// code alone cannot tell apart: a clean broken-link REPORT, versus a Node stack
// trace. Both exit 1, but a reader scanning a red log would take the second as
// evidence the GUARD is broken rather than the content — a misdiagnosis that
// costs more than the bug. So they assert on the OUTPUT, not just the code.

const MALFORMED = 'docs/%ZZ.md';

for (const [shape, body] of [
  ['relative', `[Broken](${MALFORMED})`],
  ['self-url', `[Broken](https://github.com/askturret/mcp/blob/main/${MALFORMED})`],
]) {
  const result = run(scratch({ 'a.md': `# T\n\n${body}\n` }));

  check(`a malformed escape in the ${shape} form still exits 1`, result.code, 1);
  check(
    `...and in the ${shape} form reports it as a broken link`,
    result.out.includes('broken markdown link(s)'),
    true,
  );
  check(
    `...and in the ${shape} form does NOT crash with a URIError`,
    result.out.includes('URIError'),
    false,
  );
}

// --- Inline links whose destination or text wraps across lines (#244).
//
// Valid CommonMark, and a per-line scan never sees a complete `[...](...)`, so
// the file reported "0 resolvable links checked" and a clean bill — under-reach
// wearing the same output as a genuinely link-free file.
//
// Not hypothetical: this repository already contained two such links (both
// wrapping in the link TEXT rather than the destination, which is the more
// natural way to hit it), and neither was being checked before this change.

check(
  'FLAGS a multi-line link whose destination is on the next line',
  run(scratch({ 'a.md': '# T\n\nSee [a](\n  docs/nope.md) here.\n' })).code,
  1,
);

check(
  'accepts a multi-line link whose target exists',
  // The paired positive: a fix that simply flagged everything wrapped would
  // satisfy the negative above.
  run(
    scratch({ 'a.md': '# T\n\nSee [a](\n  docs/real.md) here.\n', 'docs/real.md': '# Real' }),
  ).code,
  0,
);

check(
  'FLAGS a link whose TEXT wraps — the shape this repo actually uses',
  run(scratch({ 'a.md': '# T\n\nSee [the\nguide](docs/nope.md) here.\n' })).code,
  1,
);

check(
  'a wrapped link is reported against the line it STARTS on',
  // A finding on the wrong line is its own kind of unhelpful, and the offset
  // has to be mapped back deliberately once matching spans lines.
  run(scratch({ 'a.md': '# T\n\nSee [a](\n  docs/nope.md) here.\n' })).out.includes('a.md:3'),
  true,
);

check(
  'a wrapped SAME-DOCUMENT anchor is validated too',
  // The +1 anchor this change added on the real tree came from exactly this
  // shape, so it is asserted rather than assumed.
  run(scratch({ 'a.md': '# T\n\n## Real Heading\n\nSee [the\nheading](#nope-dead).\n' })).code,
  1,
);

check(
  'code spans are still stripped PER LINE, not across the join',
  // The subtle way to break this: stripping code spans on the joined text lets
  // one backtick on each of two lines swallow everything between them, hiding a
  // real link. Here the broken link sits between two inline code spans on
  // separate lines and must still be found.
  run(scratch({ 'a.md': '# T\n\n`a` and [x](docs/nope.md)\n`b` and more\n' })).code,
  1,
);

// --- #319: the join is PER PARAGRAPH, not whole-file.
//
// #244's whole-file join made two lines adjacent that a reader never sees as
// adjacent, so the guard reported links that do not exist. Both cases below
// were reproduced against the real guard before being fixed.
//
// The three negatives here are the fix; the positives immediately after are
// what stops the fix from becoming a false NEGATIVE, which would be a worse
// guard than the noisy one we started with.

check(
  'does NOT flag halves separated by a FENCE (#319 finding 1)',
  // nonFencedLines correctly removes the fenced content — and removing it is
  // exactly what made `[a](` and `docs/nope.md)` touch. A fence ends a
  // paragraph in every dialect, so these are not two halves of one link.
  run(
    scratch({ 'a.md': '# T\n\nSee [a](\n```js\nconst x = 1;\n```\ndocs/nope.md)\n' }),
  ).code,
  0,
);

check(
  'does NOT flag halves separated by a BLANK LINE (#319 finding 2)',
  // No inline-link production admits a blank line in the destination.
  run(scratch({ 'a.md': '# T\n\nSee [a](\n\ndocs/nope.md)\n' })).code,
  0,
);

check(
  'does NOT flag halves sitting in DIFFERENT paragraphs with prose between',
  run(scratch({ 'a.md': '# T\n\nSee [a](\n\nsome prose\n\ndocs/nope.md)\n' })).code,
  0,
);

// --- The other direction, which matters more: a genuinely wrapped link must
// --- stay caught. Paragraph-scoped joining is only safe if it still joins.

check(
  'STILL flags a genuinely wrapped link (no fence, no blank line) (#319)',
  run(scratch({ 'a.md': '# T\n\nSee [a](\n  docs/nope.md) here.\n' })).code,
  1,
);

check(
  'STILL flags a wrapped link in a LATER paragraph',
  run(scratch({ 'a.md': '# T\n\nFirst para.\n\nSee [a](\n  docs/nope.md).\n' })).code,
  1,
);

check(
  'STILL flags a wrapped link in the paragraph AFTER a fenced block',
  // The segment break must start a new paragraph, not swallow the rest of the
  // file: a fence earlier in the document cannot stop later links being seen.
  run(
    scratch({ 'a.md': '# T\n\n```\ncode\n```\n\nSee [a](\n  docs/nope.md).\n' }),
  ).code,
  1,
);

check(
  'a wrapped link after a fence is reported against its OWN line',
  // The offset->line map is now per segment, so an off-by-one here would be
  // invisible in the exit code and only surface as a misleading report.
  run(
    scratch({ 'a.md': '# T\n\n```\ncode\n```\n\nSee [a](\n  docs/nope.md).\n' }),
  ).out.includes('a.md:7'),
  true,
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

// --- The SAME construct written as a reference definition (#290).
//
// `[x](#dead)` was checked and `[lbl]: #dead` was not, because the
// same-document branch had been added to the inline path only. Both spellings
// now go through one `checkTarget`, so the divergence cannot recur by
// construction — these cases assert the behaviour that guarantee is for.
//
// Under-reach, note, not a false accept: the old code skipped the definition
// rather than blessing it. The tell was `Anchors validated: 0` on a file that
// plainly carried a fragment.

const REF_DOC = (target) => `# Title\n\n## Real Heading\n\nSee [ref] here.\n\n[ref]: ${target}\n`;

check(
  'FLAGS a reference definition whose bare #anchor does not exist',
  run(scratch({ 'a.md': REF_DOC('#nope-dead') })).code,
  1,
);

check(
  'accepts a reference definition whose bare #anchor does exist',
  // The paired positive. Without it, a "fix" that rejected every reference
  // definition outright would satisfy the negative case above.
  run(scratch({ 'a.md': REF_DOC('#real-heading') })).code,
  0,
);

check(
  'the two spellings agree on the SAME dead anchor',
  // The actual invariant behind #290, stated once: how a link is written must
  // not change whether it is checked.
  run(scratch({ 'a.md': '# T\n\n## Real Heading\n\n[x](#gone)\n' })).code,
  run(scratch({ 'a.md': REF_DOC('#gone') })).code,
);

check(
  'the two spellings agree on the same LIVE anchor',
  run(scratch({ 'a.md': '# T\n\n## Real Heading\n\n[x](#real-heading)\n' })).code,
  run(scratch({ 'a.md': REF_DOC('#real-heading') })).code,
);

check(
  'a reference definition pointing at ANOTHER file still validates its fragment',
  // Regression guard: this path already worked, and the #290 refactor routed it
  // through the shared helper. It must not have been lost on the way.
  run(
    scratch({
      'a.md': 'See [ref].\n\n[ref]: b.md#no-such-heading\n',
      'b.md': '# B\n\n## Real Heading\n',
    }),
  ).code,
  1,
);

check(
  'a reference definition to an EXTERNAL url with a fragment is left alone',
  // Its path is null too, but the fragment belongs to a document we do not
  // have. Treating those alike would invent a finding on every external link
  // that carries an anchor.
  run(scratch({ 'a.md': '# T\n\n[e]: https://example.com/x#some-frag\n' })).code,
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
// #337 item 2: every failing category is reported in ONE run.
//
// Each category used to exit as soon as it printed, so a broken file link
// MASKED a broken anchor. Nothing was permanently lost — the next run would
// surface it — but during #333's QA that was indistinguishable from the change
// under test having suppressed the anchor finding, and cost a near-miss.
//
// These assert on the REPORT, not the exit code: the exit code was already 1 in
// both the masked and unmasked cases, so a status-only test cannot see this bug
// at all.

{
  const dir = scratch({
    'a.md': '# Title\n\n[gone](./nope.md)\n\n[bad anchor](./b.md#no-such-heading)\n',
    'b.md': '# Real Heading\n',
  });
  const r = run(dir);

  check('a broken link and a dead anchor together still fail', r.code, 1);
  check(
    'the broken LINK is reported',
    /Markdown links pointing at files that do not exist/.test(r.out),
    true,
  );
  check(
    'the dead ANCHOR is reported in the SAME run, rather than masked by the link',
    /whose FILE exists but whose anchor does not/.test(r.out),
    true,
  );
  check('...naming the anchor that is missing', /#no-such-heading/.test(r.out), true);
  check(
    '...and saying plainly that nothing was withheld',
    /Fixing one will NOT reveal another on the next run/.test(r.out),
    true,
  );
}

{
  // With only ONE category failing there is nothing to reconcile, so the
  // multi-category summary must stay quiet rather than becoming boilerplate.
  const r = run(scratch({ 'a.md': '# Title\n\n[gone](./nope.md)\n' }));
  check('a single failing category still fails', r.code, 1);
  check(
    '...without the multi-category summary',
    /Fixing one will NOT reveal another/.test(r.out),
    false,
  );
}

{
  // An unclosed fence narrows the scan, so the other categories are a floor
  // rather than a total. Said only when the fence category actually fired.
  const r = run(
    scratch({
      'a.md': '# Title\n\n[gone](./nope.md)\n\n```\nunclosed\n',
    }),
  );
  check('an unbalanced fence alongside a broken link fails', r.code, 1);
  check(
    'both categories are reported',
    /unclosed fenced block/.test(r.out) && /files that do not exist/.test(r.out),
    true,
  );
  check(
    '...with the caveat that the other categories may under-report',
    /may UNDER-report/.test(r.out),
    true,
  );
}

// ---------------------------------------------------------------------------

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${String(passed)} passed, ${String(failed)} failed\n`);
process.exit(failed === 0 ? 0 : 1);
