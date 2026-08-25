#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Rejects `npm test` invocations that pass a jest flag npm will silently eat.
 *
 * `npm test --testPathPattern=X` does not filter anything. npm parses the flag
 * as one of ITS OWN config options, never forwards it to jest, and runs the
 * full suite. On npm 11 that prints `npm warn Unknown cli config` — one line,
 * mid-scrollback, above the output of every test it just ran anyway — and on
 * older npm it printed nothing at all. The exit code is 0 either way.
 *
 * That is this repo's usual quarry: a command that reports success for work it
 * did not do. It is the same shape as `check-test-execution` (a suite that ran
 * nothing) and `check-placeholder-tests` (a test that cannot fail), and it had
 * really happened — two steps in `test-integrity` named "Policy parity test
 * (criterion #4)" and "Idempotent+retryable fuzz test (criterion #6)" were each
 * running the ENTIRE workspace suite instead (#207).
 *
 * ## The correct form needs BOTH halves
 *
 *   npm test -w packages/core -- --testPathPattern="parity"
 *              ^^^^^^^^^^^^^^^ ^^
 *
 * `--` makes npm forward the flag to jest instead of consuming it. `-w <pkg>`
 * confines the run to ONE workspace. Neither alone is enough, and this guard
 * therefore fails on both partial forms:
 *
 *   - no `--`  -> the silent no-op above
 *   - `--` but no `-w` -> the flag reaches EVERY workspace under
 *     `--workspaces`, and jest exits 1 in each one the pattern does not match,
 *     so a correct command breaks unrelated packages. That is why #207 could
 *     not be closed by adding `--` and nothing else.
 *
 * ## Scope: places the string would EXECUTE
 *
 * Workflow `run:` blocks and `package.json` scripts only. Prose is deliberately
 * NOT scanned — CONTRIBUTING.md documents the broken form as the thing not to
 * do, and a guard that cannot tell an example from an instruction would either
 * fail on its own documentation or force that documentation to omit the very
 * string a reader needs to recognise.
 *
 * Usage:
 *   node .github/scripts/check-jest-flag-forwarding.mjs [rootDir]
 *
 * Errors (exit 1):
 *   - an `npm test`/`npm run test` command passing a jest flag with no `--`
 *   - the same with `--` but no `-w`/`--workspace`, which breaks other packages
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? '.');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

/**
 * Jest flags npm consumes rather than forwards.
 *
 * Only flags that take the `--name=value` or `--name value` shape and are NOT
 * npm config keys. `--coverage` is deliberately absent: npm has no such config,
 * so it forwards cleanly and is not part of this defect.
 */
const JEST_FLAGS = [
  'testPathPattern',
  'testPathPatterns',
  'testNamePattern',
  'testPathIgnorePatterns',
  'runTestsByPath',
  'selectProjects',
  'maxWorkers',
];

const FLAG_ALTERNATION = JEST_FLAGS.join('|');

/** An `npm test` / `npm run test` command, up to the end of the line. */
const NPM_TEST = new RegExp(String.raw`\bnpm\s+(?:run\s+)?test\b[^\n]*`, 'g');

const posix = (p) => p.split(sep).join('/');

function collect(dir, predicate, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, predicate, out);
    else if (predicate(entry)) out.push(full);
  }
  return out;
}

/**
 * Classify one `npm test ...` command.
 *
 * Returns null when it carries no jest flag at all — the overwhelming majority,
 * and none of this guard's business.
 */
function classify(command) {
  const flag = new RegExp(String.raw`--(${FLAG_ALTERNATION})\b`).exec(command);
  if (!flag) return null;

  const flagAt = flag.index;

  // A `--` separator BEFORE the flag is what forwards it. One appearing after
  // the flag does not help it, so position is checked rather than presence.
  const separator = /(?:^|\s)--(?=\s)/g;
  let forwarded = false;
  for (let m = separator.exec(command); m; m = separator.exec(command)) {
    if (m.index < flagAt) {
      forwarded = true;
      break;
    }
  }

  const scoped = /(?:^|\s)(?:-w|--workspace)(?:=|\s)/.test(command);

  if (!forwarded) {
    return {
      problem: `npm eats --${flag[1]} as its own config and runs the FULL suite`,
      fix: 'add `--` before the flag, and `-w <package>` to scope it',
    };
  }
  if (!scoped) {
    return {
      problem: `--${flag[1]} is forwarded to EVERY workspace; jest exits 1 wherever it matches nothing`,
      fix: 'add `-w <package>` so the pattern applies to one workspace',
    };
  }
  return null;
}

const findings = [];

function scan(file, text) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(NPM_TEST)) {
      const verdict = classify(m[0]);
      if (verdict) {
        findings.push({
          file: posix(relative(repoRoot, file)),
          line: i + 1,
          command: m[0].trim(),
          ...verdict,
        });
      }
    }
  });
}

const workflowDir = join(repoRoot, '.github', 'workflows');
const workflows = existsSync(workflowDir)
  ? collect(workflowDir, (e) => e.endsWith('.yml') || e.endsWith('.yaml'))
  : [];

for (const file of workflows) scan(file, readFileSync(file, 'utf-8'));

// package.json is scanned through its scripts only, so a dependency or a
// description mentioning the string cannot trip the guard.
for (const file of collect(repoRoot, (e) => e === 'package.json')) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    continue; // not this guard's job to report malformed JSON
  }
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (typeof command !== 'string') continue;
    for (const m of command.matchAll(NPM_TEST)) {
      const verdict = classify(m[0]);
      if (verdict) {
        findings.push({
          file: `${posix(relative(repoRoot, file))} (scripts.${name})`,
          line: null,
          command: m[0].trim(),
          ...verdict,
        });
      }
    }
  }
}

console.log(
  `Scanned ${workflows.length} workflow file(s) and every package.json scripts block.`,
);

if (findings.length === 0) {
  console.log('\nNo npm test invocation drops a jest flag.');
  process.exit(0);
}

for (const f of findings) {
  console.error(`  FAIL  ${f.file}${f.line === null ? '' : `:${f.line}`}`);
  console.error(`        ${f.command}`);
  console.error(`        ${f.problem}`);
  console.error(`        fix: ${f.fix}`);
}

console.error(
  `\n::error::${findings.length} npm test invocation(s) pass a jest flag that will not do what ` +
    'they say.\nThe correct form needs BOTH halves:\n' +
    '  npm test -w packages/<pkg> -- --testPathPattern="<pattern>"\n' +
    'See CONTRIBUTING.md > Running a subset of the tests.',
);
process.exit(1);
