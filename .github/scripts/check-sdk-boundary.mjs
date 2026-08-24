#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The MCP SDK stays behind the transport boundary (#61, §12.3, §17 criterion 11).
 *
 * §17's criterion is: *"An MCP SDK upgrade can be completed inside the transport
 * boundary without changes to operation definitions."* That is a property of the
 * dependency graph, and it silently stops being true the first time some other
 * package imports the SDK "just for a type".
 *
 * Two checks, because there are two ways to breach it and only one of them
 * looks like an import.
 *
 * ## 1. Source imports
 *
 * `@modelcontextprotocol/sdk` may be imported ONLY from `packages/transports/src/`.
 * Zero exceptions — §61 says so, and there is deliberately no allowlist file for
 * this one. An allowlist is the mechanism by which a boundary becomes a
 * suggestion: the first exception is always justified, and it is the entry that
 * makes the second one arguable.
 *
 * Static `import`, `import type`, dynamic `import()` and `require()` are all
 * caught. A type-only import is included even though TypeScript erases it,
 * because the criterion is about whether an SDK CHANGE forces a diff — and a
 * renamed SDK type breaks a type-only import exactly as hard as a value one.
 *
 * ## 2. Public type leakage
 *
 * The subtler breach: a package re-exports something whose TYPE mentions an SDK
 * type. Nothing imports the SDK by name, the source looks clean, and yet an
 * adopter's build now depends on the SDK's shape — so an SDK upgrade breaks
 * THEM, which is the whole failure §12.3 exists to prevent.
 *
 * This is invisible in source and unmissable in the emitted `.d.ts`, so that is
 * what gets scanned. It requires a build: without `dist/` the check reports that
 * it could not run rather than passing, because a leak check that silently
 * skips is worse than none — it produces a green tick for an unexamined surface.
 *
 * Usage: node .github/scripts/check-sdk-boundary.mjs [repoDir]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SDK = '@modelcontextprotocol/sdk';

/** The one place the SDK may be imported from. */
const ALLOWED_PREFIX = 'packages/transports/src/';

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'build']);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function walk(root, dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(root, full, predicate, out);
    } else {
      const rel = relative(root, full).split(sep).join('/');
      if (predicate(rel)) out.push(rel);
    }
  }
  return out;
}

/**
 * Every way a module can reach the SDK.
 *
 * Matched against the raw text rather than a parsed AST. A parser would be more
 * precise about, say, the SDK name appearing inside a string — and this guard
 * would rather over-report than under-report, because a false positive is a
 * comment reworded in review and a false negative is the boundary gone.
 */
const REFERENCE_PATTERNS = [
  { kind: 'static import', re: /^\s*import\s[^;]*?from\s*['"]@modelcontextprotocol\/sdk[^'"]*['"]/gm },
  { kind: 'bare import', re: /^\s*import\s*['"]@modelcontextprotocol\/sdk[^'"]*['"]/gm },
  { kind: 'export-from', re: /^\s*export\s[^;]*?from\s*['"]@modelcontextprotocol\/sdk[^'"]*['"]/gm },
  { kind: 'dynamic import()', re: /\bimport\s*\(\s*['"]@modelcontextprotocol\/sdk[^'"]*['"]\s*\)/g },
  { kind: 'require()', re: /\brequire\s*\(\s*['"]@modelcontextprotocol\/sdk[^'"]*['"]\s*\)/g },
];

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Remove comments, preserving line count.
 *
 * A type leak lives in CODE, not in prose. Without this, the boundary's own
 * documentation trips the check: the transport's file header names the SDK to
 * explain the rule, TypeScript copies that header into the emitted `.d.ts`, and
 * the guard reports the sentence describing the boundary as a breach of it.
 *
 * That was not hypothetical — it is what the first run of this guard did, and
 * it is the failure mode worth avoiding above all others here. A guard that
 * fires on its own documentation gets muted, and a muted guard is indis-
 * tinguishable from an absent one.
 *
 * Newlines are kept so reported line numbers still point at the real line.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

export function check(repoDir = '.') {
  const root = resolve(repoDir);
  const problems = [];
  const notes = [];

  // ---- 1. source imports --------------------------------------------------
  const sources = walk(root, join(root, 'packages'), (rel) => SOURCE_EXT.test(rel) && !rel.includes('/dist/'));

  let allowedReferences = 0;
  for (const rel of sources) {
    const raw = readFileSync(join(root, rel), 'utf-8');
    if (!raw.includes(SDK)) continue;
    // Comments stripped for the same reason as the .d.ts scan below: this
    // file's own header explains the boundary by naming the SDK.
    const text = stripComments(raw);

    for (const { kind, re } of REFERENCE_PATTERNS) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        if (rel.startsWith(ALLOWED_PREFIX)) {
          allowedReferences += 1;
          continue;
        }
        problems.push(
          `  ${rel}:${String(lineOf(text, match.index))} — ${kind} of ${SDK}\n` +
            `      Only ${ALLOWED_PREFIX} may import the SDK. Re-model what you need in\n` +
            `      the canonical model and translate at the transport boundary.`,
        );
      }
    }
  }

  // The happy path must be a real assertion, not a vacuous one. Zero references
  // ANYWHERE would pass every test above while meaning the boundary has no
  // subject — a repository that dropped the dependency looks identical to one
  // that guards it correctly.
  if (allowedReferences === 0) {
    problems.push(
      `  No reference to ${SDK} exists anywhere under packages/.\n` +
        `      This guard cannot distinguish "the boundary holds" from "there is no\n` +
        `      boundary left to hold". If the dependency was removed on purpose,\n` +
        `      remove this guard in the same change and say so.`,
    );
  } else {
    notes.push(`${String(allowedReferences)} SDK reference(s), all inside ${ALLOWED_PREFIX}`);
  }

  // ---- 2. public type leakage --------------------------------------------
  const declarations = walk(root, join(root, 'packages'), (rel) => rel.endsWith('.d.ts') && rel.includes('/dist/'));

  if (declarations.length === 0) {
    return {
      code: 2,
      message:
        `Found no emitted .d.ts files under packages/*/dist/, so the public-type\n` +
        `leak check DID NOT RUN. Build first (\`npm run build\`) and retry.\n\n` +
        `Reported rather than passed: a leak check that silently skips produces a\n` +
        `green tick for a surface nobody examined.`,
    };
  }

  let leaks = 0;
  for (const rel of declarations) {
    const raw = readFileSync(join(root, rel), 'utf-8');
    if (!raw.includes(SDK)) continue;
    if (!stripComments(raw).includes(SDK)) continue; // documentation, not a type
    leaks += 1;
    problems.push(
      `  ${rel} — a published type declaration references ${SDK}\n` +
        `      An SDK type has reached the public surface. Adopters now compile\n` +
        `      against the SDK's shape, so an SDK upgrade breaks THEM — which is\n` +
        `      exactly what §12.3's boundary exists to prevent.`,
    );
  }
  if (leaks === 0) {
    notes.push(`${String(declarations.length)} emitted .d.ts file(s), none referencing the SDK`);
  }

  if (problems.length > 0) {
    return { code: 1, message: `MCP SDK boundary violations:\n\n${problems.join('\n')}` };
  }

  return { code: 0, message: `SDK boundary intact — ${notes.join('; ')}.` };
}

function isProcessEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isProcessEntryPoint()) {
  const result = check(process.argv[2] ?? '.');
  if (result.code === 0) {
    console.log(result.message);
  } else {
    console.error(`\n${result.message}\n`);
    console.error(`::error::MCP SDK escaped the transport boundary.`);
  }
  process.exit(result.code);
}
