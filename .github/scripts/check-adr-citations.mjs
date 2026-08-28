#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Rejects source comments citing an ADR number that has no file.
 *
 * A citation like `ADR-014: executors must enforce deadlines` reads as a
 * pointer to a recorded decision. When the file does not exist, the reader
 * following it finds nothing and cannot tell whether the rationale was lost or
 * never written — and the comment still *looks* authoritative in review.
 *
 * That is not hypothetical here. Fourteen numbers were cited across seventy
 * comments with `docs/adr/` empty of every one of them, for long enough that
 * #133 had to number its own ADR 021 to avoid colliding with decisions nobody
 * had written down. #223 backfilled them; this stops it recurring.
 *
 * Same shape as the other guards in this directory: something that reads as
 * checked and is not. `check-markdown-links` (a link to a file that is not
 * there), `check-test-execution` (a suite that ran nothing),
 * `check-placeholder-tests` (a test that cannot fail).
 *
 * ## Scope — every tracked file, including `docs/adr/` (#321)
 *
 * `docs/adr/` used to be exempt wholesale, and the rationale was reasonable:
 * the index names every number by design, and an ADR may discuss a number
 * whose original allocation is disputed (see ADR-014, ADR-020).
 *
 * **But that is where the citations are densest.** Measured at the time this
 * changed: 99 of them inside `docs/adr/`, because the backfilled records
 * cross-reference each other constantly. So an intra-ADR typo — a number
 * written for its neighbour, or one resolving to nothing — was the single
 * dangling-citation class this guard could not catch, which is precisely the
 * class it exists to catch. A blind spot is worst exactly where the subject is
 * concentrated.
 *
 * The directory exemption is therefore gone, replaced by a per-LINE opt-out.
 * Of those 99 citations, exactly ONE did not resolve: the deliberate
 * hypothetical in `docs/adr/README.md`. One marker was the entire cost of
 * checking the other 98.
 *
 * ## The opt-out, and why it is per line rather than per file
 *
 * A line containing `adr-citation-exempt` has its citations skipped. Use it for
 * a number that is deliberately unresolvable — a hypothetical, or one whose
 * original allocation is disputed.
 *
 * Per line, because a file-level exemption is indistinguishable from an
 * oversight once it exists: it silently covers every citation added to that
 * file afterwards, including the typos. A marker sits on the one line it
 * excuses, is visible in review, and cannot grow while nobody is looking. The
 * exempted count is reported on every run for the same reason.
 *
 * Usage:
 *   node .github/scripts/check-adr-citations.mjs [rootDir]
 *
 * Errors (exit 1):
 *   - a citation of `ADR-NNN` with no matching `docs/adr/ADR-NNN-*.md`
 *   - no ADR files at all, which would make every citation pass vacuously
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? '.');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);
const ADR_DIR = join(repoRoot, 'docs', 'adr');

/** `ADR-014`. Three digits, so a bare `ADR` or `ADR-7` is not a citation. */
const CITATION = /ADR-(\d{3})/g;

/**
 * Per-line opt-out for a deliberately unresolvable number (#321).
 *
 * Written as a concatenation so this declaration does not itself count as a
 * marker — otherwise this line would be exempt, which is harmless here but
 * makes the mechanism confusing to read. The same trick the file already uses
 * for the NUL byte, and for the same reason: a guard's source is scanned by
 * the guard.
 */
const EXEMPT_MARKER = `adr-citation${'-'}exempt`;

const posix = (p) => p.split(sep).join('/');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

if (!existsSync(ADR_DIR)) {
  console.error(`::error::docs/adr/ does not exist under ${repoRoot}.`);
  process.exit(1);
}

const adrFiles = readdirSync(ADR_DIR).filter((f) => /^ADR-\d{3}-.+\.md$/.test(f));

// A vacuous pass is the failure this guard exists to refuse: with no ADR files
// the "every citation resolves" claim is true and meaningless.
if (adrFiles.length === 0) {
  console.error('::error::No ADR files found. Refusing to report success on a check with nothing to check against.');
  process.exit(1);
}

const written = new Set(adrFiles.map((f) => f.slice(4, 7)));
const dangling = [];
let citations = 0;
let exempted = 0;

for (const file of walk(repoRoot)) {
  const rel = posix(relative(repoRoot, file));

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // unreadable or binary; not this guard's concern
  }
  // Binary files reach here because the walk is untyped - a PNG decoded as
  // UTF-8 is unlikely to contain a citation, but skipping it is cheap.
  //
  // Two things this line cannot do, both learned by doing them:
  //
  //   - It cannot hold a LITERAL NUL. The first draft did, and
  //     `check-nul-bytes.mjs` failed the build on it - a guard catching
  //     corruption inside a guard, which is exactly why that check reads bytes
  //     rather than decoded text. Hence the `\0` escape.
  //   - This comment cannot use an EXAMPLE number. A three-digit one is a
  //     citation, and this guard flagged its own prose for it.
  if (text.includes('\0')) continue;

  text.split('\n').forEach((line, i) => {
    const exempt = line.includes(EXEMPT_MARKER);
    for (const m of line.matchAll(CITATION)) {
      // Counted either way. An exemption that vanished from the totals would
      // be a silent narrowing of the check's own scope.
      if (exempt) {
        exempted += 1;
        continue;
      }
      citations += 1;
      if (!written.has(m[1])) dangling.push({ file: rel, line: i + 1, number: m[1] });
    }
  });
}

console.log(
  `Checked ${citations} ADR citation(s) against ${adrFiles.length} record(s) in docs/adr/.`,
);
if (exempted > 0) {
  console.log(`${exempted} citation(s) skipped by an explicit ${EXEMPT_MARKER} marker.`);
}

if (dangling.length === 0) {
  console.log('\nEvery cited ADR resolves to a file.');
  process.exit(0);
}

const numbers = [...new Set(dangling.map((d) => d.number))].sort();
for (const d of dangling) console.error(`  ${d.file}:${d.line} — ADR-${d.number} has no file`);

console.error(`
${dangling.length} citation(s) point at ${numbers.length} ADR number(s) that were never
written: ${numbers.map((n) => `ADR-${n}`).join(', ')}.

A citation is a promise that the reasoning is recorded somewhere. Either write
docs/adr/ADR-NNN-kebab-title.md, or cite something that exists — an issue
number, a section, or nothing at all. Do not leave the pointer dangling: a
reader cannot tell a lost rationale from one that was never written.

::error::${dangling.length} dangling ADR citation(s).`);
process.exit(1);
