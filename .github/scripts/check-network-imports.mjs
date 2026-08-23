#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Fails the build when package source reaches for the network outside the few
 * files whose job is to make calls the adopter asked for.
 *
 * docs/telemetry-policy.md promises zero telemetry by default: no outbound call
 * unless the adopter configured one. That promise is easy to make and easy to
 * break by accident — a convenience call in a compiler pass, a "just ping the
 * registry" helper, an update-check somebody copied from another project. None
 * of those arrive as a decision; they arrive as a small diff nobody reads
 * closely.
 *
 * This guard does not make network access impossible. It makes it VISIBLE: to
 * add one you must either put it in an allowlisted file, or edit the allowlist
 * below — and editing the allowlist is a diff a reviewer stops on. Silent
 * telemetry stops being something that can happen by inattention.
 *
 * WHY THIS CHECKS BARE `fetch` AND NOT JUST IMPORTS
 * -------------------------------------------------
 * #26 asked for an import guard. On this codebase an import-only guard would
 * pass while catching nothing that matters: there is not one network-module
 * import in shipping source. Every real egress point — the HTTP executor and
 * four CLI call sites — uses the GLOBAL `fetch`, which needs no import at all.
 * A guard that greenlights the exact mechanism the codebase actually uses is
 * decoration. So both are checked, and `fetch` is the load-bearing half.
 *
 * Usage:
 *   node .github/scripts/check-network-imports.mjs [rootDir]
 *
 * Errors (exit 1):
 *   - a runtime import/require of a network-capable module, or a call to global
 *     `fetch`, in packages/<pkg>/src from a file outside ALLOWLIST
 *
 * Reported, do not fail:
 *   - type-only imports (`import type ... from 'http'`). TypeScript erases them,
 *     so they cannot open a socket. Failing them would be theatre.
 *   - test files. They never ship to an adopter. Skipped deliberately, and
 *     counted in the summary so the exclusion is visible rather than assumed.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? '.');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Modules that can open a connection.
 *
 * Node builtins appear with and without the `node:` prefix because both resolve
 * to the same module and only one of the two looks suspicious to a reader.
 */
const NETWORK_MODULES = new Set([
  'http', 'node:http',
  'https', 'node:https',
  'http2', 'node:http2',
  'net', 'node:net',
  'tls', 'node:tls',
  'dgram', 'node:dgram',
  'undici',
  'node-fetch',
  'axios',
  'got',
  'superagent',
  'request',
  'phin',
  'needle',
]);

/**
 * Files permitted to reach the network.
 *
 * Each entry is matched as a substring of the repo-relative POSIX path, and each
 * is a file whose ENTIRE PURPOSE is to make a call the adopter asked for.
 * Entries are deliberately file-precise rather than directory-wide: a NEW file
 * that starts making calls should be flagged even if it sits beside one that
 * legitimately does.
 *
 * Adding to this list widens the promise in docs/telemetry-policy.md. Argue for
 * it in the pull request that does it.
 */
const ALLOWLIST = [
  // The HTTP executor. Calls the adopter's own API, with the adopter's config.
  'packages/core/src/executor/via-http.ts',
  'packages/core/src/executor/http-request.ts',

  // MCP transports: serve the adopter's own clients.
  'packages/transports/src/',

  // Framework adapters: mounted into the adopter's own server.
  'packages/adapters-express/src/',

  // CLI commands that fetch a URL the user typed on the command line. The user
  // supplying the address IS the opt-in.
  'packages/cli/src/commands/doctor.ts',
  'packages/cli/src/commands/inspect.ts',
  // `diff --before https://…` fetches a published snapshot to compare against
  // (#40). Same category as the two above, for the same reason: the fetch runs
  // ONLY when the user passes an http(s) URL, and never for a file path, so
  // the address the user typed is itself the opt-in.
  'packages/cli/src/commands/diff.ts',
];

const isAllowlisted = (relPosix) => ALLOWLIST.some((frag) => relPosix.includes(frag));

const isTestFile = (relPosix) =>
  /(^|\/)__tests__\//.test(relPosix) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(relPosix) ||
  /(^|\/)(tests|__mocks__|fixtures)\//.test(relPosix);

/**
 * Blank comments, and optionally string/template contents, preserving offsets
 * and newlines so reported line numbers stay accurate.
 *
 * The two callers need different things, which is the whole reason for the flag:
 *
 *   - Import scanning needs string CONTENTS KEPT. An import specifier is a
 *     string; blanking it would blind the guard to the one thing it reads.
 *   - `fetch` scanning needs strings BLANKED. packages/explorer/src/html.ts
 *     emits browser JavaScript inside a template literal, and that browser code
 *     calls fetch. It runs in the user's browser against the adopter's own
 *     server — it is not egress from the Node process, and flagging it would be
 *     a false positive that teaches everyone to ignore this guard.
 *
 * Comments are blanked for both: a source file noting "we deliberately avoid
 * node-fetch here" must not trip the check that enforces exactly that.
 */
function blank(src, { blankStrings }) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const wipe = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      wipe(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      wipe(i, Math.min(j + 2, n));
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
      if (blankStrings) wipe(i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
      continue;
    }
    i++;
  }
  return out.join('');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const firstLine = (s) => s.split('\n')[0].trim();

/** Every import/require/export-from specifier, with line number and type-only flag. */
function findSpecifiers(src) {
  const cleaned = blank(src, { blankStrings: false });
  const hits = [];

  // The `middle` of an import/export statement — everything between the keyword
  // and `from` — must NOT be allowed to span statements. `[\s\S]*?` looks
  // harmless and is not: it will happily run from an `export interface Foo {`
  // hundreds of lines earlier to the first `from '...'` it can reach, reporting
  // a real import at a wrong, unrelated line. Excluding `;` and quotes bounds
  // the match to a single statement while still permitting multi-line braces.
  const MIDDLE = "[^;'\"]*?";
  const patterns = [
    { re: new RegExp(`\\bimport\\s+(type\\s+)?(?:${MIDDLE}\\bfrom\\s*)?['"]([^'"]+)['"]`, 'g'), spec: 2, typeGroup: 1 },
    { re: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, spec: 1, typeGroup: null },
    { re: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, spec: 1, typeGroup: null },
    { re: new RegExp(`\\bexport\\s+(type\\s+)?${MIDDLE}\\bfrom\\s*['"]([^'"]+)['"]`, 'g'), spec: 2, typeGroup: 1 },
  ];

  for (const { re, spec, typeGroup } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const specifier = m[spec];
      if (!specifier) continue;
      const statement = m[0];
      // `import { type Foo } from 'x'` erases too — but only when EVERY binding
      // is type-prefixed. `import { createServer, type Server }` is a real
      // runtime import and must not be waved through.
      const braced = statement.match(/\{([^}]*)\}/);
      const allBindingsTyped =
        braced !== null &&
        braced[1].trim().length > 0 &&
        braced[1]
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean)
          .every((b) => /^type\s/.test(b));
      const typeOnly = Boolean(typeGroup && m[typeGroup]) || allBindingsTyped;
      hits.push({ specifier, line: lineOf(cleaned, m.index), typeOnly, statement: firstLine(statement) });
    }
  }
  return hits;
}

/** Calls to the global `fetch`, ignoring property access like `client.fetch(`. */
function findFetchCalls(src) {
  const cleaned = blank(src, { blankStrings: true });
  const hits = [];
  const re = /(^|[^.\w$])fetch\s*\(/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    hits.push({ line: lineOf(cleaned, m.index), statement: firstLine(cleaned.slice(m.index, m.index + 80)) });
  }
  return hits;
}

/** Base module for a specifier, so 'undici/lib/x' and 'node:http' both resolve. */
function baseModule(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

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
    else if (SOURCE_EXT.test(entry)) acc.push(full);
  }
  return acc;
}

// ---------------------------------------------------------------------------

const packagesDir = join(repoRoot, 'packages');
if (!existsSync(packagesDir)) {
  console.error(`No packages/ directory under ${repoRoot} — nothing to check.`);
  console.error('If the layout moved, this guard needs updating, not deleting.');
  process.exit(1);
}

const srcRoots = readdirSync(packagesDir)
  .map((pkg) => join(packagesDir, pkg, 'src'))
  .filter((p) => existsSync(p));

if (srcRoots.length === 0) {
  console.error('Found packages/ but no packages/*/src directories.');
  console.error('Refusing to report success on a scan that examined nothing.');
  process.exit(1);
}

const violations = [];
const notes = [];
let filesScanned = 0;
let testFilesSkipped = 0;

for (const root of srcRoots) {
  for (const file of walk(root)) {
    const relPosix = relative(repoRoot, file).split(sep).join('/');
    if (isTestFile(relPosix)) {
      testFilesSkipped++;
      continue;
    }
    filesScanned++;

    let contents;
    try {
      contents = readFileSync(file, 'utf-8');
    } catch (err) {
      console.error(`Could not read ${relPosix}: ${err.message}`);
      process.exit(1);
    }

    const allowed = isAllowlisted(relPosix);

    for (const hit of findSpecifiers(contents)) {
      const base = baseModule(hit.specifier);
      if (!base || !NETWORK_MODULES.has(base)) continue;
      const record = { file: relPosix, line: hit.line, statement: hit.statement, what: `imports '${base}'` };
      if (hit.typeOnly) notes.push({ ...record, why: 'type-only, erased at compile time' });
      else if (!allowed) violations.push(record);
    }

    if (!allowed) {
      for (const hit of findFetchCalls(contents)) {
        violations.push({
          file: relPosix,
          line: hit.line,
          statement: hit.statement,
          what: 'calls global fetch()',
        });
      }
    }
  }
}

console.log(
  `Scanned ${filesScanned} source file(s) across ${srcRoots.length} package(s); ` +
    `skipped ${testFilesSkipped} test file(s).`,
);
for (const n of notes) {
  console.log(`  note - ${n.file}:${n.line} ${n.what} (${n.why})`);
}

if (violations.length > 0) {
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  console.error('\nNetwork access outside the allowlist:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.what}`);
    console.error(`      ${v.statement}`);
  }
  console.error(`
docs/telemetry-policy.md promises this package makes no outbound network call
unless the adopter configured one. Code here is how that promise gets broken by
accident.

If the call is genuinely on the adopter's behalf, move it into an allowlisted
file, or add the path to ALLOWLIST in
.github/scripts/check-network-imports.mjs and say why in the pull request. That
edit is meant to be noticed.

If you hit this on a type-only import, write it as \`import type { X } from ...\`
so it is erased at compile time — then it is not network access at all.

::error::${violations.length} network access point(s) outside the allowlist.`);
  process.exit(1);
}

console.log(`\nNo network access outside the allowlist. ${notes.length} type-only import(s) noted.`);
process.exit(0);
