// SPDX-License-Identifier: Apache-2.0
/**
 * `npx @askturret/mcp-adapter-test ./my-adapter` (§54).
 *
 * Argument parsing, module loading and output. The conformance logic is in
 * `kit.ts`, and the assertions are in `@askturret/mcp-adapter-conformance` —
 * see that file's header for why none of them are here.
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

import {
  AdapterContractError,
  KIT_VERSION,
  assertAdapterUnderTest,
  generateBadge,
  knownCategoryNames,
  renderReport,
  runConformance,
  type AdapterUnderTest,
  type ConformanceReport,
} from './kit.js';

export interface CliFlags {
  readonly target?: string;
  readonly json: boolean;
  readonly out?: string;
  readonly categories?: readonly string[];
  readonly badge?: string;
  readonly help: boolean;
  readonly version: boolean;
}

export function parseArgs(argv: readonly string[]): CliFlags {
  let target: string | undefined;
  let json = false;
  let out: string | undefined;
  let badge: string | undefined;
  let help = false;
  let version = false;
  const categories: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--json':
        json = true;
        break;
      case '--out':
        out = argv[++i];
        break;
      case '--category':
        // Repeatable. `--category a --category b` is clearer than inventing a
        // separator, and a comma-separated value is also accepted below
        // because someone will type it regardless.
        {
          const value = argv[++i];
          if (value !== undefined) {
            for (const name of value.split(',')) {
              const trimmed = name.trim();
              if (trimmed.length > 0) categories.push(trimmed);
            }
          }
        }
        break;
      case '--generate-badge':
        badge = argv[++i] ?? 'conformance.svg';
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      case '--version':
        version = true;
        break;
      default:
        if (arg !== undefined && !arg.startsWith('--') && target === undefined) target = arg;
        break;
    }
  }

  return {
    ...(target === undefined ? {} : { target }),
    json,
    ...(out === undefined ? {} : { out }),
    ...(categories.length === 0 ? {} : { categories }),
    ...(badge === undefined ? {} : { badge }),
    help,
    version,
  };
}

export function usage(): string {
  return [
    'askturret-adapter-test — MCP adapter conformance kit',
    '',
    'Usage:',
    '  npx @askturret/mcp-adapter-test <path-to-adapter> [options]',
    '',
    'Options:',
    '  --json                    Emit the machine-readable report (public contract)',
    '  --out <file>              Write the JSON report to a file',
    '  --category <name>         Run one category (repeatable, or comma-separated)',
    '  --generate-badge <file>   Write an SVG conformance badge',
    '  --version                 Print the kit version',
    '  -h, --help                Show this help',
    '',
    `Categories: ${knownCategoryNames().join(', ')}`,
    '',
    'Your adapter module must export an AdapterUnderTest:',
    '  export default {',
    '    name: "my-adapter",',
    '    async createServer(config) { /* start a server */ return { url, close }; },',
    '  };',
    '',
    'A conformance result is scoped to the kit version it was produced with.',
  ].join('\n');
}

/**
 * Load an adapter module and validate its export.
 *
 * Accepts a default export or a named `adapter` export. Two shapes rather than
 * one because both are idiomatic and guessing wrong costs an author a
 * confusing failure on their first run — the moment they are least able to
 * tell a kit bug from their own.
 */
export async function loadAdapter(target: string): Promise<AdapterUnderTest> {
  const path = resolve(process.cwd(), target);

  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (error) {
    throw new AdapterContractError(
      `Could not import '${target}' (resolved to ${path}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const candidate = module['default'] ?? module['adapter'] ?? module;
  assertAdapterUnderTest(candidate);
  return candidate;
}

export interface CliIo {
  readonly log: (text: string) => void;
  readonly error: (text: string) => void;
}

/**
 * Run `body` with everything written to stdout diverted to stderr.
 *
 * ## Why this is necessary rather than tidy
 *
 * `--json` is a public contract, and the documented way to use it is
 * `npx @askturret/mcp-adapter-test ./adapter --json > results.json`. That only
 * works if stdout carries the document and NOTHING else.
 *
 * It did not. Running the kit prints the compiler's progress — `Starting
 * compilation`, one line per pass, per server, and the bank starts a server per
 * category — straight to stdout, so the redirected file began with
 * `Starting compilation { discoveredCount: 2 …` and `JSON.parse` failed on the
 * first character. The feature §54 asks to document as a stable contract did
 * not produce parseable output at all.
 *
 * Silencing our own logger would fix today's symptom and miss the real one:
 * the kit runs a COMMUNITY adapter, which is arbitrary third-party code that
 * may print a banner, a deprecation warning, or a stray `console.log` on
 * startup. We cannot audit it, so the guarantee has to be structural — the kit
 * owns stdout, and everything the run emits goes to stderr where a human can
 * still read it and a pipe ignores it.
 */
/**
 * The diversion this module installed, and the handle it displaced.
 *
 * Only used to make a SECOND call re-entrant. Without it, a second call would
 * capture the first call's diversion as its "original" and emit the document
 * into stderr — the document silently vanishing, which is worse than the bug
 * this helper exists to fix. Both shipped callers invoke it once, so this is a
 * guard against a future one rather than a fix for today.
 */
let installed: { divert: typeof process.stdout.write; original: typeof process.stdout.write } | null =
  null;

export async function withOwnedStdout<T>(
  body: (out: (text: string) => void) => Promise<T>,
): Promise<T> {
  // Re-entrant only while OUR diversion is the one installed. If something else
  // replaced `process.stdout.write` since — a test harness restoring its own
  // seam, say — the previous capture is stale and a fresh one is correct.
  if (installed === null || process.stdout.write !== installed.divert) {
    const original = process.stdout.write.bind(process.stdout);

    const divert = ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      // Diverted, never dropped: a conformance failure is often explained by
      // whatever the adapter printed on the way down, and swallowing it would
      // trade a parsing bug for a debugging one.
      if (typeof encoding === 'function') return process.stderr.write(chunk, encoding);
      return process.stderr.write(chunk, encoding as BufferEncoding, callback);
    }) as typeof process.stdout.write;

    process.stdout.write = divert;
    installed = { divert, original };
  }

  const emit = installed.original;

  // `out` writes through the CAPTURED handle, so a caller emits its document
  // while diversion is still in force.
  //
  // ## The diversion is NEVER restored, and that is the fix (#174)
  //
  // It used to be restored in a `finally`. QA's round-1 reading was that the
  // hole lay between that restore and the emit, and that emitting first would
  // close it. Round 2 corrected that, and the correction is the important part:
  //
  //   the window is not between the restore and the emit — it is EVERYTHING
  //   after the restore, until the process exits.
  //
  // A non-unref'd `setTimeout` inside an adapter is exactly what extends that
  // window, because it keeps the event loop alive long enough to fire. Emitting
  // first moved a late write from leading to trailing, which is a genuine
  // improvement — but `JSON.parse(readFileSync('results.json'))`, the usage the
  // README documents, still throws on trailing garbage.
  //
  // So the restore is gone. Nothing legitimately belongs on this process's
  // stdout after the document: both shipped callers invoke this once and set
  // `process.exitCode` rather than calling `process.exit`, so the process ends
  // by draining the event loop — precisely when a pending timer would have
  // fired. Holding the diversion until then is what makes "stdout carries the
  // document and nothing else" true for the whole life of the run, rather than
  // for most of it.
  //
  // EXPORTED, and that matters. The first version of this fix lived only in
  // the CLI, and bin/generate-table.mjs — which produces docs/adapters.md, a
  // §54 acceptance artifact — had the identical bug: 518 lines of compiler
  // output ahead of the table. One shared helper is what stops a sibling
  // script drifting back.
  return await body((text) => {
    emit(text);
  });
}

/**
 * Run the CLI. Returns the process exit code rather than calling `exit`, so
 * tests can drive it without tearing down the runner.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const flags = parseArgs(argv);

  if (flags.help) {
    io.log(usage());
    return 0;
  }

  if (flags.version) {
    io.log(KIT_VERSION);
    return 0;
  }

  if (flags.target === undefined) {
    io.error('No adapter path supplied.\n');
    io.error(usage());
    return 2;
  }

  let report: ConformanceReport;
  try {
    // Owned for EVERY run, not only `--json`. The human report is also easier
    // to read without a few hundred compiler lines above it, and a stdout that
    // means different things depending on a flag is the kind of difference
    // that bites whoever automates it later.
    //
    // The document is emitted INSIDE this window, through `out`, so it lands
    // before stdout is restored — see `withOwnedStdout` for why that ordering
    // is what makes a late background write harmless rather than corrupting.
    report = await withOwnedStdout(async (out) => {
      const adapter = await loadAdapter(flags.target as string);
      const result = await runConformance(
        adapter,
        flags.categories === undefined ? undefined : { categories: flags.categories },
      );

      out(`${flags.json ? JSON.stringify(result, null, 2) : renderReport(result)}\n`);
      return result;
    });
  } catch (error) {
    // Exit 2 for "the kit could not run", distinct from exit 1 for "the
    // adapter failed a category". A CI job that cannot tell those apart
    // reports a broken harness as a conformance failure, which sends the
    // author to debug the wrong thing.
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (flags.out !== undefined) {
    await writeFile(resolve(process.cwd(), flags.out), `${JSON.stringify(report, null, 2)}\n`);
  }

  if (flags.badge !== undefined) {
    await writeFile(resolve(process.cwd(), flags.badge), `${generateBadge(report)}\n`);
  }

  // §54: non-zero exit on any category failure.
  return report.passed ? 0 : 1;
}
