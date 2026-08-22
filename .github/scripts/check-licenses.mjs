#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Licence review gate (#24, architecture §19.7).
 *
 * Fails the build when a dependency carries a copyleft, source-available or
 * undeclared licence without an approved exception in LICENSE_EXCEPTIONS.md.
 *
 * Usage:
 *   node .github/scripts/check-licenses.mjs [repoRoot]
 *   node .github/scripts/check-licenses.mjs --json     # machine-readable
 *
 * Exit codes: 0 clean · 1 policy violation · 2 could not evaluate
 *
 * Failing closed is deliberate throughout: an unreadable inventory, an
 * unparseable expression or an unrecognised licence all block rather than pass.
 * A licence gate that waves through what it does not understand is not a gate.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { inventory } from './lib/dependencies.mjs';
import { classifyExpression } from './lib/license-policy.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const repoRoot = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const EXCEPTIONS_FILE = 'LICENSE_EXCEPTIONS.md';

/**
 * Parse LICENSE_EXCEPTIONS.md.
 *
 * Exceptions live in a markdown table so they are reviewable in a diff and
 * readable without tooling:
 *
 *   | Package | Version | Licence | Scope | Reason | Approved by | Date |
 *
 * `*` in Version matches any version. A row missing a reason or approver is
 * rejected — an exception with no stated justification is not an exception.
 */
export function parseExceptions(markdown) {
  const rows = [];
  const problems = [];

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;

    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 7) continue;

    const [pkg, version, license, scope, reason, approver] = cells;
    if (!pkg || pkg.toLowerCase() === 'package') continue; // header
    if (/^-+$/.test(pkg)) continue; // separator

    if (!reason || !approver) {
      problems.push(`exception for "${pkg}" is missing a reason or approver`);
      continue;
    }
    rows.push({
      name: pkg.replace(/`/g, ''),
      version: (version || '*').replace(/`/g, ''),
      license: (license || '*').replace(/`/g, ''),
      scope: (scope || 'any').toLowerCase(),
      reason,
      approver,
    });
  }
  return { exceptions: rows, problems };
}

/**
 * Normalise scope spellings so the human-facing table can say `dev` while the
 * inventory says `development`.
 */
function normaliseScope(scope) {
  const s = String(scope ?? '').trim().toLowerCase();
  if (s === 'dev' || s === 'development' || s === 'devdependency') return 'development';
  if (s === 'runtime' || s === 'prod' || s === 'production') return 'runtime';
  return s || 'any';
}

/** Does an exception row cover this dependency? */
export function findException(exceptions, dep) {
  const depScope = normaliseScope(dep.scope);
  return exceptions.find((e) => {
    const scope = normaliseScope(e.scope);
    return (
      e.name === dep.name &&
      (e.version === '*' || e.version === dep.version) &&
      (scope === 'any' || scope === depScope) &&
      (e.license === '*' || e.license === (dep.license ?? ''))
    );
  });
}

function main() {
  let deps;
  try {
    deps = inventory(repoRoot);
  } catch (err) {
    console.error(`::error::could not build the dependency inventory: ${err.message}`);
    console.error('Run `npm install` first. Failing closed rather than reporting a clean build.');
    process.exit(2);
  }

  if (deps.length === 0) {
    console.error('::error::dependency inventory is empty — node_modules missing? Failing closed.');
    process.exit(2);
  }

  const exceptionsPath = join(repoRoot, EXCEPTIONS_FILE);
  let exceptions = [];
  if (existsSync(exceptionsPath)) {
    const parsed = parseExceptions(readFileSync(exceptionsPath, 'utf-8'));
    exceptions = parsed.exceptions;
    for (const p of parsed.problems) console.error(`::warning::${EXCEPTIONS_FILE}: ${p}`);
  }

  const violations = [];
  const excepted = [];
  let allowedCount = 0;

  for (const dep of deps) {
    // First-party workspace packages are ours and Apache-2.0 by construction.
    if (dep.firstParty) continue;

    const verdict = classifyExpression(dep.license);
    if (verdict === 'allowed') {
      allowedCount++;
      continue;
    }

    const exception = findException(exceptions, dep);
    if (exception) {
      excepted.push({ ...dep, verdict, exception });
      continue;
    }
    violations.push({ ...dep, verdict });
  }

  if (asJson) {
    console.log(JSON.stringify({ allowedCount, excepted, violations }, null, 2));
    process.exit(violations.length > 0 ? 1 : 0);
  }

  console.log(`Licence review: ${deps.length} installed package(s)`);
  console.log(`  ${allowedCount} permissive (auto-approved)`);
  console.log(`  ${excepted.length} covered by ${EXCEPTIONS_FILE}`);
  console.log(`  ${violations.length} violation(s)\n`);

  for (const e of excepted) {
    console.log(`  except  ${e.name}@${e.version} (${e.license}) — ${e.exception.reason}`);
  }

  if (violations.length === 0) {
    console.log('\nNo licence policy violations.');
    return;
  }

  console.log('');
  for (const v of violations) {
    const licence = v.license ?? '(none declared)';
    const why =
      v.verdict === 'denied'
        ? 'blocked by policy (copyleft, source-available, or undeclared)'
        : 'not in the permissive allowlist — needs a human decision';
    console.log(`  FAIL  ${v.name}@${v.version}  [${v.scope}]  ${licence}\n        ${why}`);
  }

  console.error(
    `\n::error::${violations.length} dependency licence(s) violate policy.\n\n` +
      'Each one is a choice, not a formality:\n' +
      '  1. Prefer a permissively licensed alternative (MIT / BSD / ISC / Apache-2.0).\n' +
      `  2. If the dependency is genuinely required, add a row to ${EXCEPTIONS_FILE}:\n` +
      '       | `pkg-name` | `1.2.3` | `MPL-2.0` | dev | why it is acceptable | @approver | 2026-01-01 |\n' +
      '     A reason and an approver are mandatory; `*` may be used for the version.\n' +
      '  3. If the licence is permissive but unrecognised, add it to ALLOWED in\n' +
      '     .github/scripts/lib/license-policy.mjs — in a reviewed change, so the\n' +
      '     policy widens deliberately rather than by accident.',
  );
  process.exit(1);
}

// Only run when invoked directly, so the parsing helpers can be imported by
// tests without executing the gate.
if (process.argv[1] && resolve(process.argv[1]).endsWith('check-licenses.mjs')) {
  main();
}
