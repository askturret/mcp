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
 *   - **Anchors.** `docs/x.md#section` is checked as far as `docs/x.md`; the
 *     `#section` part is discarded. Anchor validation needs heading
 *     slugification rules and is a larger job (#188 defers it deliberately).
 *     There IS at least one dead anchor on `main` today — `docs/readiness.md`
 *     links to a `#section-17-...` heading that does not exist in the file it
 *     names. This guard does NOT catch it, and the summary line says so on
 *     every run rather than letting a green check imply otherwise.
 *   - **External URLs.** Checking them needs the network, which this repo's own
 *     telemetry policy and network-import guard make an awkward thing to add to
 *     CI, and they are flaky besides.
 *   - **Undefined reference labels.** `[text][nope]` with no `[nope]:`
 *     definition renders as literal text — a VISIBLE break, not a silent one,
 *     so it is out of this guard's class.
 *   - **HTML anchors.** `<a href="...">` is not markdown link syntax.
 *   - **Indented (4-space) code blocks.** Only FENCED blocks are skipped.
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

/**
 * Is this a link target we can resolve on the filesystem?
 *
 * External schemes and bare anchors are out of scope; both are stated in the
 * header rather than silently dropped.
 */
function isCheckableTarget(target) {
  if (target === '') return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return false; // http:, mailto:, tel:, …
  if (target.startsWith('#')) return false; // bare anchor — see the anchor note
  if (target.startsWith('//')) return false; // protocol-relative
  return true;
}

/**
 * Reduce a raw markdown target to a filesystem path, or null if not checkable.
 *
 * Handles the angle-bracket form, an optional title, and percent-encoding. The
 * fragment is stripped HERE, which is precisely where anchor checking would
 * begin if it is ever added.
 */
function toFsPath(raw) {
  let target = raw.trim();

  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  else target = target.split(/\s+/)[0] ?? ''; // drop `(path "title")`

  target = target.split('#')[0];
  if (!isCheckableTarget(target)) return null;

  try {
    return decodeURIComponent(target);
  } catch {
    // A malformed escape is not a broken link; leave it to render as written.
    return target;
  }
}

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
const unbalanced = [];
let checked = 0;
let anchorsIgnored = 0;

for (const file of files) {
  const rel = posix(relative(repoRoot, file));
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);

  // CommonMark: a fence closes on the same marker CHARACTER, at least as long
  // as the opener, with no info string. A naive toggle would close a
  // ```` ```markdown ```` block on the first ``` it contains — which is exactly
  // the construct this repo uses for template content.
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

    const text = stripCodeSpans(line);
    const lineNo = index + 1;

    const record = (target, resolved, kind) => {
      checked += 1;
      if (!existsSync(resolved)) broken.push({ file: rel, line: lineNo, target, kind });
    };

    for (const m of text.matchAll(INLINE_LINK)) {
      const raw = m[1] ?? '';
      if (raw.includes('#') && toFsPath(raw) !== null) anchorsIgnored += 1;
      const fsPath = toFsPath(raw);
      if (fsPath === null) continue;
      record(raw.trim(), resolve(dirname(file), fsPath), 'link');
    }

    const refMatch = REF_DEFINITION.exec(text);
    if (refMatch) {
      const fsPath = toFsPath(refMatch[1]);
      if (fsPath !== null) record(refMatch[1], resolve(dirname(file), fsPath), 'reference');
    }

    for (const m of text.matchAll(SELF_URL)) {
      const path = m[1].split('#')[0];
      if (path !== '') record(m[1], resolve(repoRoot, decodeURIComponent(path)), 'self-url');
    }
  });

  if (fence !== null) unbalanced.push(rel);
}

console.log(
  `Scanned ${files.length} markdown file(s); ${checked} resolvable link(s) checked.`,
);
console.log(
  `Anchors are NOT validated: ${anchorsIgnored} link(s) carried a #fragment that was ignored.`,
);

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

Note this guard does not validate anchors, so a link that passes here can still
land on a missing heading.

::error::${broken.length} broken markdown link(s).`);
  process.exit(1);
}

console.log('\nNo broken markdown links.');
process.exit(0);
