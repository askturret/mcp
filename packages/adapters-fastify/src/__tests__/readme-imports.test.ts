// SPDX-License-Identifier: Apache-2.0
/**
 * Every import in the README's Fastify section actually works (#41 QA round 3).
 *
 * ## Why this exists
 *
 * This PR shipped TWO broken imports in this one README section, across two
 * separate QA rounds, and they failed in two different ways:
 *
 *   round 2 — `@askturret/mcp/fastify` did not resolve at all
 *             (ERR_PACKAGE_PATH_NOT_EXPORTED — no subpath in the exports map)
 *   round 3 — `import { fromOpenApi } from '@askturret/mcp'` resolved fine but
 *             provided no such export (SyntaxError). `fromOpenApi` lives on
 *             `@askturret/mcp/openapi`.
 *
 * `subpath-export.test.ts` covers the first class and is blind to the second:
 * a module can resolve perfectly and still not export the binding a caller
 * destructures. So this file checks the stronger property — the import
 * statement as written **executes and yields the named bindings**.
 *
 * The round-2 fix was verified by running ONE of the two examples in this
 * section against a real server and reporting it as "the README example". The
 * composable example, added in the same edit, was never run. That over-claim is
 * why this is a test rather than another manual probe: a check I have to
 * remember to repeat is one I will eventually report as done without doing.
 *
 * ## Deliberately scoped to the Fastify section
 *
 * The same mistake exists elsewhere in the README — line 73 makes the identical
 * `fromOpenApi`-from-root error, and lines 89 and 320 are broken too. Those are
 * on `origin/main`, predate this branch, and are tracked by #149. Widening this
 * test to the whole README would fail the build for defects this PR did not
 * introduce and does not own.
 *
 * When #149 lands, widening `SECTION_HEADING` to scan the whole file is the
 * natural next step, and this file is written so that is a one-line change.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');

/** The section this PR owns. See the note above on scope. */
const SECTION_HEADING = '### Fastify + OpenAPI';

function fastifySection(): string {
  const start = README.indexOf(SECTION_HEADING);
  if (start === -1) return '';
  // Up to the next same-level heading, so the section's own subheadings stay in.
  const rest = README.slice(start + SECTION_HEADING.length);
  const end = rest.indexOf('\n### ');
  return end === -1 ? rest : rest.slice(0, end);
}

interface ParsedImport {
  readonly specifier: string;
  readonly named: readonly string[];
  readonly statement: string;
}

/** Named-binding imports (`import { a, b } from 'x'`) from ```ts blocks. */
function parseImports(markdown: string): ParsedImport[] {
  const out: ParsedImport[] = [];

  for (const block of markdown.matchAll(/```ts\n([\s\S]*?)```/g)) {
    const code = block[1] ?? '';
    for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
      const named = (m[1] ?? '')
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
        .filter((s) => s.length > 0);
      out.push({ specifier: m[2] ?? '', named, statement: m[0] });
    }
  }

  return out;
}

const imports = parseImports(fastifySection());

describe('README Fastify section imports', () => {
  it('finds the section and its import statements', () => {
    // Guards the guard. A heading rename or a fenced-block format change would
    // silently empty this list and make every case below vacuously pass —
    // which is precisely how a doc test rots into decoration.
    expect(fastifySection()).not.toBe('');
    expect(imports.length).toBeGreaterThanOrEqual(2);
    expect(imports.map((i) => i.specifier)).toEqual(
      expect.arrayContaining(['@askturret/mcp/fastify']),
    );
  });

  it.each(imports.map((i) => [i.statement, i] as const))(
    'resolves and provides every binding in: %s',
    (_statement, parsed) => {
      // Run in a REAL node subprocess rather than importing in-process.
      //
      // Not a workaround for a flaky harness — it is the more faithful check.
      // `@askturret/mcp` resolves through package SELF-REFERENCE (a package may
      // import itself by name when it declares `exports`), which Jest's
      // resolver does not implement: an in-process `await import()` reports
      // "Cannot find module '@askturret/mcp'" for a specifier that works
      // perfectly under `node`. Asserting against Jest's resolver would test
      // the harness, and would have pushed me to "fix" a correct README to
      // satisfy it.
      //
      // A subprocess runs the statement the way a reader's own script will.
      const probe = [
        parsed.statement + ';',
        `const bindings = { ${parsed.named.join(', ')} };`,
        'for (const [name, value] of Object.entries(bindings)) {',
        "  if (typeof value === 'undefined') { console.error('MISSING:' + name); process.exit(3); }",
        '}',
      ].join('\n');

      const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });

      // Surface the real reason on failure — SyntaxError vs
      // ERR_PACKAGE_PATH_NOT_EXPORTED are different bugs with different fixes,
      // and "exit code 1" tells the next reader neither.
      expect(`${result.status} ${result.stderr ?? ''}`.trim()).toBe('0');
    },
  );

  it('imports fromOpenApi from the /openapi subpath, not the root', () => {
    // The exact round-3 defect, pinned by name: `fromOpenApi` is not a root
    // export, and writing it as one produces a SyntaxError at import time
    // rather than anything a type-check would catch.
    const fromRoot = imports.find(
      (i) => i.specifier === '@askturret/mcp' && i.named.includes('fromOpenApi'),
    );

    expect(fromRoot).toBeUndefined();
  });
});
