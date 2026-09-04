// SPDX-License-Identifier: Apache-2.0
/**
 * Migration engine, registry and guide (#62).
 *
 * ## The golden fixture is a real before/after pair
 *
 * `fixtures/preset-audit-reshape/{before,after}` is an actual config document
 * either side of the reshape #59 classified. The engine is run on `before` and
 * compared byte-for-byte with `after` — so the fixture is a specification the
 * engine must satisfy, not a snapshot of whatever it happened to produce.
 *
 * ## Idempotency is asserted, not assumed
 *
 * `--check` on an already-migrated project must exit zero (§62's own test
 * list). That is the property most likely to break quietly: a rule that matches
 * its own output makes every subsequent CI run fail, and nobody notices until
 * the migration is already released.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  applyMigrations,
  blankComments,
  importRanges,
  localExportRanges,
  maskSource,
  reExportRanges,
  type ProjectFile,
} from '../engine.js';
import { MIGRATIONS, selectMigrations, knownPairs } from '../registry.js';
import { renderIndex, renderSnippet } from '../guide.js';
import { parseMigrateArgs, migrateCommand } from '../index.js';
import type { Migration } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

function fixture(pair: string, side: 'before' | 'after', file: string): string {
  return readFileSync(join(FIXTURES, pair, side, file), 'utf8');
}

/** All migrations, prospective included — fixtures test rules, not release state. */
const ALL = MIGRATIONS;

function run(files: ProjectFile[], migrations: readonly Migration[] = ALL) {
  return applyMigrations({ files, migrations });
}

// ---------------------------------------------------------------------------

describe('golden fixture: preset audit reshape', () => {
  const PAIR = 'preset-audit-reshape';
  const FILE = 'askturret.config.json';

  it('turns the before config into the after config, byte for byte', () => {
    const result = run([{ path: FILE, contents: fixture(PAIR, 'before', FILE) }]);

    expect(result.files[0]?.contents).toBe(fixture(PAIR, 'after', FILE));
  });

  it('reports the rewrite it performed', () => {
    const result = run([{ path: FILE, contents: fixture(PAIR, 'before', FILE) }]);
    const rewrite = result.findings.find((f) => f.action === 'rewrite');

    expect(rewrite?.ruleId).toBe('preset-audit-durability-under-sink');
    expect(rewrite?.detail).toContain('audit.durability');
    expect(rewrite?.detail).toContain('audit.sink.durable');
  });

  it('leaves every unrelated setting untouched', () => {
    // A migration that reformatted the whole document would pass a "contains"
    // assertion while producing an unreviewable diff.
    const result = run([{ path: FILE, contents: fixture(PAIR, 'before', FILE) }]);
    const after = JSON.parse(result.files[0]?.contents ?? '{}') as Record<string, any>;

    expect(after['preset']).toBe('regulated');
    expect(after['transport']).toEqual({ session: 'stateless' });
    expect(after['audit'].enabled).toBe(true);
  });

  it('is IDEMPOTENT — re-running on the migrated file changes nothing', () => {
    // §62: `--check` on an already-migrated project exits zero. A rule that
    // matched its own output would fail every CI run after the migration.
    const result = run([{ path: FILE, contents: fixture(PAIR, 'after', FILE) }]);

    expect(result.changesNeeded).toBe(false);
    expect(result.changed).toEqual([]);
    expect(result.files[0]?.contents).toBe(fixture(PAIR, 'after', FILE));
  });
});

describe('changesNeeded drives the --check exit code', () => {
  it('is true when a rewrite would happen', () => {
    const result = run([
      { path: 'askturret.config.json', contents: '{"audit":{"durability":"required"}}' },
    ]);

    expect(result.changesNeeded).toBe(true);
  });

  it('is FALSE when only manual findings exist', () => {
    // The distinction that keeps `--check` usable in CI: a finding that needs a
    // human is not something `migrate` would have written, so a project that
    // heeded it would otherwise fail its build for ever.
    //
    // The fixture is a config rule with `to` OMITTED — a key that was removed,
    // which the engine reports and never rewrites. It used to be the registry's
    // `output` rule, but that now yields an advisory rather than a finding
    // (#432), which would have made this assert on the wrong thing. A removal
    // rule is the same shape and is still genuinely a finding.
    const removed: Migration = {
      from: '1.0',
      to: '2.0',
      status: 'published',
      summary: 'test',
      reference: 'test',
      rules: [
        {
          kind: 'config',
          id: 'removed-key',
          from: 'audit.durability',
          reason: 'Removed; deleting a setting an adopter wrote is their call.',
        },
      ],
    };
    const result = run(
      [{ path: 'askturret.config.json', contents: '{"audit":{"durability":"required"}}' }],
      [removed],
    );

    expect(result.findings.some((f) => f.action === 'manual')).toBe(true);
    expect(result.changesNeeded).toBe(false);
  });

  it('is FALSE when only an advisory exists (#432)', () => {
    // The advisory half of the same guarantee. An `output` rule fires on every
    // run regardless of the project, so if it could set `changesNeeded` then
    // `--check` would exit 1 for ever against the shipped registry.
    const result = run([{ path: 'unrelated.ts', contents: 'export const x = 1;\n' }]);

    expect(result.findings).toHaveLength(0);
    expect(result.advisories.length).toBeGreaterThan(0);
    expect(result.changesNeeded).toBe(false);
  });

  it('is false on an empty project', () => {
    expect(run([]).changesNeeded).toBe(false);
  });
});

describe('config rules', () => {
  it('only touches files that look like askturret config', () => {
    const result = run([
      { path: 'package.json', contents: '{"audit":{"durability":"required"}}' },
    ]);

    expect(result.changed).toEqual([]);
  });

  it('REPORTS a removed key rather than deleting it', () => {
    // Deleting a setting an adopter wrote changes their runtime behaviour in a
    // commit that claimed to be mechanical.
    const removal: Migration = {
      from: '1.0',
      to: '2.0',
      status: 'published',
      summary: 'test',
      reference: 'test',
      rules: [
        { kind: 'config', id: 'gone', from: 'legacy.flag', reason: 'It does nothing now.' },
      ],
    };
    const result = run(
      [{ path: 'askturret.config.json', contents: '{"legacy":{"flag":true}}' }],
      [removal],
    );

    expect(result.changed).toEqual([]);
    expect(result.findings[0]?.action).toBe('manual');
    expect(result.files[0]?.contents).toContain('flag');
  });

  it('still does not delete a removed key when the SAME file is rewritten by another rule', () => {
    // The previous test passes even if `moveKey` deletes the key, because a
    // document nothing rewrote is never re-serialised — so the deletion never
    // reaches the output and the assertion cannot see it.
    //
    // Found by mutation testing: deleting the key instead of reporting it kept
    // all 27 tests green. This pairs the removal with a rewrite so the file IS
    // regenerated, which is the only arrangement where the bug is observable —
    // and it is exactly the arrangement a real migration has, since migrations
    // carry several rules.
    const mixed: Migration = {
      from: '1.0',
      to: '2.0',
      status: 'published',
      summary: 'test',
      reference: 'test',
      rules: [
        // Rewrite FIRST, removal SECOND. That order is what makes the bug
        // observable: by the time the removal runs, the file has already been
        // regenerated once, so a document the removal mutated would be written.
        { kind: 'config', id: 'moved', from: 'a.b', to: 'a.c', reason: 'Renamed.' },
        { kind: 'config', id: 'gone', from: 'legacy.flag', reason: 'It does nothing now.' },
      ],
    };

    const result = run(
      [{ path: 'askturret.config.json', contents: '{"legacy":{"flag":true},"a":{"b":1}}' }],
      [mixed],
    );

    const after = JSON.parse(result.files[0]?.contents ?? '{}') as Record<string, any>;
    expect(result.changed).toEqual(['askturret.config.json']); // the rewrite happened
    expect(after['a'].c).toBe(1);
    // ...and the removed key SURVIVED the regeneration.
    expect(after['legacy'].flag).toBe(true);
  });

  it('reports a YAML config instead of silently skipping it', () => {
    // The engine rewrites JSON only. Saying so is what stops half an adopter's
    // files being ignored without anyone knowing.
    const result = run([
      { path: 'askturret.config.yaml', contents: 'audit:\n  durability: required\n' },
    ]);

    const finding = result.findings.find((f) => f.file === 'askturret.config.yaml');
    expect(finding?.action).toBe('manual');
    expect(finding?.detail).toContain('by hand');
  });
});

describe('source rules', () => {
  const rename: Migration = {
    from: '1.0',
    to: '2.0',
    status: 'published',
    summary: 'test',
    reference: 'test',
    rules: [
      {
        kind: 'source',
        id: 'renamed',
        from: 'oldName',
        to: 'newName',
        module: '@askturret/mcp-core',
        reason: 'Renamed.',
      },
    ],
  };

  // -------------------------------------------------------------------------
  // Re-exports (#284).
  //
  // The defect was the failure signature #230 exists for, one shape over: a
  // file whose only affected code is `export { x } from '…'` produced output
  // byte-identical and `findings: []`. Not a rewrite, not a refusal — nothing.
  // A clean report that is not evidence of a clean migration.
  //
  // OBSERVED BEFORE THE FIX, against the built engine, for every shape:
  //
  //   re-export, named        rewritten=false  findings=0   <- the filed bug
  //   re-export, aliased      rewritten=false  findings=0
  //   re-export, type-only    rewritten=false  findings=0
  //   re-export, inline type  rewritten=false  findings=0
  //   export * / * as ns      rewritten=false  findings=0   <- correct, see below
  //
  // They are now REPORTED and deliberately NOT rewritten. Writing out what the
  // rewrite would produce is what settles it:
  //
  //   export { oldName } from 'mod'  ->  export { newName } from 'mod'
  //
  // which changes the name the ADOPTER'S module exports, breaking their
  // consumers — the tool making a breaking change to a third party's public
  // API while reporting a successful migration. Same principle the registry
  // already applies to `output` rules: adopter logic is not ours to edit.
  // -------------------------------------------------------------------------

  it('reports a re-export naming a renamed symbol rather than passing it silently (#284)', () => {
    const contents = `export { oldName } from '@askturret/mcp-core';\n`;
    const result = run([{ path: 'src/api.ts', contents }], [rename]);

    // Not rewritten — the adopter's public surface is not ours to change.
    expect(result.files[0]?.contents).toBe(contents);

    // ...and not SILENT, which is the whole defect. `findings: []` here was a
    // clean report on unhandled work.
    const manual = result.findings.filter((f) => f.action === 'manual');
    expect(manual).toHaveLength(1);
    expect(manual[0]?.file).toBe('src/api.ts');
    // The reason must name the re-export, not a generic refusal: an adopter
    // deciding whether to act needs to know it is their export surface.
    expect(manual[0]?.detail).toMatch(/re-export/);
    expect(manual[0]?.detail).toMatch(/line\(s\) 1/);
  });

  it.each([
    ['type-only', `export type { oldName } from '@askturret/mcp-core';\n`],
    ['inline type', `export { type oldName } from '@askturret/mcp-core';\n`],
  ])('...and the %s form is reported too, not just the plain one (#284)', (_label, contents) => {
    // An enumeration that stops where someone happened to look is how the
    // original gap survived. Both were silent before the fix.
    const result = run([{ path: 'src/api.ts', contents }], [rename]);

    expect(result.files[0]?.contents).toBe(contents);
    const manual = result.findings.filter((f) => f.action === 'manual');
    expect(manual).toHaveLength(1);
    // THE REASON, not just the count (#284 QA). `toHaveLength(1)` alone passed
    // while `export type { oldName } from` was being reported as `object
    // shorthand` — a true count attached to a false explanation. These are the
    // BOTH-names shapes, so that is the reason they must carry.
    expect(manual[0]?.detail).toMatch(/re-export/);
    expect(manual[0]?.detail).toMatch(/both the imported symbol and the name YOUR module exports/);
  });

  // ---------------------------------------------------------------------------
  // The SOURCE position is rewritten, and refusing it was wrong (#284 QA).
  //
  // `export { oldName as legacy } from 'mod'` does not name the adopter's
  // public surface with `oldName` — it names it with `legacy`, which the rename
  // does not touch. So the refusal reason shipped for it ("rewriting it would
  // change what YOUR module exports") was FALSE of this code, and refusing left
  // a file that does not compile: after the upstream rename, `oldName` is not
  // exported by the module at all.
  //
  // Rewriting the source name preserves the public surface EXACTLY and is the
  // only edit that fixes the reference. It is the same operation already
  // applied to `import { oldName as legacy }`, on the same grounds.
  // ---------------------------------------------------------------------------
  it('REWRITES the source name of an aliased re-export, preserving the public name (#284)', () => {
    const contents = `export { oldName as legacy } from '@askturret/mcp-core';\n`;
    const result = run([{ path: 'src/api.ts', contents }], [rename]);

    expect(result.files[0]?.contents).toBe(`export { newName as legacy } from '@askturret/mcp-core';\n`);
    // The public name is what must survive untouched.
    expect(result.files[0]?.contents).toContain('as legacy');
    expect(result.findings.filter((f) => f.action === 'rewrite')).toHaveLength(1);
    expect(result.findings.filter((f) => f.action === 'manual')).toHaveLength(0);
  });

  it('...and the type-only aliased form is rewritten the same way (#284)', () => {
    const contents = `export type { oldName as legacy } from '@askturret/mcp-core';\n`;
    const result = run([{ path: 'src/api.ts', contents }], [rename]);

    expect(result.files[0]?.contents).toBe(`export type { newName as legacy } from '@askturret/mcp-core';\n`);
    expect(result.findings.filter((f) => f.action === 'manual')).toHaveLength(0);
  });

  it('REFUSES the public name of an aliased re-export — the hazard shape (#284)', () => {
    // The mirror, and the one the whole guard exists for. Here `oldName` IS the
    // adopter's export name, so rewriting would silently rename what their
    // consumers import. Verified as the real hazard: with the re-export guard
    // removed this line is rewritten to `other as newName`.
    const contents = `export { other as oldName } from '@askturret/mcp-core';\n`;
    const result = run([{ path: 'src/api.ts', contents }], [rename]);

    expect(result.files[0]?.contents).toBe(contents);
    const manual = result.findings.filter((f) => f.action === 'manual');
    expect(manual).toHaveLength(1);
    expect(manual[0]?.detail).toMatch(/this is the name YOUR module exports/);
  });

  it.each([
    ['export *', `export * from '@askturret/mcp-core';\n`],
    ['export * as ns', `export * as core from '@askturret/mcp-core';\n`],
  ])('...while %s is silent CORRECTLY, naming no symbol (#284)', (_label, contents) => {
    // FALSIFIABLE VERSION (#284 QA). The star is PAIRED WITH A REAL IMPORT of
    // the symbol, and that pairing is what gives this assertion a job.
    //
    // Alone, a star file has no occurrence of `oldName` at all, so
    // `rewriteSource` returns early twice — at the `importsIt || reExportsIt`
    // gate and again on `indices.length === 0` — both BEFORE any re-export
    // logic runs. No change to `reExportRanges` could redden it, so it read as
    // "checked and inert" while checking nothing.
    //
    // With the import present the file reaches the re-export logic, and the
    // star must still contribute nothing: exactly one rewrite (the import) and
    // no finding attributable to the star.
    const result = run(
      [
        {
          path: 'src/api.ts',
          contents: `import { oldName } from '@askturret/mcp-core';\n${contents}oldName();\n`,
        },
      ],
      [rename],
    );

    const out = result.files[0]?.contents ?? '';
    // The star line survives byte-for-byte...
    expect(out).toContain(contents.trim());
    // ...and it produced no refusal of its own.
    expect(result.findings.filter((f) => f.action === 'manual')).toHaveLength(0);
    expect(result.findings.filter((f) => f.action === 'rewrite')).toHaveLength(1);
  });

  it('still rewrites an import in a file that ALSO re-exports (#284)', () => {
    // The paired positive. Without it, every assertion above is satisfied by a
    // rewriter that refuses everything in any file containing the word
    // `export` — which would be a regression dressed as a fix.
    const contents =
      `import { oldName } from '@askturret/mcp-core';\n` +
      `export { oldName } from '@askturret/mcp-core';\n` +
      `oldName();\n`;
    const result = run([{ path: 'src/api.ts', contents }], [rename]);

    const out = result.files[0]?.contents ?? '';
    expect(out).toContain(`import { newName } from '@askturret/mcp-core';`);
    expect(out).toContain(`newName();`);
    // ...and the re-export line is untouched, on its own terms.
    expect(out).toContain(`export { oldName } from '@askturret/mcp-core';`);

    expect(result.findings.filter((f) => f.action === 'rewrite')).toHaveLength(1);
    expect(result.findings.filter((f) => f.action === 'manual')).toHaveLength(1);
  });

  it('rewrites an imported identifier at its call sites', () => {
    const result = run(
      [
        {
          path: 'src/app.ts',
          contents: `import { oldName } from '@askturret/mcp-core';\noldName();\n`,
        },
      ],
      [rename],
    );

    expect(result.files[0]?.contents).toBe(
      `import { newName } from '@askturret/mcp-core';\nnewName();\n`,
    );
  });

  it('leaves a same-named symbol from a DIFFERENT module alone', () => {
    // The check that makes this safe to run over someone's whole project.
    const contents = `import { oldName } from 'some-other-lib';\noldName();\n`;
    const result = run([{ path: 'src/app.ts', contents }], [rename]);

    expect(result.files[0]?.contents).toBe(contents);
    expect(result.changed).toEqual([]);
  });

  it('does not rewrite the name inside a string or a comment', () => {
    const result = run(
      [
        {
          path: 'src/app.ts',
          contents:
            `import { oldName } from '@askturret/mcp-core';\n` +
            `// oldName is deprecated\n` +
            `const label = 'oldName';\n` +
            `oldName();\n`,
        },
      ],
      [rename],
    );

    const out = result.files[0]?.contents ?? '';
    expect(out).toContain('// oldName is deprecated');
    expect(out).toContain(`const label = 'oldName';`);
    expect(out).toContain('newName();');
  });

  it('REPORTS a removed export rather than rewriting it', () => {
    const removal: Migration = {
      ...rename,
      rules: [
        {
          kind: 'source',
          id: 'removed',
          from: 'goneName',
          module: '@askturret/mcp-core',
          reason: 'Removed with no replacement.',
        },
      ],
    };
    const contents = `import { goneName } from '@askturret/mcp-core';\ngoneName();\n`;
    const result = run([{ path: 'src/app.ts', contents }], [removal]);

    expect(result.files[0]?.contents).toBe(contents);
    expect(result.findings[0]?.action).toBe('manual');
  });

  // -------------------------------------------------------------------------
  // Syntactic position: refuse rather than guess (#193)
  //
  // The file-level import gate was the ONLY gate — once a file imported the
  // identifier, every whole-word occurrence was rewritten wherever it sat. QA
  // found two shapes that corrupt adopter code AND still compile, so the
  // compile-error backstop this design leans on cannot see them.
  //
  // The rename below is `durability` → `durable` deliberately: that is the
  // reference migration, and `audit.durability` is a config key adopters
  // plausibly have. These are not contrived collisions.
  // -------------------------------------------------------------------------

  const durability: Migration = {
    from: '1.0',
    to: '2.0',
    status: 'published',
    summary: 'test',
    reference: 'test',
    rules: [
      {
        kind: 'source',
        id: 'durability-rename',
        from: 'durability',
        to: 'durable',
        module: '@askturret/mcp-core',
        reason: 'Renamed.',
      },
    ],
  };

  const runDurability = (contents: string) =>
    run([{ path: 'src/app.ts', contents }], [durability]);

  it('does NOT rename an unrelated property access on the adopter\'s own object', () => {
    // #193's worst case. `cfg` has nothing to do with the import; renaming its
    // key and its access is consistent, so it type-checks and ships a changed
    // data shape.
    const result = runDurability(
      `import { durability } from '@askturret/mcp-core';\n` +
        `const cfg = { durability: 'required' };\n` +
        `console.log(cfg.durability, durability);\n`,
    );
    const out = result.files[0]?.contents ?? '';

    // The adopter's object is untouched — key and access both.
    expect(out).toContain(`const cfg = { durability: 'required' };`);
    expect(out).toContain('cfg.durability');
    // ...while the import and the genuine reference are renamed.
    expect(out).toContain(`import { durable } from '@askturret/mcp-core';`);
    expect(out).toContain('durable);');
    // ...and the refusal is REPORTED, not silent. That is the whole point:
    // a quiet correct answer and a quiet wrong one look identical.
    const manual = result.findings.find((f) => f.action === 'manual');
    expect(manual?.detail).toContain('property access');
    expect(manual?.detail).toContain('object key');
  });

  it('does NOT rewrite object shorthand, whose emitted key is the identifier', () => {
    // `{ durability }` has key "durability". The correct rename is
    // `{ durability: durable }`, not `{ durable }` — so producing the latter
    // silently changes the adopter's runtime data.
    const result = runDurability(
      `import { durability } from '@askturret/mcp-core';\nconst o = { durability };\n`,
    );
    const out = result.files[0]?.contents ?? '';

    expect(out).toContain('const o = { durability };');
    expect(out).toContain(`import { durable } from '@askturret/mcp-core';`);

    const manual = result.findings.find((f) => f.action === 'manual');
    expect(manual?.detail).toContain('shorthand');
  });

  it('does NOT rewrite a declaration binding that shadows the import', () => {
    const result = runDurability(
      `import { durability } from '@askturret/mcp-core';\n` +
        `const durability2 = 1;\n` +
        `const durability = 2;\n`,
    );
    const out = result.files[0]?.contents ?? '';

    expect(out).toContain('const durability = 2;');
    expect(result.findings.find((f) => f.action === 'manual')?.detail).toContain('local binding');
  });

  it('still rewrites the import specifier, which has the SAME SHAPE as shorthand', () => {
    // `import { durability }` looks exactly like `{ durability }`. If the
    // shorthand rule ran first the tool would refuse the one occurrence it
    // exists to rewrite, and the rename would never happen at all.
    const result = runDurability(
      `import { durability } from '@askturret/mcp-core';\ndurability();\n`,
    );

    expect(result.files[0]?.contents).toBe(
      `import { durable } from '@askturret/mcp-core';\ndurable();\n`,
    );
    expect(result.findings.some((f) => f.action === 'manual')).toBe(false);
  });

  it('rewrites plain references that merely LOOK like shorthand', () => {
    // `f(a, durability, b)` and `[a, durability, b]` sit between commas exactly
    // as a shorthand property does. The enclosing bracket is what separates
    // them, and getting this wrong would make the tool refuse most real calls.
    const result = runDurability(
      `import { durability } from '@askturret/mcp-core';\n` +
        `f(a, durability, b);\n` +
        `const xs = [a, durability, b];\n`,
    );
    const out = result.files[0]?.contents ?? '';

    expect(out).toContain('f(a, durable, b);');
    expect(out).toContain('const xs = [a, durable, b];');
    expect(result.findings.some((f) => f.action === 'manual')).toBe(false);
  });

  it('reports refusals with line numbers, so they can be found', () => {
    // A finding that says "some occurrences were left" without saying which is
    // an apology, not a report.
    const result = runDurability(
      `import { durability } from '@askturret/mcp-core';\n` +
        `\n` +
        `const cfg = { durability: 1 };\n` +
        `console.log(cfg.durability);\n`,
    );

    const manual = result.findings.find((f) => f.action === 'manual');
    expect(manual?.detail).toContain('line(s) 3');
    expect(manual?.detail).toContain('line(s) 4');
  });

  it('emits BOTH a rewrite and a manual finding when a file has each', () => {
    // The engine used to return one finding per file per rule. A file that is
    // partly rewritten and partly refused needs both, or it misreports what
    // happened in one direction or the other.
    const result = runDurability(
      `import { durability } from '@askturret/mcp-core';\n` +
        `const cfg = { durability: 1 };\n` +
        `durability();\n`,
    );

    const actions = result.findings.map((f) => f.action).sort();
    expect(actions).toEqual(['manual', 'rewrite']);
    expect(result.changed).toEqual(['src/app.ts']);
  });

  // -------------------------------------------------------------------------
  // Import ranges are bounded to ONE statement (#230)
  //
  // #193 added the refusal checks above, but they all sit BEHIND the
  // import-specifier check — the one occurrence kind rewritten unconditionally.
  // So anything mis-classified as an import specifier bypasses every refusal
  // that issue added, and does so silently.
  //
  // `importRanges` matched `import … from '…'` with `[^;]*?` between, which
  // crosses newlines. A side-effect import (`import './x.css'`) has no `from`,
  // so in a SEMICOLON-FREE file the match ran on from that import to the `from`
  // of a LATER one — swallowing every statement in between and marking it all
  // import specifier.
  //
  // Semicolons hid it: `[^;]*?` cannot cross one. That is why #193's own tests,
  // which all use semicolons, passed throughout.
  // -------------------------------------------------------------------------

  describe('import ranges stop at one statement (#230)', () => {
    it('does not swallow statements between a side-effect import and a later from-import', () => {
      // The issue's repro, verbatim. Every line here is the adopter's own code;
      // none of it is an import specifier.
      const result = runDurability(
        `import './styles.css'\n` +
          `const cfg = { durability: 'required' }\n` +
          `console.log(cfg.durability)\n` +
          `import { x } from '@askturret/mcp-core'\n`,
      );
      const out = result.files[0]?.contents ?? '';

      expect(out).toContain(`const cfg = { durability: 'required' }`);
      expect(out).toContain('cfg.durability');
      expect(out).not.toContain('durable');
    });

    it('reports the refusal rather than staying silent about it', () => {
      // The corruption's defining property was `manual: 0` — a clean report
      // alongside changed data. Restoring the refusal without restoring the
      // report would fix half of it.
      const result = runDurability(
        `import './styles.css'\n` +
          `const cfg = { durability: 'required' }\n` +
          `console.log(cfg.durability)\n` +
          `import { x } from '@askturret/mcp-core'\n`,
      );

      expect(result.findings.some((f) => f.action === 'manual')).toBe(true);
    });

    it('refuses shorthand in the same arrangement', () => {
      // Shorthand corrupts identically here, and is worse: `{ durable }` changes
      // the emitted KEY, so the adopter's runtime data shape shifts silently.
      const result = runDurability(
        `import './styles.css'\n` + `const o = { durability }\n` + `import { x } from '@askturret/mcp-core'\n`,
      );

      expect(result.files[0]?.contents ?? '').toContain('const o = { durability }');
    });

    it('refuses with a from-import on BOTH sides of the side-effect import', () => {
      // Tester's fourth control: from-import, side-effect, code, from-import.
      // A fix that only anchored the FIRST import in the file would pass the
      // repro above and still corrupt this one.
      const result = runDurability(
        `import { a } from 'other-lib'\n` +
          `import './styles.css'\n` +
          `const cfg = { durability: 'required' }\n` +
          `import { x } from '@askturret/mcp-core'\n`,
      );

      expect(result.files[0]?.contents ?? '').toContain(`{ durability: 'required' }`);
    });

    // --- the controls that were already SAFE, pinned so the fix does not
    // --- buy correctness here by breaking them.

    it('still rewrites the genuine import specifier in a semicolon-free file', () => {
      // The point of the rule. A fix that stopped recognising import specifiers
      // would make every assertion above pass while doing nothing useful.
      const result = runDurability(
        `import './styles.css'\n` + `import { durability } from '@askturret/mcp-core'\n` + `durability()\n`,
      );
      const out = result.files[0]?.contents ?? '';

      expect(out).toContain(`import { durable } from '@askturret/mcp-core'`);
      expect(out).toContain('durable()');
    });

    it.each([
      ['default', `import d from 'other-lib'\n`],
      ['namespace', `import * as ns from 'other-lib'\n`],
      ['default + named', `import d, { a } from 'other-lib'\n`],
      ['default + namespace', `import d, * as ns from 'other-lib'\n`],
      ['type-only', `import type { T } from 'other-lib'\n`],
      ['multi-line named', `import {\n  a,\n  b,\n} from 'other-lib'\n`],
      ['side-effect', `import 'other-lib'\n`],
    ])('a leading %s import does not extend over the adopter code after it', (_form, importLine) => {
      // Bounding the match structurally means enumerating the clause shapes, and
      // a shape handled loosely lets the match run on to the NEXT `from`. Each
      // form is therefore pinned with adopter code and a later from-import
      // behind it — the arrangement that corrupts.
      const result = runDurability(
        `${importLine}` +
          `const cfg = { durability: 'required' }\n` +
          `import { x } from '@askturret/mcp-core'\n`,
      );

      expect(result.files[0]?.contents ?? '').toContain(`{ durability: 'required' }`);
    });

    it.each([
      ['named', `import { durability } from '@askturret/mcp-core'\n`],
      ['default + named', `import d, { durability } from '@askturret/mcp-core'\n`],
      ['multi-line named', `import {\n  durability,\n  other,\n} from '@askturret/mcp-core'\n`],
    ])('still rewrites the specifier in the %s form without a semicolon', (_form, importLine) => {
      // The other direction: a shape left out of the clause grammar is not a
      // crash, it silently stops being an import range — so the one occurrence
      // the rule exists to rewrite gets refused instead. Quiet under-reach.
      const result = runDurability(`${importLine}durability()\n`);
      const out = result.files[0]?.contents ?? '';

      expect(out).toContain('durable');
      expect(out).toContain('durable()');
    });

    it.each([
      ['no space before the named clause', `import{durability}from'@askturret/mcp-core'\n`],
      ['no space before the namespace clause', `import*as ns from'@askturret/mcp-core'\n`],
    ])('handles %s', (_label, importLine) => {
      // `import{a}from'x'` is valid and shows up in tight or minified source.
      // The old `[^;]*?` accepted it, so a grammar demanding whitespace would
      // have narrowed behaviour without anything failing — under-reach again.
      const result = runDurability(`${importLine}const cfg = { durability: 1 }\n`);
      const out = result.files[0]?.contents ?? '';

      // The adopter's object is refused either way; what is pinned here is that
      // the import statement itself is still RECOGNISED and bounded.
      expect(out).toContain('const cfg = { durability: 1 }');
    });

    it('rewrites the specifier when there is no space around the clause', () => {
      const result = runDurability(`import{durability}from'@askturret/mcp-core'\ndurability()\n`);
      const out = result.files[0]?.contents ?? '';

      expect(out).toContain('import{durable}from');
      expect(out).toContain('durable()');
    });

    it('was always safe WITH semicolons, and still is', () => {
      // The control that explains why this survived #193: `[^;]*?` cannot cross
      // a semicolon, so the identical shape was never affected.
      const result = runDurability(
        `import './styles.css';\n` +
          `const cfg = { durability: 'required' };\n` +
          `import { x } from '@askturret/mcp-core';\n`,
      );

      expect(result.files[0]?.contents ?? '').toContain(`{ durability: 'required' }`);
    });
  });

  // -------------------------------------------------------------------------
  // Statement-aware classification of a LOCAL `export { … }` (#424)
  //
  // `classifyOccurrence` decided `shorthand` from pure local syntax and never
  // consulted the enclosing statement, so one category covered four positions
  // and its reason — "renaming it changes the emitted key" — was true of
  // exactly one. A local export specifier has no emitted key.
  //
  // The premise this issue was FILED on is false and worth restating, because
  // it inverts which option is cautious: a `SourceRule` with `to` defined means
  // `durability` is GONE from the module, so the adopter's file does not
  // compile BEFORE migrate runs. Refusing both halves is not conservative — it
  // leaves them exactly where they started plus a manual finding.
  //
  // THE BOUNDARY, as one discriminator: is the refusal self-contained — does
  // refusing this occurrence leave valid code in the statement containing it?
  // Yes -> refuse. No -> the tool owes a correct edit.
  // -------------------------------------------------------------------------
  describe('local `export { … }` is classified by its statement (#424)', () => {
    it('rewrites `export { durability }` to an alias, leaving a file that compiles', () => {
      // THE HEADLINE ACCEPTANCE. Before this, the import was rewritten and the
      // export was refused as "object shorthand", emitting a file that exported
      // a binding which no longer existed.
      const result = runDurability(
        `import { durability } from '@askturret/mcp-core';\nexport { durability };\n`,
      );
      const out = result.files[0]?.contents ?? '';

      expect(out).toBe(
        `import { durable } from '@askturret/mcp-core';\nexport { durable as durability };\n`,
      );

      // The compile property, checked as COHERENCE rather than as a string
      // match: the binding the export names must be the one the import now
      // provides. A half-migrated file is precisely where these two disagree.
      const imported = /import \{ (\w+) \}/.exec(out)?.[1];
      const exportedBinding = /export \{ (\w+) as/.exec(out)?.[1];
      expect(imported).toBe('durable');
      expect(exportedBinding).toBe(imported);

      // ...and the public surface is untouched, which is why blast radius is zero.
      expect(out).toContain('as durability');
    });

    it('reports the alias, says it was deliberate, and says how to undo it', () => {
      // A judgement made on someone's behalf has to be visible and reversible,
      // or it is a silent edit with better intentions.
      const result = runDurability(
        `import { durability } from '@askturret/mcp-core';\nexport { durability };\n`,
      );
      const detail = result.findings.map((f) => f.detail).join('\n');

      expect(detail).toContain(`'export { durable as durability }'`);
      expect(detail).toContain('deliberately');
      expect(detail).toContain(`delete ' as durability'`);
      // No occurrence is refused on this path, so nothing is reported `manual`.
      expect(result.findings.every((f) => f.action === 'rewrite')).toBe(true);
    });

    it('REFUSES local `export { other as durability }` — that name is the public one', () => {
      // THE SCOPE ADDITION, witnessed rather than assumed to fall out.
      //
      // On main this classified as `reference`, because `precedingWord` is `as`
      // and `as` is not a binding keyword — so it was silently REWRITTEN,
      // renaming the adopter's public export. That is the `re-export-public`
      // hazard #421 closed, in the statement kind #421 cannot match: its range
      // function requires a `from` clause.
      const result = runDurability(
        `import { other } from '@askturret/mcp-core';\n` +
          `import { durability } from '@askturret/mcp-core';\n` +
          `export { other as durability };\n`,
      );
      const out = result.files[0]?.contents ?? '';

      expect(out).toContain('export { other as durability }');
      expect(out).not.toContain('as durable');

      const manual = result.findings.filter((f) => f.action === 'manual');
      expect(manual.length).toBeGreaterThan(0);
      expect(manual.map((f) => f.detail).join('\n')).toContain('the name YOUR module exports');
    });

    it('rewrites local `export { durability as legacy }` — the public name is `legacy`', () => {
      // The source position. `as` decides here exactly as it does for a
      // re-export: the public name is `legacy` either way, so rewriting the
      // binding preserves the surface exactly.
      const result = runDurability(
        `import { durability } from '@askturret/mcp-core';\nexport { durability as legacy };\n`,
      );
      const out = result.files[0]?.contents ?? '';

      expect(out).toContain('export { durable as legacy }');
      expect(out).toContain('import { durable }');
    });

    it('leaves #421\'s re-export refusals exactly as they were', () => {
      // THE BOUNDARY. Refusing these IS self-contained — each statement stays
      // valid as written — so "your judgement, not mine" is honest, and #421's
      // behaviour must be untouched by the new range function. What keeps the
      // two sets disjoint is that a local match is DROPPED when a re-export
      // range starts at the same index (#454). That was a `from` lookahead in
      // `localExportRanges` until #454 removed it — see the anchor assertion
      // in the #454 block for the precondition the drop rests on.
      const both = runDurability(`export { durability } from '@askturret/mcp-core';\n`);
      expect(both.files[0]?.contents ?? '').toContain(
        `export { durability } from '@askturret/mcp-core'`,
      );
      expect(both.findings.some((f) => f.action === 'manual')).toBe(true);

      const asPublic = runDurability(`export { other as durability } from '@askturret/mcp-core';\n`);
      expect(asPublic.files[0]?.contents ?? '').toContain('export { other as durability }');

      // ...and the source position of a re-export is still REWRITTEN.
      const asSource = runDurability(`export { durability as legacy } from '@askturret/mcp-core';\n`);
      expect(asSource.files[0]?.contents ?? '').toContain('export { durable as legacy }');
    });

    it('CONTROL: a re-export refusal says "re-export", which was already true on main', () => {
      // NAMED AS A CONTROL BECAUSE IT IS ONE (#454, second finding).
      //
      // This was `no longer calls an export specifier "object shorthand"`, a
      // witness name over a re-export fixture — which #421 already reported as
      // `re-export` before #424 existed. It passes both ways and was never
      // among that issue's reds, so the name promised a guarantee the assertion
      // does not carry.
      //
      // The local case the old name described IS covered, by
      // `REFUSES local export { other as durability }` above: that one reddens
      // on a reverted tree, because main classified it `reference` and rewrote
      // it silently. Coverage was always intact; only the label was wrong.
      //
      // Kept rather than deleted: it pins that #424's new range function did
      // not disturb #421's reason text, which is a real property even though
      // no revert of #424 can break it.
      const result = runDurability(`export { durability } from '@askturret/mcp-core';\n`);
      const detail = result.findings.map((f) => f.detail).join('\n');

      expect(detail).not.toContain('object shorthand');
      expect(detail).toContain('re-export');
    });
  });

  // -------------------------------------------------------------------------
  // A comment is not a statement boundary (#454)
  //
  // The local/re-export split was decided by `(?!\s*\bfrom\b)` over the RAW
  // text. `\s*` cannot cross `/* c */`, so a re-export written with a comment
  // in the gap fell into `localExportRanges` and took local policy — two
  // near-identical files given different treatment on an incidental comment.
  //
  // The measured population is wider than "a comment in the gap", and every
  // row below was observed before anything was changed:
  //
  //   export { X } /* c */ from 'm'     re-export -> REWRITTEN under local policy
  //   export { X } // c \n from 'm'     same
  //   export type { X } /* c */ from    same, for the type-only form
  //   export /* c */ { X } from 'm'     matched NEITHER range -> "object shorthand"
  //   export { other as X } /* c */ fr  refused both ways, but with a DIFFERENT reason
  //   export { X } \n from.f()          local -> refused as "object shorthand"
  //
  // The last row is the reverse direction, and it matters that it exists: the
  // lookahead was equally wrong about an identifier that merely spells `from`.
  //
  // THE FIX IS NOT A CLEVERER PATTERN. The engine already computes a
  // length-preserving mask in which comments are whitespace; the split simply
  // was not consulting it. Deciding it over a comment-blanked view makes both
  // directions fall out, and disjointness is now structural — a local match is
  // dropped when a re-export range STARTS at the same index, so the two sets
  // cannot disagree about a statement even in principle.
  // -------------------------------------------------------------------------
  describe('a comment does not change which policy a statement gets (#454)', () => {
    const CORE = '@askturret/mcp-core';

    /** Policy, as the adopter sees it: the emitted text and every finding. */
    const policyOf = (contents: string, comment: string) => {
      const result = runDurability(contents);
      const strip = (s: string) => s.split(comment).join('').replace(/[ \t]+/g, ' ');
      return {
        out: strip(result.files[0]?.contents ?? ''),
        actions: result.findings.map((f) => f.action).join(','),
        details: strip(result.findings.map((f) => f.detail).join('\n')),
      };
    };

    // The pair the issue is named for. Same statement, one comment apart.
    it('`export { X } /* c */ from` gets the same policy as `export { X } from`', () => {
      const plain = policyOf(`export { durability } from '${CORE}';\n`, '/* c */');
      const commented = policyOf(`export { durability } /* c */ from '${CORE}';\n`, '/* c */');

      expect(commented).toEqual(plain);
      // ...and the policy is still #421's refusal, not local-export aliasing.
      expect(commented.actions).toBe('manual');
      expect(commented.details).toContain('re-export');
    });

    it('...and so does the line-comment form, which spans a newline', () => {
      const plain = policyOf(`export { durability } from '${CORE}';\n`, '// c');
      const commented = policyOf(`export { durability } // c\nfrom '${CORE}';\n`, '// c');

      expect(commented.actions).toBe(plain.actions);
      expect(commented.details).toBe(plain.details);
      expect(commented.out).toContain('export { durability }');
      expect(commented.out).not.toContain('as durability');
    });

    it('...and the type-only form', () => {
      const plain = policyOf(`export type { durability } from '${CORE}';\n`, '/* c */');
      const commented = policyOf(`export type { durability } /* c */ from '${CORE}';\n`, '/* c */');

      expect(commented).toEqual(plain);
    });

    it('...and a comment BEFORE the clause, which matched neither range', () => {
      // This one did not take local policy — it fell out of both range sets and
      // was refused as `object shorthand`, a reason that is false of a
      // re-export specifier and sends the reader looking for an object literal.
      const plain = policyOf(`export { durability } from '${CORE}';\n`, '/* c */');
      const commented = policyOf(`export /* c */ { durability } from '${CORE}';\n`, '/* c */');

      expect(commented.details).not.toContain('object shorthand');
      expect(commented).toEqual(plain);
    });

    it('THE HAZARD stays refused with the SAME reason, comment or not (#421)', () => {
      // Acceptance item 3. `other as durability` renames the adopter's public
      // export, and refusing it is #421's whole point. It was refused both ways
      // already — but the REASON differed (`re-export alias` vs `export
      // alias`), which is the same defect one layer down: the report told two
      // adopters different things about identical code.
      const plain = policyOf(`export { other as durability } from '${CORE}';\n`, '/* c */');
      const commented = policyOf(
        `export { other as durability } /* c */ from '${CORE}';\n`,
        '/* c */',
      );

      expect(commented.actions).toBe('manual');
      expect(commented.out).toContain('export { other as durability }');
      expect(commented.out).not.toContain('as durable');
      expect(commented).toEqual(plain);
    });

    it('THE REVERSE DIRECTION: `from` as an identifier is not a re-export', () => {
      // A semicolonless local export followed by a statement that begins with
      // the identifier `from`. The lookahead saw the word and excluded the
      // statement from local ranges, so #424's repair did not apply and the
      // occurrence was refused as `object shorthand`.
      //
      // The split now asks whether a re-export range actually STARTS here,
      // and a re-export needs a module string after `from` — `from.something()`
      // has none.
      const result = runDurability(
        `import { durability } from '${CORE}';\nexport { durability }\nfrom.something();\n`,
      );
      const out = result.files[0]?.contents ?? '';

      expect(out).toContain('export { durable as durability }');
      expect(out).toContain('from.something();');
      expect(result.findings.map((f) => f.detail).join('\n')).not.toContain('object shorthand');
    });

    it('CONTROL: the comment itself is preserved verbatim in the output', () => {
      // The split reads a blanked VIEW; the edit still lands on the original
      // text. If this ever fails, the rewriter is writing to the wrong string.
      const result = runDurability(
        `import { durability } from '${CORE}';\nexport { durability } /* keep me */;\n`,
      );
      expect(result.files[0]?.contents ?? '').toContain('/* keep me */');
    });

    it('THE PRECONDITION the drop rests on: both sets anchor at `export`', () => {
      // `localExportRanges` drops a match when a re-export range STARTS at the
      // same index. Exact only because both functions anchor at `\bexport\b`
      // over the same string — re-anchor either one and the indices stop
      // corresponding, the drop silently stops firing, and overlap returns.
      //
      // NOTHING OBSERVABLE CATCHES THAT, which is why this is asserted on the
      // range directly rather than through a fixture. Measured before writing
      // it: re-anchoring `reExportRanges` at the `{` leaves the suite at
      // 511/511, because `classifyOccurrence` consults re-export ranges first,
      // so the drop is redundant for every fixture here. The guarantee is real
      // and the evidence for it was absent — the shape this PR fixes, one
      // level up.
      const src = `const x = 1;\nexport { durability } from '${CORE}';\n`;
      const ranges = reExportRanges(src, src);

      expect(ranges.length).toBe(1);
      expect(ranges[0]?.[0]).toBe(src.indexOf('export'));
      // ...and not the brace, which is the re-anchoring that breaks the drop.
      expect(ranges[0]?.[0]).not.toBe(src.indexOf('{'));
    });

    it('blanking a comment never reaches inside a STRING', () => {
      // Blanking from `//` without tracking string state eats to end of line,
      // which here swallows the whole re-export that follows on the same line —
      // hiding it from `reExportRanges` and re-routing it to local policy. That
      // is this very defect, reintroduced through its own fix.
      //
      // ASSERTED AT THE HELPER, DELIBERATELY, and the reason is a finding in
      // its own right: an end-to-end fixture cannot decide this today. `masked`
      // — the other view, built from a comment regex followed by a string regex
      // — mangles `const u = 'x//y';` on `main` as well as here: the comment
      // pass eats the closing quote, so the string pass then pairs the opening
      // quote with the next one further down the file and blanks everything
      // between. The re-export's occurrence is masked out and reported NOWHERE.
      // Measured on both trees before writing this. Reported, not fixed here.
      const src = `const u = 'x//y'; export { durability } from '${CORE}';\n`;
      const blanked = blankComments(src);

      expect(blanked).toBe(src); // nothing here is a comment
      expect(blanked).toContain(`export { durability } from '${CORE}'`);

      // ...while a real comment in the same position IS blanked, so the
      // assertion above is not passing because the helper does nothing.
      expect(blankComments(`export { a } /* c */ from 'm';`)).toBe(
        `export { a }         from 'm';`,
      );
      // A line comment keeps its newline, or every line number below it moves.
      expect(blankComments(`export { a } // c\nfrom 'm';`)).toBe(
        `export { a }     \nfrom 'm';`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // The destructuring half of the same split (#425, subsumed by #424)
  //
  // `const { durability } = obj` was reported as "object shorthand — renaming
  // it changes the emitted key". There is no emitted key: this READS a property
  // and binds a local name. The reason was wrong because the CATEGORY was.
  // -------------------------------------------------------------------------
  describe('destructuring is not object shorthand (#425)', () => {
    it('refuses a destructuring pattern for a reason that is true of it', () => {
      // The destructured binding is deliberately unused: this fixture isolates
      // how the POSITION is classified, and referencing it would also drag in
      // the shadowing gap the engine documents as out of remit.
      const result = runDurability(
        `import { durability } from '@askturret/mcp-core';\n` +
          `durability();\n` +
          `function read(cfg) {\n  const { durability } = cfg;\n  return 0;\n}\n`,
      );
      const detail = result.findings.map((f) => f.detail).join('\n');

      expect(result.files[0]?.contents ?? '').toContain('const { durability } = cfg');
      expect(detail).toContain('destructuring pattern');
      expect(detail).not.toContain('object shorthand');
    });

    it('still calls a genuine object literal "object shorthand"', () => {
      // The control. Without it the split passes by relabelling EVERYTHING as
      // destructuring, which would make the reason false in the one place it
      // was true.
      const result = runDurability(
        `import { durability } from '@askturret/mcp-core';\nconst o = { durability };\n`,
      );
      const detail = result.findings.map((f) => f.detail).join('\n');

      expect(result.files[0]?.contents ?? '').toContain('const o = { durability }');
      expect(detail).toContain('object shorthand');
      expect(detail).not.toContain('destructuring pattern');
    });
  });
  // ---------------------------------------------------------------------------
  // A `//` INSIDE A STRING blanked a region, and its occurrences vanished (#527)
  //
  // `masked` was three chained regexes. The line-comment pass blanked from `//`
  // to end of line without knowing it was inside a string, so `"https://x"` lost
  // its closing quote; the string pass then paired the orphaned opener with the
  // NEXT quote further down and blanked everything between.
  //
  // The consequence is the worst class here: the word scan runs over `masked`, so
  // occurrences in that region were not refused and not reported `manual` — they
  // were never seen. `findings: []` on a file with unhandled work.
  //
  // THE POPULATION IS NARROWER THAN THE FILING ASSUMED, measured on the
  // unmodified tree before any change. A single such string followed by an
  // occurrence on a LATER line is fine, because the blanking stops at end of line
  // and no quote is left to pair with. It takes an occurrence on the SAME line,
  // or a second string to close the trap.
  // ---------------------------------------------------------------------------
  describe('a `//` inside a string no longer blanks the code after it (#527)', () => {
    const CORE = '@askturret/mcp-core';
    const IMPORT = `import { durability } from '${CORE}';\n`;

    // WITNESSES. Each was silent before: `durability` survived unrenamed with no
    // finding of any kind, which is why neither can be caught by asserting on the
    // findings list alone.
    const silent: Array<[string, string]> = [
      ['on the same line as the string', `const u = "https://x"; console.log(durability);\n`],
      ['between two strings, where the quotes re-pair', `const a = "https://x";\nconsole.log(durability);\nconst b = "https://y";\n`],
      ["single-quoted, the form a module specifier uses", `const a = 'https://x';\nconsole.log(durability);\nconst b = 'https://y';\n`],
      ['template literals, which have their own escaping rules', `const a = \`https://x\`;\nconsole.log(durability);\nconst b = \`https://y\`;\n`],
      ['an escaped quote before the `//`', `const s = "a \\" // b"; console.log(durability);\n`],
    ];

    it.each(silent)('the occurrence is seen again: %s', (_name, body) => {
      const result = runDurability(IMPORT + body);
      const out = result.files[0]?.contents ?? '';

      expect(out).toContain('console.log(durable)');
      expect(out).not.toContain('durability');
      // The literal that caused the trouble is untouched — the mask is a VIEW,
      // and edits land on the original text. Taken from the fixture rather than
      // hardcoded, so the escaped-quote row asserts its own string.
      const literal = /(["'`])(.*?)\1/.exec(body)?.[0];
      expect(literal).toBeDefined();
      expect(out).toContain(literal as string);
    });

    // CONTROLS. The mask still has to mask, or the fix is just "stop masking".
    it('CONTROL: an occurrence genuinely inside a string is still left alone', () => {
      const result = runDurability(`${IMPORT}const s = "durability is a word";\n`);
      expect(result.files[0]?.contents ?? '').toContain('"durability is a word"');
    });

    it('CONTROL: an occurrence inside a comment is still left alone', () => {
      const result = runDurability(`${IMPORT}// durability lives here\n`);
      expect(result.files[0]?.contents ?? '').toContain('// durability lives here');
    });

    it("CONTROL: an apostrophe in a comment does not open a string", () => {
      // Comments are consumed before strings, so `don't` cannot swallow the rest
      // of the file as a string literal. This is the ordering the old chained
      // passes could not express.
      const result = runDurability(`${IMPORT}// don't panic\nconsole.log(durability);\n`);
      expect(result.files[0]?.contents ?? '').toContain('console.log(durable)');
    });

    // ---------------------------------------------------------------------
    // THE DURABLE HALF: an unanalysable region is REPORTED, never omitted.
    //
    // Fixing the mask removes today's silent region. It does not stop the next
    // one — an unterminated construct still makes everything after it
    // unanalysable. Before, those matched no regex at all, so NOTHING was
    // blanked and occurrences past the failure were REWRITTEN: edits made from a
    // parse that had already failed. Now the region is blanked AND announced.
    // ---------------------------------------------------------------------
    const unterminated: Array<[string, string, string]> = [
      ['string literal', `const s = "oops\nconsole.log(durability);\n`, 'string literal'],
      ['block comment', `/* oops\nconsole.log(durability);\n`, 'block comment'],
    ];

    it.each(unterminated)('an unterminated %s is reported, not swallowed', (_name, body, kind) => {
      const result = runDurability(IMPORT + body);
      const out = result.files[0]?.contents ?? '';

      // Nothing past the failed parse was edited.
      expect(out).toContain('console.log(durability)');

      const manual = result.findings.filter((f) => f.action === 'manual');
      expect(manual.length).toBe(1);
      expect(manual[0]?.detail).toContain(kind);
      expect(manual[0]?.detail).toContain('line 2');
      // It says the region was not examined, rather than implying it was clean.
      expect(manual[0]?.detail).toContain('could not be analysed');
    });

    it('...and it is reported even when it is the ONLY thing to say', () => {
      // THE ASSERTION THAT CLOSES THE CLASS. Here every occurrence lives inside
      // the unanalysable region, so the rule finds none and takes the
      // no-occurrences path — the exact path that used to return `findings: []`
      // about code it never examined. An empty report and a clean file must not
      // look identical.
      const result = runDurability(`const s = "oops\n${IMPORT}console.log(durability);\n`);

      expect(result.findings.length).toBe(1);
      expect(result.findings[0]?.action).toBe('manual');
      expect(result.findings[0]?.detail).toContain('string literal');
      // ...and nothing was edited, because nothing could be read.
      expect(result.files[0]?.contents ?? '').toContain('console.log(durability)');
    });
  });

  // -------------------------------------------------------------------------
  // A comment in an IMPORT statement broke the emitted file (#526)
  //
  // `importRanges` matched against the raw text, so `import { x } /* c */ from`
  // was not recognised as an import statement. The specifier was then refused
  // and reported `manual` — while the file-level scan renamed the reference in
  // the body regardless. Half of a paired edit.
  //
  // WHY THIS IS WORSE THAN #454'S MISROUTE, and why "reported, not silent" is
  // not the mitigation it sounds like: the output DOES NOT COMPILE. A refusal
  // is a safe outcome only when it is the whole outcome.
  //
  // Measured on the unmodified tree — SIX shapes, not the one filed:
  //
  //   import { x } /* c */ from 'm'        block comment in the gap
  //   import { x } // c \n from 'm'        line comment in the gap
  //   import /* c */ { x } from 'm'        before the clause
  //   import/* c */{ x } from 'm'          no whitespace at all
  //   import type { x } /* c */ from 'm'   the type-only form
  //   import d, { x } /* c */ from 'm'     default + named
  //
  // Three near-misses do NOT break and are kept below as controls, because
  // "the fix stopped breaking things" and "the fix stopped doing anything" look
  // identical without them.
  // -------------------------------------------------------------------------
  describe('a comment in an import statement no longer breaks the output (#526)', () => {
    const CORE = '@askturret/mcp-core';
    const USE = 'console.log(durability);\n';

    /**
     * THE INVARIANT, asserted directly rather than left implied by fixtures.
     *
     * A refused specifier must never coexist with a renamed reference. Stated
     * as a property over the emitted file, so it holds for shapes nobody
     * thought to enumerate — which is the whole lesson of #454 turning out to
     * be six shapes rather than one.
     */
    const halfEdited = (out: string): boolean => {
      const lines = out.split('\n');
      const specifierStale = lines.some((l) => l.trimStart().startsWith('import') && /\bdurability\b/.test(l));
      const bodyRenamed = lines.some((l) => !l.trimStart().startsWith('import') && /\bdurable\b/.test(l));
      return specifierStale && bodyRenamed;
    };

    it('CONTROL: the invariant check can actually fail', () => {
      // An invariant that never returns true is decorative. This is the exact
      // output the unfixed engine produced, pasted as a literal.
      expect(halfEdited(`import { durability } /* c */ from '${CORE}';\nconsole.log(durable);\n`)).toBe(true);
      expect(halfEdited(`import { durable } from '${CORE}';\nconsole.log(durable);\n`)).toBe(false);
    });

    const broke: Array<[string, string]> = [
      ['a block comment in the gap', `import { durability } /* c */ from '${CORE}';\n${USE}`],
      ['a line comment in the gap', `import { durability } // c\nfrom '${CORE}';\n${USE}`],
      ['a comment before the clause', `import /* c */ { durability } from '${CORE}';\n${USE}`],
      ['a comment and no whitespace at all', `import/* c */{ durability } from '${CORE}';\n${USE}`],
      ['the type-only form', `import type { durability } /* c */ from '${CORE}';\n${USE}`],
      ['a default binding alongside', `import d, { durability } /* c */ from '${CORE}';\n${USE}`],
    ];

    it.each(broke)('the specifier and the reference move together: %s', (_name, src) => {
      const result = runDurability(src);
      const out = result.files[0]?.contents ?? '';

      expect(halfEdited(out)).toBe(false);
      // ...and it moved forward rather than being left alone wholesale: the
      // invariant is also satisfied by refusing everything, which would be a
      // different regression.
      expect(out).toContain('durable');
      expect(out).not.toContain('durability');
      // The comment itself survives — the match reads a VIEW, the edit lands on
      // the original text.
      expect(out).toContain(src.includes('// c') ? '// c' : '/* c */');
    });

    const alreadyFine: Array<[string, string]> = [
      ['a comment inside the braces', `import { durability /* c */ } from '${CORE}';\n${USE}`],
      ['a comment between specifiers', `import { other /* c */, durability } from '${CORE}';\n${USE}`],
      ['an aliased specifier', `import { durability as d } /* c */ from '${CORE}';\nconsole.log(d, durability);\n`],
    ];

    it.each(alreadyFine)('CONTROL: %s was never broken, and still is not', (_name, src) => {
      const out = runDurability(src).files[0]?.contents ?? '';
      expect(halfEdited(out)).toBe(false);
      expect(out).toContain('durable');
    });
  });
});

describe('overlay rules', () => {
  it('rewrites a field inside every operation patch', () => {
    const overlay: Migration = {
      from: '1.0',
      to: '2.0',
      status: 'published',
      summary: 'test',
      reference: 'test',
      rules: [
        {
          kind: 'overlay',
          id: 'moved',
          from: 'effects.readOnly',
          to: 'effects.safe',
          reason: 'Renamed.',
        },
      ],
    };
    const result = run(
      [
        {
          path: 'askturret.mcp.json',
          contents: JSON.stringify({
            version: 1,
            operations: {
              listPets: { effects: { readOnly: true } },
              getPet: { effects: { readOnly: true } },
            },
          }),
        },
      ],
      [overlay],
    );

    const after = JSON.parse(result.files[0]?.contents ?? '{}') as any;
    expect(after.operations.listPets.effects.safe).toBe(true);
    expect(after.operations.getPet.effects.safe).toBe(true);
    expect(after.operations.listPets.effects.readOnly).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #192: an overlay must not be rewritten by a config rule, whatever it is named
// ---------------------------------------------------------------------------

describe('overlay/config classification (#192)', () => {
  /**
   * Carries the config rule's field at the root, so a file that reaches the
   * config branch WILL be rewritten. That is what makes these assertions
   * meaningful rather than vacuous: `toBe(contents)` only proves protection if
   * the unprotected path would have changed the bytes.
   */
  const REWRITABLE = JSON.stringify({ audit: { durability: 'required' } }, null, 2);

  /** The same, plus the `operations` key that makes it an overlay by shape. */
  const REWRITABLE_OVERLAY = JSON.stringify(
    { version: 1, operations: { listPets: {} }, audit: { durability: 'required' } },
    null,
    2,
  );

  it('CONTROL: the config rule really does rewrite a plain config', () => {
    // Without this the whole describe block could pass by rewriting nothing.
    const result = run([{ path: 'askturret.config.json', contents: REWRITABLE }]);

    expect(result.changed).toEqual(['askturret.config.json']);
    expect(result.files[0]?.contents).toContain('"durable"');
  });

  describe('by filename — shape cannot help, the name is the only signal', () => {
    // Deliberately WITHOUT an `operations` key: if these pass, the filename
    // patterns are doing the work on their own.
    for (const path of [
      'askturret.MCP.json', // the A/B case: same file as askturret.mcp.json on macOS
      'askturret-mcp.json', // hyphen for dot — an ordinary naming choice
      'askturret.mcp2.json', // a trailing ordinal
      'AskTurret.mcp.json', // previously ignored; now recognised as an overlay
      'overlays/askturret.MCP.json', // and in a subdirectory
    ]) {
      it(`does not rewrite '${path}' as a config`, () => {
        const result = run([{ path, contents: REWRITABLE }]);

        expect(result.files[0]?.contents).toBe(REWRITABLE);
        expect(result.changed).toEqual([]);
      });
    }

    it('still classifies a genuine config as a config', () => {
      // The widened overlay alternation must not swallow `askturret.config.json`
      // — over-refusing would break every real migration silently.
      const result = run([{ path: 'askturret.config.json', contents: REWRITABLE }]);

      expect(result.changed).toEqual(['askturret.config.json']);
    });

    it('protects a YAML overlay, where the shape check structurally cannot', () => {
      // The case that justifies keeping BOTH layers. `parseJson` returns null
      // for YAML, so there is no document to inspect and the name is the only
      // signal there is. Before #192 this was classified as a config, and the
      // engine told the adopter to hand-apply a config rule to an overlay.
      const yaml = 'version: 1\noperations:\n  listPets: {}\naudit:\n  durability: required\n';
      const result = run([{ path: 'askturret.MCP.yaml', contents: yaml }]);

      expect(result.files[0]?.contents).toBe(yaml);
      expect(result.findings.filter((f) => f.file === 'askturret.MCP.yaml')).toEqual([]);
    });

    it('reproduces the issue A/B: both spellings now agree', () => {
      // The exact demonstration in #192 — identical content, two spellings that
      // are the same file on a case-insensitive filesystem, diverging results.
      const upper = run([{ path: 'askturret.MCP.json', contents: REWRITABLE }]);
      const lower = run([{ path: 'askturret.mcp.json', contents: REWRITABLE }]);

      expect(upper.files[0]?.contents).toBe(lower.files[0]?.contents);
      expect(upper.changed).toEqual(lower.changed);
    });
  });

  describe('by shape — the filename says config, the document says overlay', () => {
    const PATH = 'askturret.config.json';

    it('refuses to rewrite a document carrying an `operations` key', () => {
      // Named unambiguously as a config, so ONLY the shape check can save it.
      const result = run([{ path: PATH, contents: REWRITABLE_OVERLAY }]);

      expect(result.files[0]?.contents).toBe(REWRITABLE_OVERLAY);
      expect(result.changed).toEqual([]);
    });

    it('says why, rather than skipping silently', () => {
      const result = run([{ path: PATH, contents: REWRITABLE_OVERLAY }]);
      const finding = result.findings.find((f) => f.file === PATH);

      expect(finding?.action).toBe('manual');
      expect(finding?.detail).toContain('operations');
    });

    it('stays quiet when the rule had nothing to say about the file', () => {
      // An overlay-shaped document without the rule's field must not produce a
      // "apply this by hand" finding for a field it does not contain.
      const unrelated = JSON.stringify({ version: 1, operations: { listPets: {} } });
      const result = run([{ path: PATH, contents: unrelated }]);

      expect(result.findings.filter((f) => f.file === PATH)).toEqual([]);
    });

    it('does not treat an `operations` ARRAY as an overlay', () => {
      // `OverlayDocument.operations` is a keyed record. An array is a different
      // shape, and guessing it is an overlay would refuse a legitimate config.
      const arrayShaped = JSON.stringify({ operations: ['a'], audit: { durability: 'required' } });
      const result = run([{ path: PATH, contents: arrayShaped }]);

      expect(result.changed).toEqual([PATH]);
    });
  });
});

describe('registry', () => {
  it('hides prospective migrations by default', () => {
    // The whole point of the status field: an unreleased migration must not be
    // applied to a project whose target version does not exist.
    expect(selectMigrations()).toEqual([]);
  });

  it('includes them when asked', () => {
    expect(selectMigrations({ includeProspective: true }).length).toBeGreaterThan(0);
  });

  it('has NO published migration, which is the honest state', () => {
    // Asserted deliberately. This project has never broken an adopter-facing
    // surface, so a published migration would be an invention — and #59 exists
    // to keep compatibility claims checkable against real cases.
    expect(MIGRATIONS.filter((m) => m.status === 'published')).toEqual([]);
  });

  it('ships the reference pair §62 asks for', () => {
    const reference = MIGRATIONS.find((m) => m.from === '0.x' && m.to === '1.0');

    expect(reference).toBeDefined();
    expect(reference?.status).toBe('prospective');
    expect(reference?.rules.length).toBeGreaterThan(0);
  });

  it('exposes its pairs for --help and the docs index', () => {
    expect(knownPairs()).toContainEqual({ from: '0.x', to: '1.0', status: 'prospective' });
  });
});

describe('guide generation', () => {
  it('marks a prospective migration in the first thing a reader sees', () => {
    const snippet = renderSnippet(MIGRATIONS[0] as Migration);

    expect(snippet).toContain('Prospective');
    expect(snippet).toContain('does not exist yet');
  });

  it('describes every rule the engine would execute', () => {
    // The property worth protecting: a hand-written guide and a codemod drift,
    // and nothing compares them. Generating from the same data makes it
    // impossible to document a rename the engine does not perform.
    const migration = MIGRATIONS[0] as Migration;
    const snippet = renderSnippet(migration);

    for (const rule of migration.rules) {
      expect(snippet).toContain(rule.id === '' ? '' : rule.reason.slice(0, 30));
    }
  });

  it('says plainly that no migration is published yet', () => {
    expect(renderIndex()).toContain('**None yet.**');
  });

  it('matches the committed docs/migrations/README.md', () => {
    // Generated, so a migration added without regenerating the doc fails here
    // rather than shipping an index that silently omits it.
    const committed = readFileSync(join(__dirname, '../../../../../../docs/migrations/README.md'), 'utf8');

    expect(renderIndex()).toBe(committed);
  });
});

describe('argument parsing', () => {
  it('parses the documented invocations from §62', () => {
    expect(parseMigrateArgs(['--from', '0.9', '--to', '1.0'])).toMatchObject({
      from: '0.9',
      to: '1.0',
      check: false,
    });
    expect(parseMigrateArgs(['--check'])).toMatchObject({ check: true });
    expect(parseMigrateArgs(['--config', './askturret.config.ts'])).toMatchObject({
      config: './askturret.config.ts',
    });
  });

  it('refuses an unknown option rather than ignoring it', () => {
    expect(() => parseMigrateArgs(['--nope'])).toThrow(/Unknown option/);
  });

  it('refuses a flag with no value', () => {
    expect(() => parseMigrateArgs(['--from'])).toThrow(/requires a value/);
    expect(() => parseMigrateArgs(['--from', '--check'])).toThrow(/requires a value/);
  });
});

// ---------------------------------------------------------------------------
// The REPORT half of #284, which shipped with no coverage at all (#284 QA).
//
// The scan half was tested from the start. The report half — the sentence the
// PR argues hardest about — was reachable only through `migrateCommand`, and
// nothing in this suite referenced it: the sole import from `../index.js` was
// `parseMigrateArgs`. QA reverted the message to the original wording VERBATIM
// and the suite stayed 418/418.
//
// So the defect #284 was filed against could be reintroduced, exactly, and CI
// would stay green. That is the same "unwitnessed assertion" shape as the rest
// of this session, one level out: not an assertion about the wrong thing, but
// no assertion at all behind an argued-for change.
//
// No infrastructure was needed. `migrateCommand` is exported and this file
// already imports from that module; capturing console.log is the whole harness.
// ---------------------------------------------------------------------------
describe('the no-changes report (#284)', () => {
  const spies: { mockRestore: () => void }[] = [];

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  /**
   * Run `migrateCommand` over a throwaway project and return everything it
   * printed.
   *
   * `process.exit` is stubbed to throw, because `migrateCommand` ends by
   * calling it and an unstubbed exit would take the test runner with it. The
   * throw is caught and discarded — the exit code is not what these cases are
   * about, the printed text is.
   */
  async function reportFor(files: Record<string, string>, extraArgs: string[] = []): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-report-'));
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents);
    }

    const lines: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    spies.push(log, exit);

    try {
      // THE REAL REGISTRY, with no injection (#432).
      //
      // This used to pass a hand-built migration through a `migrations` seam,
      // because the branch under test was unreachable through the shipped
      // registry: `output` rules pushed findings unconditionally and the only
      // registry migration carries one. Separating advisories from findings
      // made the branch reachable for real, so the seam was deleted and this
      // exercises what an adopter actually runs.
      //
      // `--include-prospective` IS LOAD-BEARING: the sole registry migration is
      // prospective, so without it `selectMigrations` returns `[]` and the
      // command takes the "No migrations apply" path above — a different branch
      // that would pass a `not.toContain` assertion for the wrong reason.
      //
      // `--check` is kept because these cases are about printed text, and a
      // real run would write to the fixture. It is no longer load-bearing for
      // containment — there is no injected migration left to contain.
      await migrateCommand(['--dir', dir, '--check', '--include-prospective', ...extraArgs]);
    } catch (e) {
      if (!(e instanceof Error) || e.message !== '__exit__') throw e;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    return lines.join('\n');
  }

  it('states that nothing MATCHED, not that the project is migrated', async () => {
    // A project with no affected code at all — the case that used to be told
    // it was "already on the target version".
    const out = await reportFor({ 'app.ts': `export const x = 1;\n` });

    expect(out).toContain('No changes needed: nothing matched these rules.');

    // THE EXACT WORDING #284 WAS FILED AGAINST. Asserted negatively as well as
    // positively: the positive assertion alone would still pass if the old
    // sentence were printed alongside the new one.
    expect(out).not.toContain('already on the target version');
  });

  it('...and states its SCOPE, which is what makes the claim honest', async () => {
    // The scope clause carries the argument. Without it the message is just a
    // shorter version of the same overclaim — "nothing matched" still invites
    // "so there is nothing", and the PR's case rests on the reader being told
    // what was and was not examined. It therefore needs its own witness rather
    // than riding on the first line's.
    const out = await reportFor({ 'app.ts': `export const x = 1;\n` });

    expect(out).toContain('not a certificate that the project is migrated');
    expect(out).toMatch(/imports and re-exports naming a renamed symbol/);
    expect(out).toMatch(/Code reaching the same API another way is not examined/);
  });

  it('does NOT print the no-changes message when there is something to report', async () => {
    // The paired positive. Without it every assertion above is satisfied by a
    // command that prints the scope disclaimer unconditionally, including on
    // runs that did find work — which would be its own kind of false report.
    //
    // The fixture is a config carrying `audit.durability`, which is what the
    // registry's config rule actually matches. This is the Architect's shape
    // (b) to the no-changes case's shape (c): same command, same registry, one
    // differing file.
    const out = await reportFor({
      'askturret.json': `${JSON.stringify({ audit: { durability: 'required' } }, null, 2)}\n`,
    });

    expect(out).not.toContain('No changes needed: nothing matched these rules.');
    // Positively anchored too, so the assertion cannot pass because the run
    // failed to produce any report at all.
    expect(out).toContain('WOULD REWRITE');
  });

  // -------------------------------------------------------------------------
  // The separation itself (#432)
  //
  // The three cases above are about the no-changes SENTENCE. These are about
  // the thing that makes it true: an `output` rule is no longer counted as
  // something found in the adopter's project.
  //
  // RED ON REVERT: put `advise(rule)` back into `findings` and the first two
  // fail — `findings` becomes non-empty, so the no-changes branch stops firing
  // and the `NEEDS YOU` line returns.
  // -------------------------------------------------------------------------
  it('reaches the no-changes branch through the REAL registry, with an advisory present', async () => {
    // Shape (c): `--include-prospective` on a project without `audit.durability`.
    // Nothing in the project matches, but the migration still has something to
    // say — which is precisely the state that was unrepresentable before.
    const out = await reportFor({ 'app.ts': `export const x = 1;\n` });

    expect(out).toContain('No changes needed: nothing matched these rules.');

    // The advisory is still reported — separating it must not lose it.
    expect(out).toContain('Advisories');
    expect(out).toContain('describePreset()');

    // ...and it is NOT dressed as work located in the project. This is the
    // assertion that goes red if advisories are folded back into findings,
    // because the manual-findings loop prefixes exactly this string.
    expect(out).not.toContain('NEEDS YOU');
  });

  it('keeps advisories out of --json findings[], where a surface name is not a path', async () => {
    const out = await reportFor({ 'app.ts': `export const x = 1;\n` }, ['--json']);
    const report = JSON.parse(out) as {
      findings: { file: string }[];
      advisories: { surface: string; kind: string }[];
    };

    // Nothing matched in the project, so `findings` is empty — the machine
    // -readable half of the sentence the human report prints.
    expect(report.findings).toHaveLength(0);

    // The advisory is present, keyed by `surface` rather than `file`.
    expect(report.advisories.length).toBeGreaterThan(0);
    expect(report.advisories.map((a) => a.surface)).toContain('describePreset()');
    expect(report.advisories.every((a) => a.kind === 'output')).toBe(true);

    // The defect stated as an assertion: no `findings[].file` may carry a
    // surface name, because that field is documented as a repo-relative path.
    expect(report.findings.map((f) => f.file)).not.toContain('describePreset()');
  });
});

// ---------------------------------------------------------------------------
// The registry docstring's premise is RE-DERIVED, not restated (#433)
//
// It used to assert "every workspace is still `private: true`, so no adopter
// has ever installed a version to migrate from". The conclusion was true; the
// PREMISE was false and had decayed silently — most workspaces are publishable
// today.
//
// That sentence was not a note about packaging. It was the standing
// justification for treating compatibility breaks as free, and it nearly
// settled #432's adopter-visible `--json` question that way. A false premise
// that makes work look CHEAPER fails silently, in the direction of doing more.
//
// It decayed because it was PROSE stating a fact about the tree, with nothing
// comparing the two. So this reads the tree.
//
// WHAT THIS DELIBERATELY DOES NOT ASSERT: a count. A hardcoded number is the
// exact thing that drifted, and pinning "9 of 16" here would re-create the
// defect one file over — failing the day someone adds a package, for no reason
// anyone could act on. It pins the SHAPE the docstring depends on.
// ---------------------------------------------------------------------------
describe('the registry docstring rests on a checkable premise (#433)', () => {
  const repoRoot = join(__dirname, '..', '..', '..', '..', '..', '..');

  /** Every workspace package.json, read from disk rather than described. */
  function workspacePackages(): { name: string; isPrivate: boolean }[] {
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      workspaces?: string[];
    };
    const out: { name: string; isPrivate: boolean }[] = [];
    for (const pattern of root.workspaces ?? []) {
      if (!pattern.endsWith('/*')) continue;
      const dir = join(repoRoot, pattern.slice(0, -2));
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgPath = join(dir, entry.name, 'package.json');
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; private?: boolean };
        out.push({ name: pkg.name ?? entry.name, isPrivate: pkg.private === true });
      }
    }
    return out;
  }

  const registrySource = readFileSync(join(__dirname, '..', 'registry.ts'), 'utf8');

  it('finds workspace packages at all, so the cases below are not vacuous', () => {
    // Without this a broken path makes every assertion here pass by examining
    // nothing — which is the shape #433 is about, one level up.
    expect(workspacePackages().length).toBeGreaterThan(0);
  });

  it('does NOT claim every workspace is private, because that is false', () => {
    const publishable = workspacePackages().filter((p) => !p.isPrivate);

    // The premise, re-derived from disk on every run.
    expect(publishable.length).toBeGreaterThan(0);

    expect(normalise(registrySource)).not.toMatch(/every workspace is still `private: true`/i);
    expect(normalise(registrySource)).not.toMatch(/no adopter has ever installed a version to migrate from/i);
  });

  // -------------------------------------------------------------------------
  // THE CLAIM LIVED IN THREE PLACES AND THIS CHECKED ONE (#433 QA)
  //
  // The first version searched for the SENTENCE and corrected the one file that
  // carried it. The CLAIM was also in `README.md` — the first thing an adopter
  // reads — and twice in `packages/gateway/README.md`, whose own package is
  // publishable, so it asserted its own privacy while being public-listed.
  //
  // Confidence proportional to one file, for something living in three.
  //
  // So this scans for the universal-quantifier CLAIM rather than any particular
  // wording, across every place documentation lives. A fourth instance in a new
  // README is caught by the same assertion, which the sentence-shaped check
  // could never do.
  //
  // It must NOT flag `docs/releasing.md`, which correctly lists WHICH packages
  // are private. A scoped enumeration is true; a universal quantifier is the
  // false thing. The pattern targets the quantifier, and that file is in the
  // scanned set precisely so the distinction is exercised rather than assumed.
  // -------------------------------------------------------------------------
  /**
   * Strip comment/blockquote leaders and join wrapped lines.
   *
   * Both the claim scan and the phrase assertions run on this rather than raw
   * text, because a claim does not stop being a claim when it wraps. The first
   * version matched raw source and failed on this file's own docstring, where
   * "never cut / a release" is split by a JSDoc continuation — an assertion
   * hostage to where a line happens to break, which is a defect in the
   * assertion rather than in the prose.
   *
   * Sentence boundaries survive: `.` is preserved, and every pattern here is
   * bounded by `[^.]`, so joining lines cannot run a match across two
   * sentences.
   */
  function normalise(text: string): string {
    return text
      .split('\n')
      // `\*(?!\*)` — a JSDoc continuation is ONE asterisk. Markdown bold at the
      // start of a line (`**Private:**`) is two, and stripping the first turned
      // it into `*Private:**`, breaking the scoped-list case below. Caught by
      // that case, which is what it is there for.
      .map((line) => line.replace(/^\s*(?:\*(?!\*)|>|\/\/)\s?/, '').trim())
      .join(' ')
      .replace(/\s+/g, ' ');
  }

  /** Every markdown file that could carry the claim, plus the registry. */
  function claimSites(): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    const add = (p: string) => {
      if (existsSync(p)) out.push({ path: p, text: normalise(readFileSync(p, 'utf8')) });
    };
    add(join(repoRoot, 'README.md'));
    // AT THE ROOT, not under `.github/` (#433 QA). The first version added
    // `.github/CONTRIBUTING.md`, which does not exist — and because `add` is
    // `existsSync`-guarded, that line contributed NOTHING, silently, while
    // reading as though CONTRIBUTING were covered. The real file is 14.5 KB at
    // the root and was never scanned. `claimSites().length > 3` could not catch
    // it: plenty of other files are found.
    add(join(repoRoot, 'CONTRIBUTING.md'));
    for (const dir of ['packages', 'examples']) {
      const base = join(repoRoot, dir);
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) add(join(base, entry.name, 'README.md'));
      }
    }
    // RECURSIVELY (#433 QA). Top-level-only reached 21 of 39 markdown files
    // under `docs/`, leaving the 17 ADRs and `docs/migrations/` unscanned — and
    // an ADR is exactly where a publishing-or-privacy claim gets argued at
    // length.
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) add(full);
      }
    };
    walk(join(repoRoot, 'docs'));
    out.push({ path: 'registry.ts', text: normalise(registrySource) });
    return out;
  }

  /**
   * "every/all workspace(s) IS/ARE private" — the universal claim, any wording.
   *
   * PRESENT TENSE IS REQUIRED, and that is not incidental. `docs/releasing.md`
   * records "Every workspace package WAS `private: true`" as a historical
   * defect it fixed — true, useful, and the first version of this pattern
   * flagged it. Rewriting a correct historical record to satisfy a guard would
   * be a worse outcome than the defect the guard exists for.
   *
   * So the copula is matched explicitly rather than the words merely
   * co-occurring. A claim about what IS the case is the thing that can rot; a
   * record of what WAS is not.
   *
   * ## WHAT THIS DOES AND DOES NOT CATCH — stated narrowly on purpose
   *
   * It catches a recurrence of the CLAIM in this shape — quantifier, the noun
   * `workspace`, a present-tense copula, `private` — in any file scanned above,
   * including a new one. That is the property worth having, and it is real: a
   * fourth instance in a new README is caught where a sentence-shaped check
   * could never manage it.
   *
   * IT IS NOT A SEMANTIC CHECK, and it does not scan for every way the thought
   * could be phrased. QA stress-tested 21 phrasings and 9 slip through by
   * changing the NOUN, the QUANTIFIER or the word order rather than the copula:
   * "All packages in this repository are private" (and the directories really
   * are called `packages/`), "Each workspace is private", "None of the
   * workspaces are public".
   *
   * CHASING THAT IS DELIBERATELY NOT DONE. Completeness over prose is
   * unattainable, and precision matters more for a guard reading every document
   * in the tree: a noisy guard gets deleted, and this one currently
   * over-flags NOTHING — zero false positives across both past-tense records,
   * both scoped lists, the partial claim and the TypeScript-private field.
   *
   * An earlier version of this comment said it scanned "across every place
   * documentation lives", which overstated its reach. A guard whose comment
   * claims more coverage than it has is this PR's own subject, one level down.
   */
  const UNIVERSAL_PRIVACY_CLAIM =
    /\b(?:every|all)\b[^.\n]{0,60}\bworkspaces?\b[^.\n]{0,30}\b(?:is|are|remains?|stays?|continues?)\b[^.\n]{0,30}`?private/i;

  it('scans more than one file, so the claim-wide check is not vacuous', () => {
    // The #433 defect in miniature: a scan that examines nothing reports clean.
    expect(claimSites().length).toBeGreaterThan(3);
  });

  // THE ASSERTION THAT WOULD HAVE CAUGHT THE DEAD PATH (#433 QA).
  //
  // The scan added `.github/CONTRIBUTING.md`, which does not exist. `add()` is
  // `existsSync`-guarded, so the line contributed nothing — SILENTLY — while
  // reading as though CONTRIBUTING were covered. The count-based non-vacuity
  // check above could not see it, because plenty of other files were found.
  //
  // A count proves the scan found SOMETHING. It cannot prove it found the
  // things it was aimed at. So the set is pinned by NAME: pin it, do not assume
  // it — the same lesson this PR applies to the claim it is fixing.
  //
  // Named individually rather than as a total, because a total is the thing
  // that just failed to notice. `docs/adr/` is listed to pin RECURSION
  // specifically: a top-level-only walk reached 21 of 39 markdown files, and an
  // ADR is exactly where a publishing claim gets argued at length.
  it('...and it scans the files it is AIMED at, by name (#433)', () => {
    const scanned = claimSites().map((s) => s.path);
    const hasSuffix = (suffix: string) => scanned.some((p) => p.endsWith(suffix));

    expect(hasSuffix('/README.md')).toBe(true);
    expect(hasSuffix('/CONTRIBUTING.md')).toBe(true);
    expect(hasSuffix('/packages/gateway/README.md')).toBe(true);
    expect(hasSuffix('/docs/releasing.md')).toBe(true);
    // Recursion, pinned: these are two directory levels down.
    expect(scanned.some((p) => p.includes('/docs/adr/'))).toBe(true);
    expect(scanned.some((p) => p.includes('/docs/migrations/'))).toBe(true);
    expect(scanned).toContain('registry.ts');
  });

  it('NO documentation claims every workspace is private (#433)', () => {
    const offenders = claimSites()
      .filter((s) => UNIVERSAL_PRIVACY_CLAIM.exec(s.text) !== null)
      .map((s) => s.path);

    expect(offenders).toEqual([]);
  });

  it('...while a SCOPED list of which packages are private is fine', () => {
    // The paired negative. Without it the assertion above is satisfied by a
    // pattern so broad it would force `docs/releasing.md` to stop saying the
    // true thing — which would be a worse outcome than the defect.
    const releasing = claimSites().find((s) => s.path.endsWith('releasing.md'));
    expect(releasing).toBeDefined();
    expect(releasing?.text).toMatch(/\*\*Private:\*\*/);
    expect(UNIVERSAL_PRIVACY_CLAIM.exec(releasing?.text ?? '')).toBeNull();
  });

  it('...and says what IS true, rather than going quiet about it', () => {
    // Deleting the false sentence without replacing it would leave the next
    // reader to re-derive the whole question from nothing. The docstring has to
    // carry the corrected fact, not merely stop carrying the wrong one.
    //
    // THIS ASSERTION USED TO PIN `/never cut a release/i` (#633). That phrase
    // was the corrected fact when it was written and became false when the
    // first release shipped — at which point this test was ENFORCING the
    // falsehood, holding it in the docstring under a name claiming the
    // opposite. A test that pins a STATE inherits that state's expiry.
    //
    // So it now pins the RE-DERIVATION instead. "Go and run this" cannot go
    // stale the way "this is the situation" can, and it is the property the
    // docstring is actually for.
    expect(normalise(registrySource)).toMatch(/npm view @askturret/i);
    expect(normalise(registrySource)).toMatch(/gh release list/i);
    expect(normalise(registrySource)).toMatch(/licenses nothing/i);
  });
});

// ---------------------------------------------------------------------------
// A template interpolation is CODE, and the two views agree on length (#530)
//
// OBSERVED FAILING FIRST, on the tree as it stood. `` `x${durability}y` ``
// masked to `const t =                  ;` — the interpolation blanked with the
// text, so an occurrence inside it produced no rewrite AND no finding. That is
// the `findings: []`-over-unhandled-work signature, not a near miss.
//
// The nested case failed in the OPPOSITE direction, which is why it is pinned
// separately rather than assumed to follow: `` `a${`b${x}d`}e` `` masked to
// `const t =      b${durability}d    ;` — the outer scan took the INNER
// backtick as its terminator, so the mask stopped early and template TEXT
// leaked into the code view. A fix that only exposed interpolations would have
// left that boundary wrong.
// ---------------------------------------------------------------------------
describe('maskSource: template interpolations (#530)', () => {
  it('exposes interpolated code while keeping the surrounding text masked', () => {
    const { masked } = maskSource('const t = `HEADTEXT${durability}TAILTEXT`;\n');

    // The CODE is visible...
    expect(masked).toContain('durability');
    // ...and the TEXT either side of it is not. Both halves are asserted,
    // because a fix that unmasked the whole template would satisfy the first
    // one alone and would be wrong in the other direction.
    expect(masked).not.toContain('HEADTEXT');
    expect(masked).not.toContain('TAILTEXT');
  });

  it('handles a template nested inside an interpolation, at both levels', () => {
    const { masked } = maskSource('const t = `OUTA${`INNB${durability}INND`}OUTE`;\n');

    expect(masked).toContain('durability');
    for (const text of ['OUTA', 'INNB', 'INND', 'OUTE']) expect(masked).not.toContain(text);
  });

  it('does not let a backtick inside a plain string open a template', () => {
    const { masked } = maskSource('const s = "QUOTED `BACKTICKTEXT" + durability;\n');
    expect(masked).toContain('durability');
    expect(masked).not.toContain('BACKTICKTEXT');
  });

  it('does not end a template at an ESCAPED backtick', () => {
    const { masked } = maskSource('const t = `ESCAPED\\`BACKTICKTEXT${durability}TAILTEXT`;\n');
    expect(masked).toContain('durability');
    expect(masked).not.toContain('BACKTICKTEXT');
  });

  it('treats a comment inside an interpolation as a comment', () => {
    const { commentless, masked } = maskSource('const t = `HEADTEXT${/* durability */ x}TAILTEXT`;\n');
    // Blanked in BOTH views — that is what makes it a comment rather than text.
    expect(commentless).not.toContain('durability');
    expect(masked).not.toContain('durability');
    expect(masked).toContain('x');
  });

  it('counts braces, so an object inside an interpolation does not end it early', () => {
    const { masked } = maskSource('const t = `HEADTEXT${ {k: durability} }TAILTEXT`;\n');
    expect(masked).toContain('durability');
    expect(masked).not.toContain('BACKTICKTEXT');
  });

  it('REPORTS an unterminated template rather than omitting it', () => {
    const { unterminated } = maskSource('const t = `HEADTEXT${x}TAILTEXT\n');
    // The durable half of #530: what cannot be analysed is reported, never
    // silently skipped.
    expect(unterminated).not.toBeNull();
    expect(unterminated?.index).toBe(10);
  });

  it('returns views the SAME LENGTH as the input, even on a trailing escape (#534)', () => {
    // A backslash as the final character sent the cursor past the end, and
    // writing there EXTENDED the buffer — `masked` came back one character
    // longer, so every offset past the end disagreed between the two views.
    const src = "const s = 'a\\";
    const { masked, commentless } = maskSource(src);
    expect(masked).toHaveLength(src.length);
    expect(commentless).toHaveLength(src.length);
  });
});

// ---------------------------------------------------------------------------
// The masked-keyword guard is REACHABLE, contrary to the filing (#543)
//
// #543 held that the guard is unreachable because two neighbouring mechanisms
// subsume it. Checked rather than inherited, and the claim does not hold: those
// mechanisms govern the OCCURRENCE scan, while this guard sits in the import
// and export RANGE scans, which match over `commentless` — the view that keeps
// string text ON PURPOSE, because the module specifier lives there (#454).
//
// So a string whose CONTENT looks like a re-export reaches the regex, and this
// guard is the only thing that stops it being treated as one. Measured: with
// the guard removed, `reExportRanges` returns [[11, 32]] for the fixture below
// and the string is rewritten as if it were code.
//
// The guard therefore stays. This test is what makes that decision reviewable —
// remove the guard and it reddens.
// ---------------------------------------------------------------------------
describe('reExportRanges: a string that looks like a re-export (#543)', () => {
  it('is not treated as a re-export', () => {
    const src = 'const s = "export { a } from \'m\'";\n';
    const { commentless, masked } = maskSource(src);

    // The regex CAN see it — `commentless` keeps string text — so the guard is
    // doing real work rather than sitting behind an impossible input.
    expect(commentless).toContain('export { a } from');
    expect(reExportRanges(commentless, masked)).toHaveLength(0);
  });

  it('still finds a REAL re-export beside it, so the guard is not just refusing everything', () => {
    const src = 'export { a } from \'m\';\n';
    const { commentless, masked } = maskSource(src);
    expect(reExportRanges(commentless, masked)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The length equality is a PROPERTY, not a consequence of the fixtures (534)
//
// `masked.length === contents.length` is what makes the mask a VIEW: indices
// into one are indices into the other, which is the whole reason an edit
// computed over `masked` can be applied to `contents`. The trailing-backslash
// case above is today's instance; this table is the class, and it is
// deliberately weighted towards UNTERMINATED shapes because that is the only
// state in which the drift could occur.
// ---------------------------------------------------------------------------
describe('maskSource: the two views are always the length of the input (534)', () => {
  const SHAPES: ReadonlyArray<readonly [string, string]> = [
    ['empty', ''],
    ['a lone backslash', '\\'],
    ['trailing escape in a string', "const s = 'a\\"],
    ['trailing escape in a double-quoted string', 'const s = "a\\'],
    ['trailing escape in a template', 'const t = `a\\'],
    ['unterminated string', "const s = 'abc"],
    ['unterminated template', 'const t = `abc'],
    ['unterminated template mid-interpolation', 'const t = `a${x'],
    ['unterminated block comment', 'const x = 1; /* abc'],
    ['unterminated block comment ending in a backslash', 'const x = 1; /* abc\\'],
    ['a template that never closes after an interpolation', 'const t = `a${x}b'],
    ['nested unterminated templates', 'const t = `a${`b${x'],
    ['file ending exactly at a backtick', 'const t = `'],
    ['ordinary code', 'const t = `a${x}b`;\nimport { y } from "m";\n'],
  ];

  for (const [name, src] of SHAPES) {
    it(`holds for: ${name}`, () => {
      const { masked, commentless } = maskSource(src);
      expect(masked).toHaveLength(src.length);
      expect(commentless).toHaveLength(src.length);
    });
  }

  it('leaves newlines in place, so line numbers survive every blanking', () => {
    const src = 'const t = `a\nb${x}\nc`;\n';
    const { masked, commentless } = maskSource(src);
    // Same count in every view — `lineOf` reads these, so a lost newline moves
    // every reported line below the blanked region.
    const lines = (s: string): number => s.split('\n').length;
    expect(lines(masked)).toBe(lines(src));
    expect(lines(commentless)).toBe(lines(src));
  });

  it('still reports an unterminated STRING at its opening index, unchanged', () => {
    // 534 asks that the existing reporting behaviour is asserted as unchanged,
    // not merely left alone.
    const { unterminated } = maskSource("const s = 'abc");
    expect(unterminated).toEqual({ kind: 'string literal', index: 10 });
  });

  it('still reports an unterminated BLOCK COMMENT at its opening index, unchanged', () => {
    const { unterminated } = maskSource('const x = 1; /* abc');
    expect(unterminated).toEqual({ kind: 'block comment', index: 13 });
  });
});

// ---------------------------------------------------------------------------
// A comment must not make the entry gate skip the whole file (closes #538)
//
// MEASURED FIRST, and the population is FIVE shapes rather than the one filed.
// On the tree as it stood, each of these was silently skipped — no rewrite and
// NO FINDING, which is the findings-empty-over-unhandled-work signature at FILE
// granularity. A green run and an unprocessed file were indistinguishable.
//
//   block comment between `from` and the module
//   a comment containing a SEMICOLON        (the `[^;]*` class ended early)
//   `import type` with a comment
//   a default binding with a comment
//   a re-export with a comment              (without one it REPORTS; with one it went silent)
//
// The last is the sharpest: a comment turned a loud, correct refusal into
// nothing at all.
// ---------------------------------------------------------------------------
describe('entry gate: comments (#538)', () => {
  const rename: Migration = {
    from: '1.0',
    to: '2.0',
    status: 'published',
    summary: 'test',
    reference: 'test',
    rules: [
      {
        kind: 'source',
        id: 'renamed',
        from: 'oldName',
        to: 'newName',
        module: '@askturret/mcp-core',
        reason: 'Renamed.',
      },
    ],
  };
  const go = (contents: string) => run([{ path: 'src/a.ts', contents }], [rename]);

  it.each([
    ['a block comment between `from` and the module', `import { oldName } from /* c */ '@askturret/mcp-core';\nconst a = oldName;\n`],
    ['a comment containing a semicolon', `import { oldName } from /* a; b */ '@askturret/mcp-core';\nconst a = oldName;\n`],
    ['`import type` with a comment', `import type { oldName } from /* c */ '@askturret/mcp-core';\nconst a: oldName = 1;\n`],
    ['a default binding with a comment', `import oldName from /* c */ '@askturret/mcp-core';\nconst a = oldName;\n`],
  ])('processes a file with %s', (_name, contents) => {
    const result = go(contents);
    expect(result.files[0]?.contents).toContain('newName');
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('REPORTS a commented re-export, exactly as it reports an uncommented one', () => {
    // Not rewritten either way — the adopter's export surface is not ours to
    // change (#284) — but the comment must not turn the refusal into silence.
    const withComment = go(`export { oldName } from /* c */ '@askturret/mcp-core';\n`);
    const without = go(`export { oldName } from '@askturret/mcp-core';\n`);

    expect(withComment.findings.filter((f) => f.action === 'manual')).toHaveLength(1);
    expect(withComment.findings.length).toBe(without.findings.length);
  });

  // CONTROLS. "Stopped skipping wrongly" and "stopped skipping at all" look
  // identical without them (#538's own acceptance, and #526's standard).
  it.each([
    ['an unrelated module', `import { oldName } from 'other-pkg';\nconst a = oldName;\n`],
    ['the module named only inside a comment', `// import { oldName } from '@askturret/mcp-core'\nconst a = 1;\n`],
    ['a namespace import that never names the symbol', `import * as ns from '@askturret/mcp-core';\nconst a = ns;\n`],
  ])('still skips %s, silently and without editing', (_name, contents) => {
    const result = go(contents);
    expect(result.files[0]?.contents).toBe(contents);
    expect(result.findings).toHaveLength(0);
  });

  // THE COST SIDE, and it is a regression this change introduced and then
  // removed rather than a hypothetical. Gating on `commentless` ALONE let a
  // module named only inside a STRING pass, and an unrelated local of the same
  // name was renamed into non-compiling code:
  //
  //   const b = oldName;   ->   const b = newName;
  //
  // Trading a silent skip for a silent corruption would have been a worse
  // bargain than the defect being repaired, so the gate also requires the
  // keyword to be real code.
  it('does NOT enter a file whose only mention of the module is inside a string', () => {
    const contents =
      `const s = "import { oldName } from '@askturret/mcp-core'";\nlet oldName = 5;\nconst b = oldName;\n`;
    const result = go(contents);
    expect(result.files[0]?.contents).toBe(contents);
    expect(result.findings).toHaveLength(0);
  });

  // ...AND THE GATE MAY REFUSE A FILE IT UNDERSTANDS, NEVER ONE IT COULD NOT
  // READ. Anchoring to code re-introduced the silence one door further out —
  // an import inside an unterminated string is not code in any view, so the
  // gate refused and the unanalysable region went unreported.
  it('REPORTS a file whose import is swallowed by an unterminated string', () => {
    const result = go(`const s = "oops\nimport { oldName } from '@askturret/mcp-core';\nconst a = oldName;\n`);
    const manual = result.findings.filter((f) => f.action === 'manual');
    expect(manual).toHaveLength(1);
    expect(manual[0]?.detail).toContain('could not be analysed');
    // Nothing edited, because nothing could be read.
    expect(result.files[0]?.contents).toContain('const a = oldName;');
  });

  // ...AND THAT DEFERRAL IS BOUNDED BY THE TEXTUAL MATCH, which is the half
  // that was unwitnessed (#569). `undecidable` requires BOTH an unterminated
  // construct AND a loose match; dropping the second conjunct reddened NOTHING,
  // so a reader could take `loose` in `unterminated !== null && loose` for
  // redundancy — it looks like a narrowing of a condition that already narrows.
  //
  // It is not. It is what bounds BLAST RADIUS: without it every file in the
  // repository carrying an unterminated string enters the gate and reports an
  // unanalysable region it has no stake in. Measured, dropping the conjunct:
  // this file goes findings=0 -> findings=1.
  //
  // Deliberately NOT a restatement of the happy path — the three `still skips`
  // cases above all PARSE, so `unterminated === null` makes the conjunct
  // unreachable and they stay green under that mutation. Failing to parse is
  // the whole discriminator, which is why the premise is pinned rather than
  // assumed: were this fixture ever edited into one that parses, the assertion
  // below would still pass and would silently stop witnessing anything.
  it('does NOT enter an unrelated file that merely fails to parse', () => {
    const contents = `const s = "oops\nconst a = 1;\n`;
    expect(maskSource(contents).unterminated).not.toBeNull();

    const result = go(contents);
    expect(result.files[0]?.contents).toBe(contents);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The range boundaries are pinned by WHAT THEY COVER (544)
//
// Measured across all three range producers, not just the one filed — 544 asks
// for the adjacent ones to be checked, and they had the same gap:
//
//                        end short   start late
//   importRanges              0           0
//   reExportRanges            0           1     <- already pinned, via the dedup set
//   localExportRanges         0           0
//
// Pinned by slicing the covered text rather than by asserting offsets: a
// numeric assertion couples the test to the implementation and breaks on any
// legitimate refactor, which 544 rules out explicitly. Slicing reddens in BOTH
// directions — losing the leading `i` of `import` or the last character of the
// module — while staying agnostic about where the statement sits in the file.
// ---------------------------------------------------------------------------
describe('range boundaries cover the whole statement (544)', () => {
  const STATEMENT = `import { oldName } from '@askturret/mcp-core'`;
  const RE_EXPORT = `export { oldName } from '@askturret/mcp-core'`;
  const LOCAL = `export { oldName }`;

  it('importRanges covers the statement exactly', () => {
    const src = `const before = 1;\n${STATEMENT};\nconst after = 2;\n`;
    const { commentless, masked } = maskSource(src);
    const ranges = importRanges(commentless, masked);

    expect(ranges).toHaveLength(1);
    const [start, end] = ranges[0] as readonly [number, number];
    expect(src.slice(start, end)).toBe(STATEMENT);
  });

  it('reExportRanges covers the statement exactly', () => {
    const src = `const before = 1;\n${RE_EXPORT};\n`;
    const { commentless, masked } = maskSource(src);
    const ranges = reExportRanges(commentless, masked);

    expect(ranges).toHaveLength(1);
    const [start, end] = ranges[0] as readonly [number, number];
    expect(src.slice(start, end)).toBe(RE_EXPORT);
  });

  it('localExportRanges covers the statement exactly', () => {
    const src = `const before = 1;\n${LOCAL};\n`;
    const { commentless, masked } = maskSource(src);
    const ranges = localExportRanges(commentless, masked, new Set());

    expect(ranges).toHaveLength(1);
    const [start, end] = ranges[0] as readonly [number, number];
    expect(src.slice(start, end)).toBe(LOCAL);
  });
});
