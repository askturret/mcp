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
 *
 * NOT SCANNED AT ALL:
 *   Anything outside `packages/<pkg>/src`. The scan roots are built by joining
 *   `src` onto each entry of `packages/`, so a file in `packages/<pkg>/bench/`,
 *   in `scripts/`, or at a package root is never read — it does not pass the
 *   guard, it never meets it.
 *   Stated explicitly because an earlier comment here claimed the opposite, and
 *   because `packages/gateway/bench/` deliberately relies on it (#197). Widening
 *   the roots is a real option; assuming they are already wide is not.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

import { isProcessEntryPoint } from './lib/entry-point.mjs';

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
 * Each entry is matched as a substring of the repo-relative POSIX path.
 *
 * PREFER A FILE. A directory entry exempts every file added under it later,
 * including ones nobody weighed against this promise — so a NEW file that starts
 * making calls should be flagged even when it sits beside one that legitimately
 * does. Each file below names something whose ENTIRE PURPOSE is to make a call
 * the adopter asked for.
 *
 * The directory entries that remain are packages where the network surface IS
 * the package — the transports, the Express adapter, and the conformance bank
 * that speaks to a loopback server it started itself. Each is argued at its own
 * entry. `packages/gateway/src/` used to be on that list and was narrowed to one
 * file in #181, because the gateway is an ordinary package that happens to
 * listen, not a package that exists to carry traffic.
 *
 * Adding to this list widens the promise in docs/telemetry-policy.md. Argue for
 * it in the pull request that does it.
 */
const ALLOWLIST = [
  // The HTTP executor. Calls the adopter's own API, with the adopter's config.
  'packages/core/src/executor/via-http.ts',
  'packages/core/src/executor/http-request.ts',

  // The HTTP audit sink (#48). POSTs to a collector URL the adopter supplied;
  // the sink does not exist until they construct it with that URL, so it
  // cannot produce traffic nobody asked for. Same category as via-http above.
  // Listed as a single FILE rather than a directory so anything else added
  // under src/audit/ still trips this guard.
  'packages/core/src/audit/sinks/http.ts',

  // MCP transports: serve the adopter's own clients.
  'packages/transports/src/',

  // Framework adapters: mounted into the adopter's own server.
  'packages/adapters-express/src/',

  // The standalone gateway (#57, §11.3). It IS a server the operator chose to
  // run: `node:http` here is `createServer` — an inbound listener on a port the
  // operator named on the command line — not an outbound call.
  //
  // Same category as `packages/transports/src/` above, and for the same reason.
  // The promise in docs/telemetry-policy.md is that this project makes no
  // outbound call the adopter did not configure, and ACCEPTING a connection is
  // not MAKING one. The gateway's only outbound traffic goes to `--upstream`,
  // and it reaches there through core's already-allowlisted `via-http.ts` —
  // nothing in this package opens a client socket.
  //
  // A single FILE, matching `sinks/http.ts` above (#181). This was `src/` until
  // QA demonstrated the cost: an outbound `node:https` call appended to
  // `src/version.ts` passed the guard silently, because the whole directory was
  // exempt. The directory form was chosen so the entry would not need revisiting
  // if the listeners were split across files — but revisiting it is precisely
  // when this reasoning should be re-checked, which is the argument the
  // `sinks/http.ts` comment already makes. Of all the packages to hold a
  // directory-wide exemption, the one that is itself a long-running network
  // process is the worst candidate.
  //
  // If a listener genuinely moves to a second file, add that file here. That is
  // a one-line diff a reviewer stops on, which is the entire point.
  'packages/gateway/src/server.ts',

  // CLI commands that fetch a URL the user typed on the command line. The user
  // supplying the address IS the opt-in.
  'packages/cli/src/commands/doctor.ts',
  'packages/cli/src/commands/inspect.ts',
  // `diff --before https://…` fetches a published snapshot to compare against
  // (#40). Same category as the two above, for the same reason: the fetch runs
  // ONLY when the user passes an http(s) URL, and never for a file path, so
  // the address the user typed is itself the opt-in.
  'packages/cli/src/commands/diff.ts',
  // `diagnostics --url …` snapshots a running server the user named (#50).
  // Same category again, and if anything narrower: without `--url` the command
  // makes no request at all, and the bundle it produces is written to disk for
  // the operator to ship themselves. §13 is explicit that this tool does not
  // call home, and the only address it ever contacts is the one typed on the
  // command line.
  'packages/cli/src/commands/diagnostics.ts',

  // The adapter conformance bank (#42). It starts a server on 127.0.0.1 and
  // then speaks JSON-RPC to it, which is the whole design: the suite proves
  // Express and Fastify behave identically AT THE WIRE, and it cannot do that
  // by importing them.
  //
  // A weaker entry than the CLI ones above, not a stronger one: this package
  // is `private: true`, is never published, ships in nothing an adopter
  // installs, and its requests go only to a loopback port it opened itself.
  // There is no user-supplied address involved at all.
  'packages/adapter-conformance/src/',
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

/**
 * Scan `rootDir` for network access outside the allowlist.
 *
 * Exported so the self-test can reach the failure sites (#455). Before this the
 * guard was top-level statements ending in `process.exit`, so none of its four
 * failure paths could be executed by a test.
 *
 * @param {string} rootDir - tree to scan.
 * @param {object} [options]
 * @param {(path: string, enc: string) => string} [options.readFile=readFileSync]
 *   injectable reader. The unreadable-file branch is otherwise unwitnessable:
 *   provoking a real read error needs `chmod 000`, which is a no-op as root and
 *   would make the witness silently vacuous on exactly the CI images most
 *   likely to run it (#349's fixture-parameter technique).
 * @returns {{code: number, message: string, violations: object[], notes: object[], filesScanned: number}}
 */
export function check(rootDir = '.', options = {}) {
  const { readFile = readFileSync } = options;
  const repoRoot = resolve(rootDir);

  const empty = { violations: [], notes: [], filesScanned: 0 };

  const packagesDir = join(repoRoot, 'packages');
  if (!existsSync(packagesDir)) {
    return {
      ...empty,
      code: 1,
      message:
        `No packages/ directory under ${repoRoot} — nothing to check.\n` +
        'If the layout moved, this guard needs updating, not deleting.',
    };
  }

  const srcRoots = readdirSync(packagesDir)
    .map((pkg) => join(packagesDir, pkg, 'src'))
    .filter((p) => existsSync(p));

  if (srcRoots.length === 0) {
    return {
      ...empty,
      code: 1,
      message:
        'Found packages/ but no packages/*/src directories.\n' +
        'Refusing to report success on a scan that examined nothing.',
    };
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
        contents = readFile(file, 'utf-8');
      } catch (err) {
        return { ...empty, code: 1, message: `Could not read ${relPosix}: ${err.message}` };
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

  const out = [
    `Scanned ${filesScanned} source file(s) across ${srcRoots.length} package(s); ` +
      `skipped ${testFilesSkipped} test file(s).`,
  ];
  for (const n of notes) {
    out.push(`  note - ${n.file}:${n.line} ${n.what} (${n.why})`);
  }

  if (violations.length > 0) {
    violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    out.push('\nNetwork access outside the allowlist:\n');
    for (const v of violations) {
      out.push(`  ${v.file}:${v.line} — ${v.what}`);
      out.push(`      ${v.statement}`);
    }
    out.push(`
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
    return { code: 1, violations, notes, filesScanned, message: out.join('\n') };
  }

  out.push(`\nNo network access outside the allowlist. ${notes.length} type-only import(s) noted.`);
  return { code: 0, violations, notes, filesScanned, message: out.join('\n') };
}

if (isProcessEntryPoint(import.meta.url)) {
  const result = check(process.argv[2] ?? '.');
  if (result.code === 0) console.log(result.message);
  else console.error(result.message);
  process.exit(result.code);
}
