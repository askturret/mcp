#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Rejects markdown links that point at files which do not exist.
 *
 * A broken relative link is invisible at review time. The diff shows
 * `[Policy Configuration Guide](docs/policies.md)` and reads as correct;
 * confirming it means leaving the diff and checking the filesystem, which
 * nobody does reliably. That is the same shape as every other guard here —
 * `check-network-imports` (a call nobody opted into), `check-audit-append-only`
 * (a dropped row), `check-codeowners` (a rule that routes nothing),
 * `check-placeholder-tests` (a test that cannot fail), `check-nul-bytes` (a byte
 * you cannot see).
 *
 * Measured rather than assumed (#188): two independent ad-hoc sweeps found
 * EIGHT broken links on `main`, one of which had survived since 2026-08-21 and
 * every review in between. Zero were caught by human review.
 *
 * It matters more than it used to. `compatibility-policy.md`, `ownership.md`,
 * `telemetry-policy.md` and `SECURITY.md` are published promises, and a 404
 * inside a promise is worse than a 404 in a README.
 *
 * ## What is checked
 *
 *   1. Inline links and images — `[text](path)`, `![alt](path)`
 *   2. Reference definitions — `[label]: path`
 *   3. Repo-internal ABSOLUTE URLs — `https://github.com/<owner>/<repo>/{blob,tree}/main/<path>`
 *   4. ANCHORS on markdown targets, including same-document `#anchor` (#232)
 *
 * (3) is not padding. Two genuinely dead links in
 * `.github/ISSUE_TEMPLATE/question.md` pointed at `docs/quick-start.md` and
 * `docs/api.md` — files that never existed — written as absolute URLs, so the
 * repo-wide relative-link sweep that found the other eight could not see them
 * (#187). Issue templates must use absolute URLs, because they render on the
 * new-issue page where relative links do not resolve. So the one place that is
 * FORCED into the invisible form is also a place we ask contributors to trust.
 *
 * ## What is NOT checked, and why it is said out loud
 *
 *   - **External URLs.** Checking them needs the network, which this repo's own
 *     telemetry policy and network-import guard make an awkward thing to add to
 *     CI, and they are flaky besides.
 *   - **Undefined reference labels.** `[text][nope]` with no `[nope]:`
 *     definition renders as literal text — a VISIBLE break, not a silent one,
 *     so it is out of this guard's class.
 *   - **HTML anchors as LINKS.** `<a href="...">` is not markdown link syntax.
 *     `<a name="…">` IS read, but only as an anchor TARGET.
 *   - **Indented (4-space) code blocks.** Only FENCED blocks are skipped.
 *   - **Underscore emphasis in a heading.** `_italic_` slugs with its
 *     underscores kept, because GitHub keeps underscores and this repo's
 *     headings carry identifiers (`POSIX_RUN`) far more often than
 *     underscore-emphasis. Telling them apart needs a real inline parser.
 *
 * ## Anchors (#232)
 *
 * A file-existence check passes `x.md#nope` because the FILE is there. The
 * reader still lands at the top of the document. #156 found exactly that:
 * `docs/readiness.md` linked to a `#section-17-…` heading that did not exist.
 *
 * Anchors come from headings outside fenced blocks, slugified as GitHub does —
 * lowercase, punctuation removed, spaces to hyphens, duplicates suffixed `-1`.
 * The detail worth stating: punctuation is removed WITHOUT collapsing the
 * whitespace around it, so `## Policies & Governance` is `#policies--governance`
 * with two hyphens. That spelling appears in this repository today, and an
 * implementation that collapsed runs would reject a correct link.
 *
 * Fragments on NON-markdown targets are left alone — `foo.ts#L10` is a line
 * reference GitHub synthesises, with no heading behind it.
 *
 * ## Fenced blocks are skipped, and that is load-bearing
 *
 * Without it this guard reports false positives on `main` today:
 *
 *   - `docs/GITHUB_METADATA_CHECKLIST.md` contains a ```markdown fence holding
 *     template content for a ROOT-level `CONTRIBUTING.md`. Its
 *     `[Code of Conduct](CODE_OF_CONDUCT.md)` is CORRECT for the root it
 *     describes — "fixing" it to `../CODE_OF_CONDUCT.md` would point outside
 *     the repository (#187 nearly shipped exactly that).
 *   - `docs/adr/ADR-021-two-logger-types.md` contains
 *     `logger[level](message, (meta ?? {}) as LogFields);` — TypeScript that
 *     parses as markdown link syntax under a loose regex.
 *
 * Inline code spans are stripped for the same reason.
 *
 * ## An unbalanced fence is a FAILURE, not a shrug
 *
 * Fence tracking cuts both ways: a file whose fences never close would silently
 * hide every link after the opening marker. That is under-scanning while
 * reporting success — "I could not check" collapsing into "it passed", which is
 * the single failure mode this repository's guards exist to refuse. So a file
 * left inside a fence at EOF fails the run. All 48 markdown files on `main`
 * balance today, so this costs nothing and stays honest.
 *
 * Usage:
 *   node .github/scripts/check-markdown-links.mjs [rootDir]
 *
 * Errors (exit 1):
 *   - a link or reference definition whose target file does not exist
 *   - a repo-internal absolute URL whose target path does not exist
 *   - a link to a markdown file whose #anchor matches no heading there
 *   - a markdown file that ends inside an unclosed fenced block
 *   - a scan that examined no markdown files at all
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname, sep } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? '.');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

/** Repo-internal absolute URLs, captured as `<path>` after `/blob|tree/main/`. */
const SELF_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:blob|tree)\/main\/([^)\s"'<>\]]+)/g;

/** `[text](target)` and `![alt](target)`. Nested parens are not supported. */
const INLINE_LINK = /!?\[[^\]]*\]\(([^)]*)\)/g;

/** `[label]: target` at the start of a line, per CommonMark's 0-3 space rule. */
const REF_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(\S+)/;

/** ``` or ~~~ opening/closing a fence, per CommonMark's 0-3 space rule. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const posix = (p) => p.split(sep).join('/');

function collectMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectMarkdown(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Remove inline code spans so their contents are never read as links.
 *
 * Same reasoning as skipping fenced blocks, one scale down: `` `[a](b)` ``
 * renders as literal text, so treating it as a link invents a finding.
 */
const stripCodeSpans = (line) => line.replace(/`[^`]*`/g, '');

/** ATX heading: `#` to `######`, per CommonMark's 0-3 space rule. */
const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** `<a name="x">` / `<a id="x">` — an explicit anchor a heading slug will not produce. */
const HTML_ANCHOR = /<a\b[^>]*\b(?:name|id)\s*=\s*["']([^"']+)["']/gi;

/**
 * Heading text as GitHub sees it, i.e. rendered.
 *
 * `github-slugger` runs on rendered HTML text; we have raw markdown, so the
 * inline syntax has to come off first or `[Foo](bar.md)` would slug as
 * `foobarmd`.
 *
 * Underscores are deliberately NOT treated as emphasis. GitHub's slugger KEEPS
 * underscores, so `_italic_` should render to `italic` while `POSIX_RUN` must
 * stay `posix_run`. Distinguishing them needs a real inline parser, and this
 * repo's headings carry identifiers far more often than underscore-emphasis —
 * so the identifier reading is chosen, and the other is a documented limit.
 * Asterisk emphasis needs no special case: `*` is punctuation and is stripped
 * by the slug rules anyway.
 */
function headingText(raw) {
  return raw
    .replace(/<[^>]+>/g, '') // HTML tags
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // inline links and images -> their text
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1') // reference links -> their text
    .replace(/`([^`]*)`/g, '$1') // code spans -> their contents
    .trim();
}

/**
 * Characters that are combining marks but carry no visible text (#289).
 *
 * `\p{M}` is kept below so decomposed accents survive — `e` + U+0301 must slug
 * as `é`, not `e`. But that category also contains the variation selectors and
 * the keycap mark, which are emoji MODIFIERS. Their base character is stripped
 * as a symbol while the modifier survives, so `## ⚠️ What Option B costs`
 * slugged to `<U+FE0F>-what-option-b-costs`.
 *
 * That is worse than an ordinary miss: the surviving character is INVISIBLE, so
 * the guard's own error message renders the right and wrong anchors
 * identically. A maintainer copying the "expected" value out of the report
 * would copy the broken one.
 *
 * U+FE00–U+FE0F are the variation selectors, U+E0100–U+E01EF their supplement,
 * U+20E3 the combining enclosing keycap.
 */
// Written as escapes on purpose: these characters are invisible, so a literal
// class here would be unreadable in review and silently corruptible by any
// editor that normalises them.
const INVISIBLE_MODIFIERS = /[\uFE00-\uFE0F\u20E3\u{E0100}-\u{E01EF}]/gu;

/**
 * GitHub's heading-slug rules.
 *
 * Lowercase, strip punctuation, spaces to hyphens. The load-bearing detail is
 * that punctuation is REMOVED WITHOUT collapsing the whitespace around it, so
 * `## Policies & Governance` becomes `policies--governance` with two hyphens.
 * An implementation that collapses runs would produce `policies-governance`
 * and reject the one link shape most likely to appear in a real document.
 *
 * The same rule is why an emoji-prefixed heading anchors with a LEADING hyphen:
 * the emoji goes, the space after it stays and becomes `-`. `## ⚠️ What Option
 * B costs` is `#-what-option-b-costs`, not `#what-option-b-costs`. Verified
 * against a real rendered document rather than reasoned about — `prompts`'
 * readme heads a section `## ❯ Prompt Objects` and its own working table of
 * contents links to `#-prompt-objects`.
 *
 * Letters, numbers, combining marks, hyphen, underscore and space survive;
 * everything else goes. That covers `&`, `.`, `,`, `:`, `?`, `!`, quotes,
 * brackets, slashes and the em-dash this repo uses freely.
 */
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(INVISIBLE_MODIFIERS, '')
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/ /g, '-');
}

/**
 * Every anchor a reader can actually land on in one file.
 *
 * Headings are collected from OUTSIDE fenced blocks only — the same rule the
 * link scan uses, and for the same reason: a ```markdown fence showing template
 * content for another file would otherwise contribute headings this file does
 * not have, which is the false-positive direction that makes a guard harmful.
 *
 * Duplicate headings get `-1`, `-2`, … exactly as GitHub does, so a document
 * with two `## Notes` sections resolves `#notes-1` rather than reporting it
 * dead.
 */
function collectAnchors(lines) {
  const seen = new Map();
  const anchors = new Set();

  for (const line of nonFencedLines(lines).lines) {
    const heading = ATX_HEADING.exec(line);
    if (heading) {
      const base = slugify(headingText(heading[2]));
      if (base !== '') {
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        anchors.add(count === 0 ? base : `${base}-${count}`);
      }
    }

    for (const m of line.matchAll(HTML_ANCHOR)) anchors.add(m[1]);
  }

  return anchors;
}

/**
 * Split a file into the lines OUTSIDE fenced blocks, plus whether a fence was
 * left open at EOF.
 *
 * Factored out so heading collection and link scanning cannot disagree about
 * what is inside a fence — if they did, a heading inside a fence could validate
 * a link that a reader cannot follow.
 */
function nonFencedLines(lines) {
  const out = [];
  const numbers = [];
  let fence = null;

  lines.forEach((line, index) => {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const rest = fenceMatch[2].trim();
      if (fence === null) {
        fence = { char: marker[0], length: marker.length };
        return;
      }
      if (marker[0] === fence.char && marker.length >= fence.length && rest === '') {
        fence = null;
        return;
      }
      return; // a shorter/different marker inside a fence is just content
    }
    if (fence !== null) return;
    out.push(line);
    numbers.push(index + 1);
  });

  return { lines: out, numbers, unbalanced: fence !== null };
}

/**
 * Is this a link target we can resolve on the filesystem?
 *
 * External schemes and bare anchors are out of scope; both are stated in the
 * header rather than silently dropped.
 */
function isCheckableTarget(target) {
  if (target === '') return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return false; // http:, mailto:, tel:, …
  if (target.startsWith('//')) return false; // protocol-relative
  return true;
}

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is not a broken link; leave it to render as written.
    return value;
  }
};

/**
 * Split a raw markdown target into its path and fragment.
 *
 * Handles the angle-bracket form, an optional title, percent-encoding, and the
 * query string.
 *
 * ## The query string is stripped before resolving
 *
 * `conformance.test.ts?grep=Express` is a GitHub-UI convention, not part of the
 * path. Resolving it literally looks for a file with `?grep=Express` in its
 * name, which never exists — so the guard would report a link that works in the
 * browser as broken, and the obvious "fix" is to delete a useful query. Strip
 * it, then judge the file on its own.
 *
 * `path` is null when the target is not resolvable on disk; `fragment` is null
 * when there is none. A bare `#anchor` yields `{path: null, fragment: 'anchor'}`
 * — same-document, which is now checked against the file's own headings rather
 * than skipped.
 */
function parseTarget(raw) {
  let target = raw.trim();

  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  else target = target.split(/\s+/)[0] ?? ''; // drop `(path "title")`

  const hashIndex = target.indexOf('#');
  const fragmentRaw = hashIndex === -1 ? null : target.slice(hashIndex + 1);
  let pathPart = hashIndex === -1 ? target : target.slice(0, hashIndex);

  pathPart = pathPart.split('?')[0];

  const fragment = fragmentRaw === null || fragmentRaw === '' ? null : decode(fragmentRaw);
  const path = isCheckableTarget(pathPart) ? decode(pathPart) : null;

  return { path, fragment };
}

/** Back-compat shape for the file-existence checks. */
const toFsPath = (raw) => parseTarget(raw).path;

const files = collectMarkdown(repoRoot).sort();

// Reporting success on a scan that examined nothing is the failure mode that
// would make every other assertion here meaningless. Same guard as
// check-nul-bytes and check-network-imports.
if (files.length === 0) {
  console.error(`No markdown files found under ${repoRoot}.`);
  console.error('Refusing to report success on a scan that examined nothing.');
  process.exit(1);
}

const broken = [];
const deadAnchors = [];
const unbalanced = [];
let checked = 0;
let anchorsChecked = 0;

/** Anchors per file, computed once — a hub doc is linked to from many places. */
const anchorCache = new Map();

function anchorsFor(absPath) {
  const cached = anchorCache.get(absPath);
  if (cached !== undefined) return cached;

  let set;
  try {
    set = collectAnchors(readFileSync(absPath, 'utf8').split(/\r?\n/));
  } catch {
    set = null; // unreadable — the file check reports it; do not double-report
  }
  anchorCache.set(absPath, set);
  return set;
}

for (const file of files) {
  const rel = posix(relative(repoRoot, file));
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);

  // CommonMark fence handling lives in nonFencedLines, shared with heading
  // collection so the two cannot disagree about what is inside a fence.
  const scan = nonFencedLines(lines);

  scan.lines.forEach((rawLine, i) => {
    const text = stripCodeSpans(rawLine);
    const lineNo = scan.numbers[i];

    const record = (target, resolved, kind) => {
      checked += 1;
      if (!existsSync(resolved)) {
        broken.push({ file: rel, line: lineNo, target, kind });
        return false;
      }
      return true;
    };

    /**
     * Validate `#fragment` against the target document's headings.
     *
     * Only for markdown targets: `foo.ts#L10` is a line reference GitHub
     * synthesises, with no heading behind it, and treating it as an anchor
     * would invent findings.
     */
    const checkAnchor = (target, absTarget, fragment) => {
      if (fragment === null) return;
      if (!absTarget.endsWith('.md')) return;

      const anchors = anchorsFor(absTarget);
      if (anchors === null) return;

      anchorsChecked += 1;
      if (!anchors.has(fragment.toLowerCase())) {
        deadAnchors.push({
          file: rel,
          line: lineNo,
          target,
          fragment,
          inFile: posix(relative(repoRoot, absTarget)),
        });
      }
    };

    for (const m of text.matchAll(INLINE_LINK)) {
      const raw = m[1] ?? '';
      const { path, fragment } = parseTarget(raw);

      // A bare `#anchor` is same-document — checked against THIS file, which
      // the previous version skipped entirely.
      if (path === null) {
        if (fragment !== null && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw.trim())) {
          checkAnchor(raw.trim(), file, fragment);
        }
        continue;
      }

      const absTarget = resolve(dirname(file), path);
      if (record(raw.trim(), absTarget, 'link')) checkAnchor(raw.trim(), absTarget, fragment);
    }

    const refMatch = REF_DEFINITION.exec(text);
    if (refMatch) {
      const { path, fragment } = parseTarget(refMatch[1]);
      if (path !== null) {
        const absTarget = resolve(dirname(file), path);
        if (record(refMatch[1], absTarget, 'reference')) {
          checkAnchor(refMatch[1], absTarget, fragment);
        }
      }
    }

    for (const m of text.matchAll(SELF_URL)) {
      const [pathRaw, fragmentRaw] = m[1].split('#');
      const path = (pathRaw ?? '').split('?')[0];
      if (path === '') continue;
      const absTarget = resolve(repoRoot, decode(path));
      if (record(m[1], absTarget, 'self-url') && fragmentRaw) {
        checkAnchor(m[1], absTarget, decode(fragmentRaw));
      }
    }
  });

  if (scan.unbalanced) unbalanced.push(rel);
}

console.log(
  `Scanned ${files.length} markdown file(s); ${checked} resolvable link(s) checked.`,
);
console.log(`Anchors validated: ${anchorsChecked} link(s) carried a #fragment.`);

if (unbalanced.length > 0) {
  console.error('\nMarkdown file(s) ending inside an unclosed fenced block:\n');
  for (const f of unbalanced) console.error(`  ${f}`);
  console.error(`
Every link after the unclosed fence was SKIPPED, so this run did not check what
it appears to have checked. That is "could not check" reported as "passed",
which is the failure this guard exists to refuse — so it fails instead.

Close the fence, or if the file is intentionally unusual, fix it here rather
than letting the scan silently narrow.

::error::${unbalanced.length} markdown file(s) have an unbalanced code fence.`);
  process.exit(1);
}

if (broken.length > 0) {
  console.error('\nMarkdown links pointing at files that do not exist:\n');
  for (const b of broken) {
    console.error(`  ${b.file}:${b.line} — ${b.kind} -> ${b.target}`);
  }
  console.error(`
A link that resolves to nothing is invisible in review: the diff shows a
plausible path and checking it means leaving the diff.

If the target was planned but never written, either write it or point the link
at the nearest thing that DOES exist — deleting the link loses the information
that someone intended the page, and leaving it 404s a reader.

::error::${broken.length} broken markdown link(s).`);
  process.exit(1);
}

if (deadAnchors.length > 0) {
  console.error('\nMarkdown links whose FILE exists but whose anchor does not:\n');
  for (const a of deadAnchors) {
    console.error(`  ${a.file}:${a.line} — #${a.fragment} not found in ${a.inFile}`);
  }
  console.error(`
This is the failure a file-existence check cannot see: the path resolves, so the
link looks fine in review and in any tooling that stops at the filename. The
reader still lands at the top of the document instead of the section named.

The anchor is derived from the heading text: lowercased, punctuation removed,
spaces turned into hyphens. Punctuation does NOT collapse the space around it,
so "## Policies & Governance" is "#policies--governance" — two hyphens. If a
heading was renamed, every link to it needs the same edit.

::error::${deadAnchors.length} markdown link(s) point at a heading that does not exist.`);
  process.exit(1);
}

console.log('\nNo broken markdown links or anchors.');
process.exit(0);
