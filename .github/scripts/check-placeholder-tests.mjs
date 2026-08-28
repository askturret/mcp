#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Flags tests that run but verify nothing.
 *
 * The companion check (check-test-execution.mjs) proves a suite executes. This
 * one asks the next question: did anything get asserted? Issue #79's second
 * failure mode is a test that passes because it cannot fail —
 * `expect(true).toBe(true)`, or a body with no assertion at all. Two shipped
 * defects this session reached final QA behind exactly that.
 *
 * Usage:
 *   node .github/scripts/check-placeholder-tests.mjs [rootDir]
 *
 * Errors (exit 1):
 *   - a test body containing no `expect(` at all
 *   - a tautological assertion: expect(<literal>).toBe(<same literal>)
 *   - `.only` on describe/it/test, which silently disables every other test
 *
 * Warnings (reported, do not fail):
 *   - `.skip`, which hides a test without deleting it
 *   - a body whose only assertions are toBeDefined/toBeTruthy — weak, but
 *     sometimes legitimate, so it is the founder's call (#79 scope note)
 *
 * ## A declaration is not a method call (#328)
 *
 * Every pattern below opens with `(?<![.\w$])` rather than `\b`. That is not
 * stylistic: `\b` matches the boundary between `.` and `t`, so in
 * `regex.test('x')` the guard saw a test declaration whose body asserts
 * nothing, and failed the build. Three false failures on one PR's self-test —
 * and the author worked around it by renaming their own helper, which is the
 * worst outcome available: the guard shaped the code instead of checking it.
 *
 * The rule is general — **preceded by a dot means method call** — and NOT a
 * special case for `regex.test`. Naming one method leaves the next `foo.test(`
 * broken, and the next author with no clue why.
 *
 * `$` and `\w` are in the class for the same reason: `my$test(` and `submit(`
 * are identifiers that happen to end in a declaration keyword.
 *
 * **This does not weaken `.only` detection**, which is the sharpest check here
 * — `.only` silently disables every other test in the file. Its dot comes
 * AFTER the keyword (`test.only(`), so the lookbehind never sees it; what is
 * now excluded is `promise.test.only(`, a method chain that was never a
 * declaration. A careless "reject anything involving a dot" fix WOULD break it,
 * so the self-test asserts both directions explicitly.
 *
 * Known and accepted: `foo. test(` (whitespace between the dot and the keyword)
 * still parses as a declaration. Fixing it needs a variable-length lookbehind,
 * which would then suppress a REAL declaration after any line ending in a word
 * character — `let x = 5` followed by `it('...')`. A false negative in the
 * checker is the dangerous direction, so the fixed-length form stays.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

import { isProcessEntryPoint } from './lib/entry-point.mjs';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

/**
 * Blank out comments and string contents, preserving offsets and newlines.
 *
 * Without this the checker would flag its own documentation, and any test whose
 * comment quotes a tautology — which is precisely how a linter earns a reputation
 * for crying wolf and gets switched off.
 */
function blankCommentsAndStrings(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j++;
      }
      // Keep the quotes, blank the contents, so `it('title', ...)` still parses
      // as a call but the title text cannot match anything.
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Collect every *.test.ts / *.test.mjs under root, skipping build output. */
function testFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      testFiles(join(dir, entry.name), acc);
    } else if (/\.test\.(ts|mts|mjs|js)$/.test(entry.name)) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

/** Extract `{ ... }` starting at the first brace at or after `from`. */
function extractBody(src, from) {
  const start = src.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return { start, end: i, text: src.slice(start, i + 1) };
    }
  }
  return null;
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/**
 * Scan `rootDir` for tests that cannot fail.
 *
 * Exported so the self-test can reach the failure sites (#455). Before this the
 * whole guard was top-level statements ending in `process.exit`, so there was
 * nothing a test could call and no way to redden any of its three error paths.
 *
 * @returns {{code: number, errors: object[], warnings: object[], message: string}}
 *   `code` is 1 when any error was found, matching the exit code CI reads.
 */
export function check(rootDir = '.') {
  const repoRoot = resolve(rootDir);
  const errors = [];
  const warnings = [];

  for (const file of testFiles(repoRoot)) {
    if (statSync(file).isDirectory()) continue;
    const raw = readFileSync(file, 'utf-8');
    const src = blankCommentsAndStrings(raw);
    const rel = relative(repoRoot, file);

    // `.only` disables every other test in the file — the loudest possible way
    // for tests to silently stop running.
    for (const m of src.matchAll(/(?<![.\w$])(describe|it|test)\.only\s*\(/g)) {
      errors.push({
        file: rel,
        line: lineOf(src, m.index),
        message: `${m[1]}.only() disables every other test in this file`,
      });
    }

    for (const m of src.matchAll(/(?<![.\w$])(it|test)\.skip\s*\(/g)) {
      warnings.push({
        file: rel,
        line: lineOf(src, m.index),
        message: `${m[1]}.skip() — hidden test; confirm it is still needed`,
      });
    }

    // Test declarations: it('...', fn) / test('...', fn), including .each/.failing.
    for (const m of src.matchAll(/(?<![.\w$])(it|test)(?:\.\w+)?\s*\(\s*['"`]/g)) {
      if (/\.(skip|todo)\s*\($/.test(m[0])) continue;

      const body = extractBody(src, m.index + m[0].length);
      if (!body) continue;

      const line = lineOf(src, m.index);
      const text = body.text;

      const tautology = text.match(
        /expect\(\s*(true|false|null|undefined|-?\d+(?:\.\d+)?)\s*\)\s*\.\s*(?:to(?:Be|Equal|StrictEqual))\(\s*\1\s*\)/,
      );
      if (tautology) {
        errors.push({
          file: rel,
          line: line + lineOf(text, tautology.index) - 1,
          message: `assertion cannot fail: ${tautology[0].replace(/\s+/g, '')}`,
        });
        continue;
      }

      if (!/\bexpect\s*\(/.test(text)) {
        // A body that awaits something and asserts nothing still passes when the
        // thing it exercises is broken.
        errors.push({ file: rel, line, message: 'test body contains no assertion' });
        continue;
      }

      const assertions = [...text.matchAll(/\.\s*(to[A-Z]\w*)\s*\(/g)].map((a) => a[1]);
      const weak = new Set(['toBeDefined', 'toBeTruthy']);
      if (assertions.length > 0 && assertions.every((a) => weak.has(a))) {
        warnings.push({
          file: rel,
          line,
          message: `only weak assertions (${[...new Set(assertions)].join(', ')})`,
        });
      }
    }
  }

  const lines = [];
  for (const w of warnings) lines.push(`  warn  ${w.file}:${w.line}  ${w.message}`);
  for (const e of errors) lines.push(`  FAIL  ${e.file}:${e.line}  ${e.message}`);
  lines.push(`\n${errors.length} error(s), ${warnings.length} warning(s).`);

  return { code: errors.length > 0 ? 1 : 0, errors, warnings, message: lines.join('\n') };
}

/**
 * The text CI shows when this guard fails. Exported so the self-test asserts on
 * the same string the workflow annotation carries, rather than a paraphrase of
 * it that is free to drift.
 */
export const FAILURE_ANNOTATION =
  '::error::Found tests that cannot fail. A test that asserts nothing is worse than no ' +
  'test: it reports coverage that does not exist, and it is why two defects reached final ' +
  'QA in this repository.';

if (isProcessEntryPoint(import.meta.url)) {
  const result = check(process.argv[2] ?? '.');
  console.log(result.message);
  if (result.code !== 0) {
    console.error(`\n${FAILURE_ANNOTATION}`);
    process.exit(result.code);
  }
}
