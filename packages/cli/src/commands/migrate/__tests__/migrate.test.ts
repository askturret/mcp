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
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { applyMigrations, type ProjectFile } from '../engine.js';
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
    // The distinction that keeps `--check` usable in CI. An `output` rule always
    // reports and never rewrites, so a project that heeded it would otherwise
    // fail its build for ever.
    const result = run([{ path: 'unrelated.ts', contents: 'export const x = 1;\n' }]);

    expect(result.findings.some((f) => f.action === 'manual')).toBe(true);
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
  // Source rules ONLY, deliberately. An `output` rule would push a finding
  // unconditionally and the branch would never be reached — which is exactly
  // why the shipped registry cannot exercise it.
  const sourceOnly: Migration = {
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
  async function reportFor(files: Record<string, string>): Promise<string> {
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
      // The migration is injected rather than selected, because the branch
      // under test is UNREACHABLE through the shipped registry — see the seam's
      // docblock. `sourceOnly` carries a source rule and nothing else, so a
      // project with no matching code produces no findings at all, which is the
      // only state in which this branch runs.
      //
      // `--check` IS LOAD-BEARING. DO NOT REMOVE IT AS TIDYING.
      //
      // It is not here to make the test faster or to express intent — it is the
      // only thing standing between the injected migration and the write loop.
      // An injected migration REPLACES the registry selection and reaches
      // `applyMigrations` -> `result.files` -> `if (!options.check)` in three
      // hops; QA proved it by writing `HIJACKED` into a fixture file through
      // this parameter with `--check` omitted.
      //
      // The seam's docblock previously claimed the parameter could never cause
      // a write, which would have made this flag look redundant to anyone
      // tidying the file. That claim was false and is gone. Removing `--check`
      // here is removing a guard.
      await migrateCommand(['--dir', dir, '--check'], [sourceOnly]);
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
    const out = await reportFor({
      'app.ts': `export { other as oldName } from '@askturret/mcp-core';\n`,
    });

    expect(out).not.toContain('No changes needed: nothing matched these rules.');
  });
});
