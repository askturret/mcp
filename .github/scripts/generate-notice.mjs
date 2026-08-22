#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Regenerates the third-party attribution section of NOTICE (#24).
 *
 * Apache-2.0 §4(d) requires redistributing the NOTICE content of any Apache-2.0
 * dependency you bundle, and most permissive licences require carrying their
 * copyright notice. This lists every RUNTIME dependency — the ones adopters
 * actually receive — and reproduces any NOTICE file those dependencies ship.
 *
 * Dev dependencies are deliberately excluded: they are not distributed, so
 * attributing them would misstate what is in the package.
 *
 * Usage:
 *   node .github/scripts/generate-notice.mjs           # rewrite NOTICE
 *   node .github/scripts/generate-notice.mjs --check   # fail if stale (CI)
 *
 * Exit codes: 0 up to date / written · 1 stale (--check) · 2 could not evaluate
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { inventory } from './lib/dependencies.mjs';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const repoRoot = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const NOTICE_PATH = join(repoRoot, 'NOTICE');

const BEGIN = '<!-- BEGIN GENERATED THIRD-PARTY NOTICES -->';
const END = '<!-- END GENERATED THIRD-PARTY NOTICES -->';

/** Filenames a dependency may use for its own NOTICE. */
const NOTICE_NAMES = ['NOTICE', 'NOTICE.txt', 'NOTICE.md'];

function findDependencyNotice(dir) {
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const match = entries.find((e) => NOTICE_NAMES.includes(e));
  if (!match) return null;
  try {
    const text = readFileSync(join(dir, match), 'utf-8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function renderSection(deps) {
  const lines = [];
  lines.push(BEGIN);
  lines.push('');
  lines.push(
    'The following third-party runtime dependencies are distributed with this',
    'product. Development-only dependencies are excluded — they are not shipped.',
    '',
    'Regenerate with: node .github/scripts/generate-notice.mjs',
    '',
  );

  if (deps.length === 0) {
    lines.push('(No third-party runtime dependencies.)');
    lines.push('');
    lines.push(END);
    return lines.join('\n');
  }

  const width = Math.max(...deps.map((d) => `${d.name}@${d.version}`.length));
  for (const dep of deps) {
    lines.push(`  ${`${dep.name}@${dep.version}`.padEnd(width)}  ${dep.license}`);
  }
  lines.push('');

  const withNotices = deps
    .map((dep) => ({ dep, notice: findDependencyNotice(dep.dir) }))
    .filter((entry) => entry.notice);

  if (withNotices.length > 0) {
    lines.push(
      '-'.repeat(80),
      '',
      'The dependencies below ship their own NOTICE file, reproduced here as',
      'their licences require.',
      '',
    );
    for (const { dep, notice } of withNotices) {
      lines.push(`--- ${dep.name}@${dep.version} ---`, '', notice, '');
    }
  }

  lines.push(END);
  return lines.join('\n');
}

function main() {
  let deps;
  try {
    deps = inventory(repoRoot);
  } catch (err) {
    console.error(`::error::could not build the dependency inventory: ${err.message}`);
    process.exit(2);
  }

  const runtime = deps.filter((d) => d.scope === 'runtime' && !d.firstParty);
  const section = renderSection(runtime);

  const existing = existsSync(NOTICE_PATH) ? readFileSync(NOTICE_PATH, 'utf-8') : '';
  let next;

  if (existing.includes(BEGIN) && existing.includes(END)) {
    const before = existing.slice(0, existing.indexOf(BEGIN));
    const after = existing.slice(existing.indexOf(END) + END.length);
    next = `${before}${section}${after}`;
  } else {
    // First run: replace the hand-written placeholder, keeping the licence
    // header above the separator.
    const separator = '='.repeat(80);
    const head = existing.includes(separator)
      ? existing.slice(0, existing.indexOf(separator) + separator.length)
      : existing.trimEnd();
    next = `${head}\n\n${section}\n`;
  }

  if (next === existing) {
    console.log(`NOTICE is up to date (${runtime.length} runtime dependencies).`);
    return;
  }

  if (checkOnly) {
    console.error(
      '::error::NOTICE is out of date with the installed runtime dependencies.\n' +
        'Regenerate it and commit the result:\n' +
        '  node .github/scripts/generate-notice.mjs\n\n' +
        'Attribution is a licence obligation, so this is a build failure rather ' +
        'than a warning: shipping without it is a compliance problem, not an ' +
        'untidy file.',
    );
    process.exit(1);
  }

  writeFileSync(NOTICE_PATH, next);
  console.log(`NOTICE regenerated with ${runtime.length} runtime dependencies.`);
}

main();
