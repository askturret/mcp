// SPDX-License-Identifier: Apache-2.0
/**
 * `diff` CLI (§13).
 *
 * §13 Acceptance says "exit codes stable", so the exit code is treated as the
 * contract here, not as an afterthought: it is what a release gate branches on,
 * and changing it silently breaks every pipeline using it.
 *
 * `process.exit` is stubbed to THROW rather than to return, matching
 * `inspect.test.ts`. The real `process.exit` never returns, so a stub that
 * returns normally lets the command keep running past a point it never reaches
 * in production — and the test then asserts against a state that cannot occur.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSnapshot,
  serializeSnapshot,
  type OperationDefinition,
} from '@askturret/mcp-core';

import { diffCommand, EXIT_BREAKING, EXIT_OK, EXIT_USAGE } from '../commands/diff.js';

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

interface Op {
  id: string;
  name?: string;
  description?: string;
  input?: unknown;
  output?: unknown;
  effects?: Record<string, unknown>;
}

/**
 * A snapshot file the CLI will actually accept.
 *
 * The hash used to be the mnemonic `hash-${version}`, which was fine while
 * `deserializeSnapshot` did not check it. Since #347 it does, and the CLI
 * reaches it on a PRODUCTION path (`diff.ts` → `parse` → `deserializeSnapshot`)
 * where `{ verifyHash: false }` is not available and should not be — so these
 * fixtures now carry the real hash, produced by `createSnapshot` rather than
 * transcribed. Nothing here asserts on the hash's value; what matters is that
 * the file is internally consistent, as a real one would be.
 *
 * `createdAt` is pinned back to a fixed instant afterwards. That is safe by the
 * hash contract, not by luck: `createdAt` is excluded from the hash (ADR-004),
 * so overriding it cannot invalidate what `createSnapshot` just computed. The
 * core round-trip suite pins that exclusion.
 */
function snapshot(operations: Op[], version = 1): string {
  const definitions = operations.map((o) => ({
    id: o.id,
    name: o.name ?? o.id,
    description: o.description ?? `Operation ${o.id}`,
    input: o.input ?? { type: 'object', properties: {} },
    output: o.output ?? { type: 'object', properties: {} },
    effects: {
      readOnly: true,
      idempotent: true,
      retryable: true,
      idempotencyKeyRequired: false,
      classifications: [],
      ...(o.effects ?? {}),
    },
    executor: { type: 'http' },
  })) as unknown as OperationDefinition[];

  return JSON.stringify({
    ...serializeSnapshot(createSnapshot(definitions, version)),
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('diff command', () => {
  let dir: string;
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let logSpy: ReturnType<typeof jest.spyOn>;
  let errorSpy: ReturnType<typeof jest.spyOn>;

  const write = (name: string, contents: string): string => {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  };

  const stdout = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const stderr = (): string => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /** Run the command and return the exit code it terminated with. */
  const run = async (args: string[]): Promise<number | undefined> => {
    try {
      await diffCommand(args);
    } catch (error) {
      if (error instanceof ExitError) return error.code;
      throw error;
    }
    throw new Error('diffCommand returned without calling process.exit');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'diff-cli-'));
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code);
    }) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Exit codes: the contract a CI gate depends on ──────────────────────

  it('exits 0 when only non-breaking changes are present', async () => {
    const before = write('before.json', snapshot([{ id: 'a' }]));
    const after = write('after.json', snapshot([{ id: 'a' }, { id: 'b' }], 2));

    expect(await run(['--before', before, '--after', after])).toBe(EXIT_OK);
  });

  it('exits 1 when an operation is removed', async () => {
    const before = write('before.json', snapshot([{ id: 'a' }, { id: 'b' }]));
    const after = write('after.json', snapshot([{ id: 'a' }], 2));

    expect(await run(['--before', before, '--after', after])).toBe(EXIT_BREAKING);
  });

  it('exits 0 for the same breaking change when --allow-breaking is passed', async () => {
    const before = write('before.json', snapshot([{ id: 'a' }, { id: 'b' }]));
    const after = write('after.json', snapshot([{ id: 'a' }], 2));

    expect(await run(['--before', before, '--after', after, '--allow-breaking'])).toBe(EXIT_OK);
  });

  it('exits 2 — NOT 1 — when a snapshot cannot be read', async () => {
    // The distinction is the point. A gate that returns the same code for
    // "the surface broke" and "I could not read the file" teaches operators to
    // treat every red build as a config problem, and the first real breaking
    // change gets waved through. "I could not check" is not "it failed".
    const before = write('before.json', snapshot([{ id: 'a' }]));

    const code = await run(['--before', before, '--after', join(dir, 'missing.json')]);

    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toMatch(/no such file/);
  });

  it('points a content hash at the missing snapshot store, not at a typo', async () => {
    // A hash is an opaque token, so it lands on the same ENOENT path as a
    // mistyped filename and the two are indistinguishable there — any pattern
    // tight enough to recognise a hash would reject legitimate filenames. So
    // the hint names both possibilities rather than guessing (#40 QA).
    const before = write('before.json', snapshot([{ id: 'a' }]));

    const code = await run([
      '--before', before,
      '--after', 'a3f9b2c4d5e6f70819a2b3c4d5e6f7081920a3b4',
    ]);

    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toMatch(/content hash or a version tag/);
    expect(stderr()).toMatch(/snapshot store/);
  });

  it('exits 2 on malformed JSON and on a non-snapshot document', async () => {
    const valid = write('valid.json', snapshot([{ id: 'a' }]));

    const notJson = write('bad.json', '{ not json');
    expect(await run(['--before', valid, '--after', notJson])).toBe(EXIT_USAGE);
    expect(stderr()).toMatch(/not valid JSON/);

    errorSpy.mockClear();

    const notSnapshot = write('other.json', JSON.stringify({ hello: 'world' }));
    expect(await run(['--before', valid, '--after', notSnapshot])).toBe(EXIT_USAGE);
    expect(stderr()).toMatch(/not a valid snapshot/);
  });

  it('exits 2 when --before or --after is missing', async () => {
    const path = write('a.json', snapshot([{ id: 'a' }]));

    expect(await run([])).toBe(EXIT_USAGE);
    expect(await run(['--before', path])).toBe(EXIT_USAGE);
    expect(await run(['--after', path])).toBe(EXIT_USAGE);
  });

  // ── Unsupported input forms fail honestly ──────────────────────────────

  it('explains that a version tag is unsupported instead of reporting "file not found"', async () => {
    // §13's examples show `--before v1.2.3`. Resolving a tag needs a snapshot
    // store that does not exist. Saying "no such file: v1.2.3" would send the
    // operator hunting for a path they never intended to give.
    const after = write('after.json', snapshot([{ id: 'a' }]));

    expect(await run(['--before', 'v1.2.3', '--after', after])).toBe(EXIT_USAGE);
    expect(stderr()).toMatch(/version tag.*not supported/i);
    expect(stderr()).toMatch(/snapshot store/i);
  });

  it('explains that a directory cannot be compiled yet', async () => {
    const before = write('before.json', snapshot([{ id: 'a' }]));

    expect(await run(['--before', before, '--after', dir])).toBe(EXIT_USAGE);
    expect(stderr()).toMatch(/is a directory/);
    expect(stderr()).toMatch(/not supported yet/);
  });

  // ── Output ─────────────────────────────────────────────────────────────

  it('emits a parseable report under --json whose fields match the human run', async () => {
    const before = write('before.json', snapshot([{ id: 'a' }, { id: 'b' }]));
    const after = write('after.json', snapshot([{ id: 'a' }], 2));

    await run(['--before', before, '--after', after, '--json']);

    const report = JSON.parse(stdout());
    expect(report.hasBreaking).toBe(true);
    expect(report.summary.breaking).toBe(1);
    expect(report.changes[0].code).toBe('operation-removed');
    expect(report.before.version).toBe(1);
    expect(report.after.version).toBe(2);
  });

  it('does not print the human-readable trailer in --json mode', async () => {
    // Anything on stderr that is not JSON is a parse hazard for the pipeline
    // consuming it.
    const before = write('before.json', snapshot([{ id: 'a' }, { id: 'b' }]));
    const after = write('after.json', snapshot([{ id: 'a' }], 2));

    await run(['--before', before, '--after', after, '--json']);

    expect(stderr()).toBe('');
    expect(() => JSON.parse(stdout())).not.toThrow();
  });

  it('reports "No changes" when the snapshots are identical', async () => {
    const before = write('before.json', snapshot([{ id: 'a' }]));
    const after = write('after.json', snapshot([{ id: 'a' }]));

    expect(await run(['--before', before, '--after', after])).toBe(EXIT_OK);
    expect(stdout()).toMatch(/No changes/);
  });

  // ── Rename hints ───────────────────────────────────────────────────────

  it('accepts a rename hint file and reports one rename instead of remove + add', async () => {
    const before = write('before.json', snapshot([{ id: 'listPets' }]));
    const after = write('after.json', snapshot([{ id: 'listAllPets' }], 2));
    const hints = write('hints.json', JSON.stringify({ renamed: { listPets: 'listAllPets' } }));

    const code = await run([
      '--before', before, '--after', after,
      '--rename-hints', hints, '--json',
    ]);

    const report = JSON.parse(stdout());
    const codes = report.changes.map((c: { code: string }) => c.code);
    expect(codes).toContain('operation-renamed');
    expect(codes).not.toContain('operation-removed');
    expect(codes).not.toContain('operation-added');
    // A rename is still breaking: agents call operations by id.
    expect(code).toBe(EXIT_BREAKING);
  });

  it('accepts a bare { old: new } hint map as well as the { renamed: ... } wrapper', async () => {
    const before = write('before.json', snapshot([{ id: 'listPets' }]));
    const after = write('after.json', snapshot([{ id: 'listAllPets' }], 2));
    const hints = write('hints.json', JSON.stringify({ listPets: 'listAllPets' }));

    await run(['--before', before, '--after', after, '--rename-hints', hints, '--json']);

    expect(JSON.parse(stdout()).changes.map((c: { code: string }) => c.code)).toContain(
      'operation-renamed',
    );
  });

  it('exits 2 on an unreadable or malformed hint file', async () => {
    const before = write('before.json', snapshot([{ id: 'a' }]));
    const after = write('after.json', snapshot([{ id: 'a' }]));

    expect(
      await run(['--before', before, '--after', after, '--rename-hints', join(dir, 'nope.json')]),
    ).toBe(EXIT_USAGE);

    const bad = write('bad-hints.json', JSON.stringify({ renamed: { a: 42 } }));
    expect(
      await run(['--before', before, '--after', after, '--rename-hints', bad]),
    ).toBe(EXIT_USAGE);
  });

  // ── --confirm-for ──────────────────────────────────────────────────────

  it('honours --confirm-for when deciding whether confirmation became required', async () => {
    // Confirmation is (classifications) ∩ (policy's confirm-for set), and only
    // the first half is in the snapshot. The same pair of snapshots must
    // therefore produce different verdicts under different policies — that is
    // the assumption being made explicit rather than hidden.
    const before = write('before.json', snapshot([{ id: 'a', effects: { classifications: [] } }]));
    const after = write(
      'after.json',
      snapshot([{ id: 'a', effects: { classifications: ['financial'] } }], 2),
    );

    expect(await run(['--before', before, '--after', after])).toBe(EXIT_BREAKING);

    logSpy.mockClear();
    expect(
      await run(['--before', before, '--after', after, '--confirm-for', 'destructive']),
    ).toBe(EXIT_OK);
  });

  // ── --help ─────────────────────────────────────────────────────────────

  it('documents the classification rubric in --help (§13 acceptance)', async () => {
    expect(await run(['--help'])).toBe(EXIT_OK);

    const help = stdout();
    expect(help).toMatch(/CLASSIFICATION RUBRIC/);
    expect(help).toMatch(/BREAKING/);
    expect(help).toMatch(/DOUBLE-CHECK/);
    expect(help).toMatch(/AMBIGUOUS/);
    expect(help).toMatch(/operation-removed/);
    expect(help).toMatch(/output-type-widened/);
    // The two rules diff cannot fully evaluate must be stated where the person
    // reading a red build will see them.
    expect(help).toMatch(/Visibility change.*NOT\s+evaluated/s);
    expect(help).toMatch(/Exit codes/);
  });
});
