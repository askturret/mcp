// SPDX-License-Identifier: Apache-2.0
/**
 * `npx @askturret/mcp migrate` (#62, §16).
 *
 * The process shell: parse flags, read files, call the engine, print, exit.
 * Every decision lives in `registry.ts` (what changed), `engine.ts` (how to
 * apply it) and `guide.ts` (how to explain it).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';

import { applyMigrations, type ProjectFile } from './engine.js';
import { renderSnippet } from './guide.js';
import { knownPairs, selectMigrations } from './registry.js';
import type { Finding } from './types.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const CANDIDATE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|ya?ml)$/;

export interface MigrateOptions {
  readonly from?: string;
  readonly to?: string;
  readonly check: boolean;
  readonly config?: string;
  readonly includeProspective: boolean;
  readonly json: boolean;
  readonly dir: string;
}

export function parseMigrateArgs(args: readonly string[]): MigrateOptions | { help: true } {
  const options: Record<string, unknown> = {
    check: false,
    includeProspective: false,
    json: false,
    dir: '.',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    switch (arg) {
      case '--check':
        options['check'] = true;
        break;
      case '--include-prospective':
        options['includeProspective'] = true;
        break;
      case '--json':
        options['json'] = true;
        break;
      case '--help':
      case '-h':
        return { help: true };
      case '--from':
      case '--to':
      case '--config':
      case '--dir': {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`${arg} requires a value.`);
        }
        options[arg.slice(2)] = value;
        i += 1;
        break;
      }
      default:
        throw new Error(`Unknown option '${arg}'. Run 'migrate --help'.`);
    }
  }

  return options as unknown as MigrateOptions;
}

/** Files worth offering the engine. */
function collect(root: string, dir: string, out: ProjectFile[] = []): ProjectFile[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(root, full, out);
    else if (CANDIDATE.test(entry)) {
      out.push({ path: relative(root, full).split(sep).join('/'), contents: '' });
    }
  }
  return out;
}

function group(findings: readonly Finding[]): { rewrite: Finding[]; manual: Finding[] } {
  return {
    rewrite: findings.filter((f) => f.action === 'rewrite'),
    manual: findings.filter((f) => f.action === 'manual'),
  };
}

/**
 * Run the migration.
 *
 * Exit code contract, which §62 makes CI-facing:
 *   0 — nothing to apply (or applied successfully)
 *   1 — `--check` and changes ARE needed
 *   2 — the command could not run
 *
 * `--check` never writes. It is the same engine call as a real run; only the
 * write is skipped, so a preview cannot disagree with what it previews.
 */
export async function migrateCommand(args: readonly string[]): Promise<void> {
  let options;
  try {
    const parsed = parseMigrateArgs(args);
    if ('help' in parsed) {
      printHelp();
      process.exit(0);
    }
    options = parsed;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const root = resolve(options.dir);
  if (!existsSync(root)) {
    console.error(`No such directory: ${options.dir}`);
    process.exit(2);
  }

  const migrations = selectMigrations({
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
    includeProspective: options.includeProspective,
  });

  if (migrations.length === 0) {
    // Not an error. "No migration is published for this range" is the correct
    // and common answer, and exiting non-zero would make every CI run of a
    // healthy project fail.
    const scope =
      options.from === undefined && options.to === undefined
        ? 'this project'
        : `${options.from ?? '(any)'} → ${options.to ?? '(any)'}`;
    if (options.json) {
      console.log(JSON.stringify({ migrations: [], findings: [], changesNeeded: false }, null, 2));
    } else {
      console.log(`No migrations apply to ${scope}.`);
      const pairs = knownPairs();
      if (pairs.length > 0) {
        console.log('');
        console.log('Known version pairs:');
        for (const pair of pairs) {
          const note = pair.status === 'prospective' ? '  (prospective — needs --include-prospective)' : '';
          console.log(`  ${pair.from} → ${pair.to}${note}`);
        }
      }
    }
    process.exit(0);
  }

  // `--config` narrows to one file; otherwise walk the project.
  const targets = options.config === undefined ? collect(root, root) : [{ path: options.config, contents: '' }];

  const files: ProjectFile[] = [];
  for (const target of targets) {
    try {
      files.push({ path: target.path, contents: await readFile(join(root, target.path), 'utf8') });
    } catch {
      console.error(`Could not read ${target.path}`);
      process.exit(2);
    }
  }

  const result = applyMigrations({ files, migrations });
  const { rewrite, manual } = group(result.findings);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          migrations: migrations.map((m) => ({ from: m.from, to: m.to, status: m.status })),
          findings: result.findings,
          changed: result.changed,
          changesNeeded: result.changesNeeded,
          applied: !options.check,
        },
        null,
        2,
      ),
    );
  } else {
    for (const migration of migrations) {
      console.log('');
      console.log(renderSnippet(migration));
    }
    console.log('');
    if (rewrite.length === 0 && manual.length === 0) {
      // THE REPORT HALF OF #284, and it is a separate defect from the scan.
      //
      // This used to read "Nothing to change — this project is already on the
      // target version." That states a CONCLUSION drawn from an absence: it
      // turns "I found nothing" into "there is nothing", which is exactly "I
      // could not check" wearing "it passed" — with an adopter misled rather
      // than an agent. A project whose only affected code was a re-export got
      // that sentence while carrying unhandled work.
      //
      // Fixing the scan removes today's instance. It does not remove the
      // shape: the NEXT construct the scanner does not understand would be
      // silent in the same way, and the message would still have claimed the
      // project was migrated.
      //
      // What it says now is the true statement — nothing MATCHED — plus the
      // scope, so a reader with an unusual construct knows whether to look.
      console.log('No changes needed: nothing matched these rules.');
      console.log(
        '  This is not a certificate that the project is migrated. It means nothing the tool',
      );
      console.log(
        '  recognises matched: imports and re-exports naming a renamed symbol, and config keys',
      );
      console.log(
        '  it has rules for. Code reaching the same API another way is not examined.',
      );
    }
    for (const finding of rewrite) {
      console.log(`${options.check ? 'WOULD REWRITE' : 'REWROTE'}  ${finding.file}: ${finding.detail}`);
    }
    for (const finding of manual) {
      console.log(`NEEDS YOU     ${finding.file}: ${finding.detail}`);
    }
  }

  if (!options.check) {
    for (const file of result.files) {
      if (result.changed.includes(file.path)) {
        await writeFile(join(root, file.path), file.contents, 'utf8');
      }
    }
    process.exit(0);
  }

  // `--check`: non-zero iff applying would change something.
  process.exit(result.changesNeeded ? 1 : 0);
}

function printHelp(): void {
  console.log('');
  console.log('  npx @askturret/mcp migrate [options]');
  console.log('');
  console.log('  --from <version>          Migrate from this version');
  console.log('  --to <version>            Migrate to this version');
  console.log('  --check                   Report what would change; change nothing.');
  console.log('                            Exits 1 iff changes are needed (for CI).');
  console.log('  --config <path>           Migrate one file instead of walking the project');
  console.log('  --dir <path>              Project root (default: .)');
  console.log('  --include-prospective     Include migrations for unreleased changes');
  console.log('  --json                    Machine-readable output');
  console.log('');
  const pairs = knownPairs();
  if (pairs.length > 0) {
    console.log('  Known version pairs:');
    for (const pair of pairs) {
      console.log(`    ${pair.from} → ${pair.to}${pair.status === 'prospective' ? '  (prospective)' : ''}`);
    }
    console.log('');
  }
}
