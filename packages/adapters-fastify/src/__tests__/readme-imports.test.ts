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
 * ## Scoped to the Fastify section — and NOT the authority (#598)
 *
 * An earlier note here said widening `SECTION_HEADING` to the whole README was
 * "the natural next step" and "a one-line change". **Both halves were wrong,
 * and #598 is what that cost.**
 *
 * Wrong on placement: this suite runs in the `test-adapters-fastify` job, which
 * builds only core, sources-openapi, transports, explorer and adapters-fastify.
 * The README also imports adapters-express and observability, whose `dist/`
 * does not exist here. Widening this file would fail on packages the job never
 * built.
 *
 * Wrong on sufficiency, which is the more important half: this test runs with
 * `cwd: REPO_ROOT`, and widening it would have kept it GREEN while the README
 * stayed broken for every reader. That is not a smaller version of the check —
 * it is the same blind spot with more surface.
 *
 * The whole-README property is owned by `.github/scripts/check-readme-imports.mjs`,
 * which runs in `test-integrity` after the full build and probes each import
 * against PACKED TARBALLS in a temp directory, where self-reference cannot
 * reach. This file stays as the fast, in-package pin on its own section.
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
      expect.arrayContaining(['@askturret/mcp-adapters-fastify']),
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

  it('imports fromOpenApi from its own package, not from core or the umbrella', () => {
    // The exact round-3 defect, pinned by name and now stated in terms of real
    // package names: `fromOpenApi` is not a core export, and writing it as one
    // produces a SyntaxError at import time rather than anything a type-check
    // would catch.
    //
    // Widened from `=== '@askturret/mcp'` to "anything that is not its own
    // package": the old form pinned one wrong specifier, so renaming the
    // umbrella to core would have moved the identical defect straight past it.
    const misplaced = imports.filter(
      (i) => i.named.includes('fromOpenApi') && i.specifier !== '@askturret/mcp-sources-openapi',
    );

    expect(misplaced.map((i) => i.specifier)).toEqual([]);
  });

  it('names no package that this repository does not publish', () => {
    // The #598 defect in its section-local form. The authority is the
    // clean-room guard; this catches a reintroduction in the fast lane.
    const umbrella = imports.filter(
      (i) => i.specifier === '@askturret/mcp' || i.specifier.startsWith('@askturret/mcp/'),
    );

    expect(umbrella.map((i) => i.specifier)).toEqual([]);
  });
});
