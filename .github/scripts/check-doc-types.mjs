#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * A type name in the docs must be a type that exists (#156).
 *
 * ## The failure this catches
 *
 * Four separate issues (#42, #43, #44, #61) each independently discovered that
 * a name in a spec or doc had never existed in the code — `HandlerContext`,
 * `runtime.bulkheads`, `operation.timeout`, `packages/transport-http/`. Each
 * time an engineer paid the same cost: read the doc, fail to find the type,
 * hunt for what was actually meant, and re-derive a substitution that the
 * previous engineer had already derived. #156 then found six more in a single
 * document, including a type (`SourcedValue<T>`) with no referent anywhere.
 *
 * Prose drifts quietly because nothing compiles it. A wrong type name in a
 * `typescript` code fence looks exactly as authoritative as a right one, and
 * the reader who trusts it is the one who pays.
 *
 * ## What is checked
 *
 * **1. Every type named in a documented block resolves.** Any PascalCase
 * identifier in a ```typescript fence must be an exported type somewhere under
 * `packages/<pkg>/src/`, a TypeScript built-in, or a generic parameter the
 * block itself declares.
 *
 * **2. Every documented field of a real interface is a real field.** When a
 * block declares `interface X` and `X` is a real exported interface, every
 * top-level member the doc lists must exist on the real one.
 *
 * ## What is deliberately NOT checked, and why
 *
 * **The reverse direction — real fields missing from the doc.** An overview
 * that abridges a 12-field interface to the 6 that matter is doing its job;
 * failing that would push docs toward being a worse copy of the source. The
 * asymmetry is the point: a doc that OMITS a field is abridged, a doc that
 * NAMES a field that does not exist is wrong. Only the second is a defect.
 *
 * **Method signatures and field types.** Comparing `execute(a, b)` against
 * `execute(a, b, c)` needs a real TypeScript parser; a regex that half-does it
 * would produce false failures on the formatting differences that legitimately
 * separate a doc from its source. Member NAMES are checkable exactly, so that
 * is the line. #156's D3 (a 2-param signature documented for a 3-param method)
 * is therefore only partly covered here — the spurious `type` field is caught,
 * the arity is not. Said plainly rather than left for someone to discover.
 *
 * A block that genuinely defines something new — an example implementation an
 * adopter would write — opts out with a `// doc-types: illustrative` line.
 *
 * Usage: node .github/scripts/check-doc-types.mjs [repoDir]
 */

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

/**
 * Names TypeScript or the platform provides. A doc may use these freely.
 *
 * Kept explicit rather than "any name we cannot find", which would turn every
 * genuine drift into a silent pass — the exact failure mode this guard exists
 * to remove.
 */
const BUILTINS = new Set([
  'Array', 'ReadonlyArray', 'Map', 'ReadonlyMap', 'Set', 'ReadonlySet',
  'WeakMap', 'WeakSet', 'Promise', 'PromiseLike', 'Date', 'RegExp', 'Error',
  'Function', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'JSON', 'Math', 'Record', 'Readonly', 'Partial', 'Required', 'Pick', 'Omit',
  'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters', 'Awaited',
  'Iterable', 'AsyncIterable', 'Iterator', 'AsyncIterator', 'Generator',
  'AbortSignal', 'AbortController', 'URL', 'URLSearchParams', 'Buffer',
  'Uint8Array', 'ArrayBuffer', 'Blob', 'Response', 'Request', 'Headers',
  'JSX', 'NodeJS', 'Console', 'Intl', 'Reflect', 'Proxy',
]);

/**
 * Strip comments, and by default string/template literal bodies too, so scans
 * see code only.
 *
 * `keepStrings` exists for the import scan, which must read the module
 * specifier — the one place where the string content IS the code.
 */
export function stripNonCode(source, { keepStrings = false } = {}) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const quote = source[i];
      const start = i;
      i++;
      while (i < source.length && source[i] !== quote) {
        i += source[i] === '\\' ? 2 : 1;
      }
      i++;
      if (keepStrings) out += source.slice(start, i);
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

/** Every file under a directory tree matching a predicate. */
export function walk(root, predicate, dir = root, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(root, predicate, full, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Body of the brace-delimited block starting at or after `from`.
 * Returns null when the braces never balance (a truncated doc excerpt).
 */
function braceBody(source, from) {
  const open = source.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Top-level member names of an interface body.
 *
 * Depth-tracked so an inline object type (`source: { kind: ... }`) contributes
 * `source` and not `kind` — nesting is where a naive line scan invents fields
 * that no interface ever had.
 */
export function memberNames(body) {
  const names = [];
  let depth = 0;
  let segment = '';

  // A member is whatever precedes its `:` or `(`. Bracketed spans are kept in
  // the segment rather than dropped — dropping them is what makes a method
  // (`execute(...)`) vanish while a plain field survives, and a guard that
  // silently sees no members reports every documented one as spurious.
  const flush = () => {
    const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(<]/.exec(segment.trim());
    if (m) names.push(m[1]);
    segment = '';
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++;
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth--;

    if (depth === 0 && (ch === ';' || ch === ',' || ch === '\n')) flush();
    else segment += ch;
  }
  flush();
  return [...new Set(names)];
}

/**
 * Every member name reachable in a type alias body, unioned across variants.
 *
 * `PolicyDecision` is a discriminated union of three object literals, so no
 * single variant holds every member. The union is the right comparison target:
 * a documented member belonging to SOME variant is documented correctly, and
 * one belonging to none — #156's `reason`, dropped when it became `safeReason`
 * — belongs to nothing and is the defect. Narrowing per-variant would demand
 * the doc pick a variant, which is not how these blocks are written.
 */
export function aliasMembers(source, from) {
  const eq = source.indexOf('=', from);
  if (eq === -1) return null;

  let depth = 0;
  let end = source.length;
  for (let i = eq + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++;
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth--;
    else if (ch === ';' && depth === 0) {
      end = i;
      break;
    }
  }

  const body = source.slice(eq + 1, end);
  const members = new Set();
  let found = false;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '{') continue;
    let d = 0;
    for (let j = i; j < body.length; j++) {
      if (body[j] === '{') d++;
      else if (body[j] === '}') {
        d--;
        if (d === 0) {
          found = true;
          for (const name of memberNames(body.slice(i + 1, j))) members.add(name);
          i = j;
          break;
        }
      }
    }
  }
  // An alias with no object literal (`type X = Readonly<Record<...>>`) has no
  // member vocabulary to compare against. null, not an empty set — the two
  // mean different things and an empty set would reject every documented field.
  return found ? members : null;
}

/**
 * Index every exported type in the workspace: name -> { kind, file, members }.
 *
 * Reads SOURCE, not `dist`. A guard that needs a successful build cannot run
 * when the build is broken, which is exactly when the tree is least trustworthy
 * — the same reasoning as the #39 cardinality guard.
 */
export function indexTypes(root) {
  const index = new Map();
  const pkgRoot = join(root, 'packages');
  if (!existsSync(pkgRoot)) return index;

  for (const pkg of readdirSync(pkgRoot)) {
    if (SKIP_DIRS.has(pkg)) continue;
    const src = join(pkgRoot, pkg, 'src');
    if (!existsSync(src) || !statSync(src).isDirectory()) continue;

    for (const file of walk(src, (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
      const code = stripNonCode(readFileSync(file, 'utf-8'));
      const rel = relative(root, file).split(sep).join('/');

      const decl = /export\s+(?:declare\s+)?(interface|type|class|enum|const enum)\s+([A-Za-z_$][\w$]*)/g;
      let m;
      while ((m = decl.exec(code)) !== null) {
        const [, kind, name] = m;
        const entry = { kind, file: rel, members: null };
        if (kind === 'interface' || kind === 'class') {
          const body = braceBody(code, m.index);
          if (body !== null) entry.members = new Set(memberNames(body));
        } else if (kind === 'type') {
          entry.members = aliasMembers(code, m.index);
        }
        // First declaration wins; a re-export elsewhere must not blank members.
        if (!index.has(name) || index.get(name).members === null) index.set(name, entry);
      }
    }
  }
  return index;
}

/** Every ```typescript / ```ts fenced block in a markdown file. */
export function typescriptBlocks(markdown) {
  const blocks = [];
  const fence = /^```(typescript|ts)\s*$/gm;
  let m;
  while ((m = fence.exec(markdown)) !== null) {
    const start = m.index + m[0].length + 1;
    const end = markdown.indexOf('\n```', start);
    if (end === -1) continue;
    const line = markdown.slice(0, m.index).split('\n').length;
    blocks.push({ code: markdown.slice(start, end), line });
    fence.lastIndex = end;
  }
  return blocks;
}

export function check(repoDir = '.') {
  const root = resolve(repoDir);
  const index = indexTypes(root);

  if (index.size === 0) {
    return {
      code: 2,
      message:
        `Indexed 0 exported types from packages/*/src.\n` +
        `Refusing to report success: with an empty index every documented name\n` +
        `would resolve to nothing and be reported, or — worse, if this guard ever\n` +
        `learns to skip unknowns — nothing would be reported at all.`,
    };
  }

  const docRoots = [join(root, 'docs'), join(root, 'README.md')];
  const files = [];
  for (const entry of docRoots) {
    if (!existsSync(entry)) continue;
    if (statSync(entry).isDirectory()) files.push(...walk(entry, (f) => f.endsWith('.md')));
    else files.push(entry);
  }

  const problems = [];
  let blocksChecked = 0;
  let namesChecked = 0;

  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    const markdown = readFileSync(file, 'utf-8');

    for (const block of typescriptBlocks(markdown)) {
      if (/^\s*\/\/\s*doc-types:\s*illustrative\s*$/m.test(block.code)) continue;
      blocksChecked++;

      const code = stripNonCode(block.code);

      // Generic parameters the block itself introduces are local names.
      const locals = new Set();
      const generics = /<([^<>()]*)>/g;
      let g;
      while ((g = generics.exec(code)) !== null) {
        for (const part of g[1].split(',')) {
          const name = /^\s*([A-Z][\w$]*)\s*(?:extends|=|$)/.exec(part);
          if (name) locals.add(name[1]);
        }
      }

      // Types imported from OUTSIDE the workspace belong to their own project.
      // `Fastify` is fastify's to define, and this guard has no standing to
      // check it — but the import line tells the reader exactly where to look,
      // which is the property that mattered. Workspace imports (`@askturret/*`)
      // stay checked: those we do own.
      for (const [, clause, specifier] of stripNonCode(block.code, {
        keepStrings: true,
      }).matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s*([^\s;]+)/g)) {
        if (specifier.includes('@askturret')) continue;
        for (const [, bound] of clause.matchAll(/\b([A-Z][\w$]*)\b/g)) locals.add(bound);
      }

      // 1. Every PascalCase name must resolve.
      const seen = new Set();
      for (const [name] of code.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/g)) {
        // SCREAMING_SNAKE is this repository's convention for a constant, not a
        // type. `PLUGIN_API_VERSION` and `HOSTNAME` are values, and checking
        // them against a type index reports every one of them as missing. The
        // scope here is the type vocabulary — narrow, and deliberately so.
        if (/^[A-Z0-9_$]+$/.test(name)) continue;
        if (seen.has(name) || locals.has(name) || BUILTINS.has(name)) continue;
        seen.add(name);
        namesChecked++;
        if (!index.has(name)) {
          problems.push(
            `  ${rel}:${String(block.line)}: '${name}' is not an exported type in packages/*/src.\n` +
              `      A reader cannot import it, and a future issue quoting it inherits the error.`,
          );
        }
      }

      // 2. Every documented member of a real type must be a real member.
      const declared = /(?:export\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)/g;
      let d;
      while ((d = declared.exec(code)) !== null) {
        const [, declKind, name] = d;
        const real = index.get(name);
        if (!real || real.members === null) continue;
        const documented =
          declKind === 'interface'
            ? (() => {
                const body = braceBody(code, d.index);
                return body === null ? null : memberNames(body);
              })()
            : (() => {
                const members = aliasMembers(code, d.index);
                return members === null ? null : [...members];
              })();
        if (documented === null) continue;
        for (const member of documented) {
          if (!real.members.has(member)) {
            problems.push(
              `  ${rel}:${String(block.line)}: ${name}.${member} does not exist on the real ${name} (${real.file}).\n` +
                `      Real members: ${[...real.members].join(', ')}`,
            );
          }
        }
      }
    }
  }

  if (problems.length > 0) {
    return {
      code: 1,
      message:
        `Documentation names types that do not exist:\n\n${problems.join('\n')}\n\n` +
        `Checked ${String(namesChecked)} type reference(s) across ${String(blocksChecked)} block(s)\n` +
        `against ${String(index.size)} exported types.\n\n` +
        `If a block illustrates code an ADOPTER would write rather than a type this\n` +
        `repository exports, mark it with '// doc-types: illustrative'.`,
    };
  }

  return {
    code: 0,
    message:
      `docs: ${String(namesChecked)} type reference(s) across ${String(blocksChecked)} block(s) ` +
      `all resolve against ${String(index.size)} exported types.`,
  };
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
    console.error(`::error::Documentation type vocabulary has drifted from the code.`);
  }
  process.exit(result.code);
}
