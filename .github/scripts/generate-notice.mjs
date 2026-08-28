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
import { isProcessEntryPoint } from './lib/entry-point.mjs';

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

/**
 * Compute what NOTICE should contain, and whether the current file matches.
 *
 * Exported so the self-test can reach both failure sites (#456). Before this,
 * `main()` was invoked at module scope, so importing this file ran the whole
 * generator — including its `writeFileSync` — as an import side effect. There
 * was no way to test it without rewriting the real NOTICE.
 *
 * Deliberately does NOT write. The caller decides, which is what lets the
 * self-test exercise the stale-detection logic without touching any file.
 *
 * @param {string} rootDir - repository root.
 * @param {object} [options]
 * @param {boolean} [options.checkOnly=false] - fail on stale rather than rewrite.
 * @param {(root: string) => object[]} [options.inventory] - injectable dependency
 *   inventory. This is the #349 fixture parameter, and it is the ONLY way to
 *   reach the cannot-check path: the real `inventory()` throws on a broken
 *   dependency tree, a state no fixture directory can reliably produce.
 * @returns {{code: number, message: string, next: string, changed: boolean, runtimeCount: number}}
 *   `code` is 2 for cannot-check, 1 for stale under --check, 0 otherwise.
 *   `next` is the desired NOTICE content; the caller writes it when `changed`.
 */
export function generateNotice(rootDir = '.', options = {}) {
  const { checkOnly = false, inventory: buildInventory = inventory } = options;
  const repoRoot = resolve(rootDir);
  const noticePath = join(repoRoot, 'NOTICE');

  let deps;
  try {
    deps = buildInventory(repoRoot);
  } catch (err) {
    return {
      code: 2,
      message: `::error::could not build the dependency inventory: ${err.message}`,
      next: '',
      changed: false,
      runtimeCount: 0,
    };
  }

  const runtime = deps.filter((d) => d.scope === 'runtime' && !d.firstParty);
  const section = renderSection(runtime);

  const existing = existsSync(noticePath) ? readFileSync(noticePath, 'utf-8') : '';
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
    return {
      code: 0,
      message: `NOTICE is up to date (${runtime.length} runtime dependencies).`,
      next,
      changed: false,
      runtimeCount: runtime.length,
    };
  }

  if (checkOnly) {
    return {
      code: 1,
      message:
        '::error::NOTICE is out of date with the installed runtime dependencies.\n' +
        'Regenerate it and commit the result:\n' +
        '  node .github/scripts/generate-notice.mjs\n\n' +
        'Attribution is a licence obligation, so this is a build failure rather ' +
        'than a warning: shipping without it is a compliance problem, not an ' +
        'untidy file.',
      next,
      changed: true,
      runtimeCount: runtime.length,
    };
  }

  return {
    code: 0,
    message: `NOTICE regenerated with ${runtime.length} runtime dependencies.`,
    next,
    changed: true,
    runtimeCount: runtime.length,
  };
}

if (isProcessEntryPoint(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootDir = args.find((a) => !a.startsWith('--')) ?? '.';
  const result = generateNotice(rootDir, { checkOnly: args.includes('--check') });

  if (result.code === 0 && result.changed) {
    writeFileSync(join(resolve(rootDir), 'NOTICE'), result.next);
  }
  if (result.code === 0) console.log(result.message);
  else console.error(result.message);
  process.exit(result.code);
}
