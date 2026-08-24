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

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { applyMigrations, type ProjectFile } from '../engine.js';
import { MIGRATIONS, selectMigrations, knownPairs } from '../registry.js';
import { renderIndex, renderSnippet } from '../guide.js';
import { parseMigrateArgs } from '../index.js';
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
