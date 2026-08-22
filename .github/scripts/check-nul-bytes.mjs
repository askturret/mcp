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
 *   node .github/scripts/check-nul-bytes.mjs [rootDir]
 *
 * Errors (exit 1):
 *   - any scanned file containing a 0x00 byte
 *   - a scan that examined no files at all (see below)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? '.');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

/**
 * Text formats where a NUL is unambiguously corruption.
 *
 * Deliberately does NOT include every extension in the repo: images, archives
 * and lockfile-adjacent binaries legitimately contain NUL bytes, and a guard
 * that flags them would be turned off within a day.
 */
const SCANNED_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|yml|yaml)$/;

/** Roots worth scanning. Anything outside these is not ours to police. */
const SCAN_ROOTS = ['packages', 'examples', 'docs', '.github', 'scripts'];

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

/** Line and column of the first NUL, so the report points somewhere useful. */
function locate(buffer) {
  const index = buffer.indexOf(0x00);
  if (index === -1) return null;

  const before = buffer.subarray(0, index).toString('utf-8');
  const lines = before.split('\n');
  return { index, line: lines.length, column: (lines[lines.length - 1] ?? '').length + 1 };
}

const files = [];
for (const root of SCAN_ROOTS) {
  const full = join(repoRoot, root);
  if (existsSync(full)) walk(full, files);
}

// Reporting success on a scan that examined nothing is the failure mode that
// would make this guard worthless while looking healthy — the same reasoning as
// the network-import guard's empty-scan check.
if (files.length === 0) {
  console.error(`No source files found under ${repoRoot}.`);
  console.error('Refusing to report success on a scan that examined nothing.');
  process.exit(1);
}

const offenders = [];
for (const file of files) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch (err) {
    console.error(`Could not read ${relative(repoRoot, file)}: ${err.message}`);
    process.exit(1);
  }

  const found = locate(buffer);
  if (found !== null) {
    offenders.push({ file: relative(repoRoot, file).split(sep).join('/'), ...found });
  }
}

console.log(`Scanned ${files.length} source file(s) for NUL bytes.`);

if (offenders.length > 0) {
  console.error('\nNUL bytes in source:\n');
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}:${o.column} (byte offset ${o.index})`);
  }
  console.error(`
A NUL byte never belongs in a text source file. It is almost always corruption
from a tool that did string surgery on bytes it did not understand — a patch, a
merge, or a script.

Note that tsc, jest and the other guards all PASS with a NUL present: they read
source as decoded text, where a stray NUL inside a string literal is just
another character. That is why this check exists at the byte level.

::error::${offenders.length} file(s) contain a NUL byte.`);
  process.exit(1);
}

console.log('\nNo NUL bytes found.');
process.exit(0);
