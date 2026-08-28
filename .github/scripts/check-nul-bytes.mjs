#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Rejects NUL bytes in source files.
 *
 * A NUL byte never legitimately appears in TypeScript or JavaScript source. It
 * arrives by accident — a corrupted patch, a bad merge, an editor writing the
 * wrong encoding, or a script doing string surgery on a file it does not
 * understand.
 *
 * The reason this is a guard rather than a note in CONTRIBUTING is that the
 * existing checks cannot see it. It happened twice in one session (#33 and #34
 * mutation runs), and on both occasions `tsc`, `jest` and all three existing
 * guards passed with the byte present. Both were caught only because `grep`
 * incidentally called the file binary.
 *
 * Measured, rather than assumed — with a NUL inside a string literal:
 *
 *   tsc               exit 0   blind
 *   network guard     exit 0   blind
 *   placeholder guard exit 0   blind
 *   this guard        exit 1   catches it
 *
 * `jest` is the one worth being precise about, because the honest answer is
 * "sometimes". It fails if the corrupted string is semantically load-bearing —
 * put a NUL inside `'sha256'` and hashing breaks loudly. In BOTH real cases the
 * NUL landed in a cache-key separator, which is inert: every test passed. So
 * the test suite catches this only by luck, and luck is a function of where the
 * corruption lands rather than of test quality.
 *
 * That is the argument for a byte-level check. Every tool above reads source as
 * decoded text, where a stray NUL is just another character.
 *
 * Usage:
 *   node .github/scripts/check-nul-bytes.mjs [rootDir] [--require-roots]
 *
 * Errors (exit 1):
 *   - any scanned file containing a 0x00 byte
 *   - a scan that examined no files at all (see below)
 *   - with `--require-roots`, a required scan root that does not exist (#121)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

import { isProcessEntryPoint } from './lib/entry-point.mjs';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

/**
 * Text formats where a NUL is unambiguously corruption.
 *
 * Deliberately does NOT include every extension in the repo: images, archives
 * and lockfile-adjacent binaries legitimately contain NUL bytes, and a guard
 * that flags them would be turned off within a day.
 */
const SCANNED_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|yml|yaml)$/;

/**
 * Roots worth scanning. Anything outside these is not ours to police.
 *
 * `required` records whether the directory is expected to exist. The
 * distinction is what makes a lost root visible (#121): before this, a root
 * that did not exist was skipped in silence, so RENAMING `packages/` would have
 * quietly dropped the guard's main body of coverage while it carried on
 * reporting success on whatever was left.
 *
 * That renaming case, rather than the never-created one, is the real hazard
 * here — see the note on `scripts` below.
 */
const SCAN_ROOTS = [
  { path: 'packages', required: true },
  { path: 'examples', required: true },
  { path: 'docs', required: true },
  { path: '.github', required: true },
  {
    // Does not exist in this repository yet. Kept declared ON PURPOSE rather
    // than deleted: a declaration costs a warning line, whereas deleting it
    // means the day somebody adds `scripts/` it is scanned by nobody and
    // nothing says so. Optional, so its absence warns and never fails.
    path: 'scripts',
    required: false,
    note: 'not present yet; declared so it is covered from the day it appears',
  },
];

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, acc);
    else if (SCANNED_EXT.test(entry)) acc.push(full);
  }
  return acc;
}

/**
 * Files sitting directly in the repository root (#121).
 *
 * A glob, NOT a scan root: it takes files and stops, leaving directories to
 * `SCAN_ROOTS`. Adding `''` as a root instead would have walked the entire
 * repository — `node_modules` included, since `SKIP_DIRS` only prunes by name
 * at each level — and turned a byte check into a minutes-long crawl.
 *
 * These were demonstrably unscanned before: `package.json`, `tsconfig.json`,
 * `README.md` and the rest of the root are the files most likely to be edited
 * by a script doing string surgery, which is the exact origin story this guard
 * was written for.
 */
function topLevelFiles(dir) {
  const acc = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    // Directories at the root are covered by SCAN_ROOTS, or deliberately not
    // covered at all. Either way they are not this function's business.
    if (st.isDirectory()) continue;
    if (SCANNED_EXT.test(entry)) acc.push(full);
  }
  return acc;
}

/** Line and column of the first NUL, so the report points somewhere useful. */
function locate(buffer) {
  const index = buffer.indexOf(0x00);
  if (index === -1) return null;

  const before = buffer.subarray(0, index).toString('utf-8');
  const lines = before.split('\n');
  return { index, line: lines.length, column: (lines[lines.length - 1] ?? '').length + 1 };
}

/**
 * Scan `rootDir` for NUL bytes in text sources.
 *
 * Exported so the self-test can reach the failure sites (#455). Before this the
 * guard was top-level statements ending in `process.exit`, so none of its four
 * failure paths could be executed by a test.
 *
 * @param {string} rootDir - tree to scan.
 * @param {object} [options]
 * @param {boolean} [options.requireRoots=false] - turn a missing REQUIRED scan
 *   root from a warning into a failure (#121).
 *
 *   Off by default, and the default is not laziness. Pointed at a synthetic
 *   directory — which is exactly what this guard's own tests do — demanding the
 *   full repository layout would mean every fixture had to mock up four
 *   directories to test one byte. That conflates "scan this tree" with "verify
 *   this is the repository", which are different jobs.
 *
 *   CI passes the flag, because there the tree really is the repository and a
 *   missing root really does mean coverage was lost.
 * @param {(path: string) => Buffer} [options.readFile=readFileSync] - injectable
 *   reader. The unreadable-file branch is otherwise unwitnessable: provoking a
 *   real read error needs `chmod 000`, which is a no-op when the test runs as
 *   root and would make the witness silently vacuous on exactly the CI images
 *   most likely to run it. Injecting the failure keeps the branch under test
 *   deterministically — #349's fixture-parameter technique.
 * @returns {{code: number, message: string, offenders: object[], missingRoots: object[], scanned: number}}
 */
export function check(rootDir = '.', options = {}) {
  const { requireRoots = false, readFile = readFileSync } = options;
  const repoRoot = resolve(rootDir);
  const out = [];

  const files = topLevelFiles(repoRoot);
  const missingRoots = [];
  for (const root of SCAN_ROOTS) {
    const full = join(repoRoot, root.path);
    if (existsSync(full)) walk(full, files);
    else missingRoots.push(root);
  }

  // Each failure path below writes its own `code: 1` rather than routing through
  // a shared `fail()` helper. That is deliberate and costs a little repetition:
  // the mutation audit neutralises a literal, so one shared helper would make
  // three distinct failure paths share ONE mutation point, and the audit could
  // no longer show that each is independently witnessed. Per-site witnessing is
  // the whole subject of #431 — granularity wins over DRY here.
  const failure = (message) => ({
    message: [...out, message].join('\n'),
    offenders: [],
    missingRoots,
    scanned: files.length,
  });

  // A missing root is reported BEFORE anything else, because it is the one
  // failure that makes every number below it a smaller truth than it appears:
  // the guard would go on cheerfully reporting how many files it scanned without
  // mentioning the ones it no longer can.
  if (missingRoots.length > 0) {
    out.push('\nDeclared scan roots that do not exist:\n');
    for (const root of missingRoots) {
      const why = root.required ? 'REQUIRED' : `optional — ${root.note ?? 'absence is expected'}`;
      out.push(`  ${root.path}/  (${why})`);
    }

    const missingRequired = missingRoots.filter((r) => r.required);
    if (missingRequired.length > 0 && requireRoots) {
      return { code: 1, ...failure(`
A required scan root is missing, so this guard is no longer looking at code it
is supposed to cover. It has NOT reported success on the remainder, because a
guard that silently narrows its own scope is the failure it exists to prevent.

If the directory was renamed or removed on purpose, update SCAN_ROOTS in this
file so the declaration matches the repository again.

::error::${missingRequired.length} required scan root(s) missing: ${missingRequired
        .map((r) => r.path)
        .join(', ')}.`) };
    }

    // Only reachable when nothing missing was required, so say that rather than
    // implying the run was lenient about something it would have failed on.
    out.push(
      requireRoots
        ? '  (none of these are required, so the scan continues)\n'
        : '  (warning only — pass --require-roots to make missing REQUIRED roots fatal)\n',
    );
  }

  // Reporting success on a scan that examined nothing is the failure mode that
  // would make this guard worthless while looking healthy — the same reasoning as
  // the network-import guard's empty-scan check.
  if (files.length === 0) {
    out.push(`No source files found under ${repoRoot}.`);
    return { code: 1, ...failure('Refusing to report success on a scan that examined nothing.') };
  }

  const offenders = [];
  for (const file of files) {
    let buffer;
    try {
      buffer = readFile(file);
    } catch (err) {
      return { code: 1, ...failure(`Could not read ${relative(repoRoot, file)}: ${err.message}`) };
    }

    const found = locate(buffer);
    if (found !== null) {
      offenders.push({ file: relative(repoRoot, file).split(sep).join('/'), ...found });
    }
  }

  out.push(`Scanned ${files.length} source file(s) for NUL bytes.`);

  if (offenders.length > 0) {
    out.push('\nNUL bytes in source:\n');
    for (const o of offenders) {
      out.push(`  ${o.file}:${o.line}:${o.column} (byte offset ${o.index})`);
    }
    return {
      code: 1,
      offenders,
      missingRoots,
      scanned: files.length,
      message: [
        ...out,
        `
A NUL byte never belongs in a text source file. It is almost always corruption
from a tool that did string surgery on bytes it did not understand — a patch, a
merge, or a script.

Note that tsc, jest and the other guards all PASS with a NUL present: they read
source as decoded text, where a stray NUL inside a string literal is just
another character. That is why this check exists at the byte level.

::error::${offenders.length} file(s) contain a NUL byte.`,
      ].join('\n'),
    };
  }

  out.push('\nNo NUL bytes found.');
  return { code: 0, message: out.join('\n'), offenders, missingRoots, scanned: files.length };
}

if (isProcessEntryPoint(import.meta.url)) {
  const args = process.argv.slice(2);
  const result = check(args.find((a) => !a.startsWith('--')) ?? '.', {
    requireRoots: args.includes('--require-roots'),
  });
  if (result.code === 0) console.log(result.message);
  else console.error(result.message);
  process.exit(result.code);
}
