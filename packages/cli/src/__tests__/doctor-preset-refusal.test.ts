// SPDX-License-Identifier: Apache-2.0
/**
 * `doctor --preset` refuses what it cannot expand, out loud (#169).
 *
 * ## The failure
 *
 * Four different situations produced one identical outcome — a clean score,
 * exit 0, and no preset section:
 *
 *   --preset production      expansion printed
 *   --preset regulated       nothing            <- supported, silently dropped
 *   --preset nonsense        nothing            <- typo
 *   (flag omitted)           nothing            <- never asked
 *
 * An operator running a compliance-adjacent check could not tell "doctor does
 * not support this" from "I typo'd it" from "I forgot the flag", and got a
 * green report either way.
 *
 * The silence was correct until #168: before it, `regulated` was not a real
 * preset name. #168 made it real, and this path went on discarding a name the
 * system genuinely supports. The behaviour did not change; its correctness did.
 *
 * ## Why both a unit layer and a subprocess layer
 *
 * `resolvePresetFlag` is pure, so the message matrix is cheap to pin exactly.
 * But a resolver that returns the right string proves nothing about the CLI:
 * #110 in this repo was precisely that shape — a unit-tested `evaluate` passing
 * while the entry point never ran it. So the exit code and stderr are also
 * asserted against the real built binary, in a real child process.
 *
 * The subprocess half needs `packages/cli/dist`. Both jobs that run this suite
 * build first: `test-cli` runs `npm run build -w packages/core -w packages/cli`,
 * and `test-integrity` runs a full `npm run build`.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePresetFlag } from '../commands/doctor.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = join(REPO_ROOT, 'packages/cli/dist/cli.js');

let workdir: string;
let specPath: string;

beforeAll(() => {
  // A self-contained fixture rather than examples/: this suite should not
  // acquire a dependency on a spec that another package also owns.
  workdir = mkdtempSync(join(tmpdir(), 'doctor-preset-'));
  specPath = join(workdir, 'openapi.json');
  writeFileSync(
    specPath,
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'fixture', version: '1.0.0' },
      paths: {},
    }),
  );
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function runDoctor(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, 'doctor', specPath, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('resolvePresetFlag (#169)', () => {
  it('expands production', () => {
    expect(resolvePresetFlag('production')).toEqual({ kind: 'expand', preset: 'production' });
  });

  it('refuses regulated with the reason it cannot be expressed as a flag', () => {
    const resolved = resolvePresetFlag('regulated');

    expect(resolved.kind).toBe('refuse');
    // The specific reason, not just "unsupported" — an operator who is told
    // "no" without a way forward files this issue again.
    expect(resolved.kind === 'refuse' && resolved.message).toContain('evidence verifier');
    expect(resolved.kind === 'refuse' && resolved.message).toContain("describePreset('regulated'");
  });

  it('refuses light for its own, different reason', () => {
    const resolved = resolvePresetFlag('light');

    expect(resolved.kind).toBe('refuse');
    // Distinct from regulated's. Collapsing both into one message would
    // reintroduce the ambiguity this issue is about, one level up.
    expect(resolved.kind === 'refuse' && resolved.message).toContain('inside the adapter');
    expect(resolved.kind === 'refuse' && resolved.message).not.toContain('evidence verifier');
  });

  it('names an unknown value as unknown, and lists what is known', () => {
    const resolved = resolvePresetFlag('nonsense');

    expect(resolved.kind).toBe('refuse');
    expect(resolved.kind === 'refuse' && resolved.message).toContain("unknown preset 'nonsense'");
    expect(resolved.kind === 'refuse' && resolved.message).toContain('light, production, regulated');
  });

  it.each([undefined, '--json'])('refuses a missing value (%p) rather than assuming none', (value) => {
    const resolved = resolvePresetFlag(value);

    expect(resolved.kind).toBe('refuse');
    expect(resolved.kind === 'refuse' && resolved.message).toContain('requires a value');
  });

  it('gives every refusal a distinct message', () => {
    // Guards the guard. Four assertions above could all pass against one
    // generic string; the point of the issue is that these cases are
    // DISTINGUISHABLE.
    const messages = ['regulated', 'light', 'nonsense', undefined].map((value) => {
      const resolved = resolvePresetFlag(value);
      return resolved.kind === 'refuse' ? resolved.message : '(expanded)';
    });

    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe('the doctor CLI itself (#169)', () => {
  it('exits non-zero and explains, for --preset regulated', () => {
    const { status, stdout, stderr } = runDoctor('--preset', 'regulated');

    expect(status).toBe(1);
    expect(stderr).toContain('`doctor --preset regulated` is not supported');
    expect(stderr).toContain('evidence verifier');
    // The old behaviour printed a full clean report and exited 0. A refusal
    // that still emitted the report would be the same misleading artifact.
    expect(stdout).not.toContain('expands to');
  });

  it('exits non-zero for an unrecognized value', () => {
    const { status, stderr } = runDoctor('--preset', 'nonsense');

    expect(status).toBe(1);
    expect(stderr).toContain("unknown preset 'nonsense'");
  });

  it('still expands production unchanged', () => {
    // The control. Without it every assertion above is satisfied by a doctor
    // that refuses every preset, which would "pass" this file and break the
    // feature.
    const { status, stdout } = runDoctor('--preset', 'production');

    expect(status).toBe(0);
    expect(stdout).toContain("Preset 'production' expands to:");
  });

  it('still carries the expansion in --json', () => {
    const { status, stdout } = runDoctor('--preset', 'production', '--json');

    expect(status).toBe(0);
    expect((JSON.parse(stdout) as { preset?: { preset?: string } }).preset?.preset).toBe(
      'production',
    );
  });

  it('is unchanged when the flag is omitted', () => {
    const { status, stdout } = runDoctor();

    expect(status).toBe(0);
    expect(stdout).not.toContain('expands to');
  });

  it('refuses before loading the spec', () => {
    // The refusal is a usage error the operator can fix immediately, so it
    // should not cost them a spec parse first. Pointing at a file that does not
    // exist proves the ordering: a load error here would mean the check moved.
    const result = spawnSync(
      process.execPath,
      [CLI, 'doctor', join(workdir, 'does-not-exist.json'), '--preset', 'regulated'],
      { encoding: 'utf-8', timeout: 30_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not supported');
    expect(result.stderr).not.toContain('Analysis failed');
  });

  it('does not swallow the following flag when --preset has no value', () => {
    // `--preset --json` must report the missing value rather than consuming
    // --json as the preset name and then failing on something unrelated.
    const { status, stderr } = runDoctor('--preset', '--json');

    expect(status).toBe(1);
    expect(stderr).toContain('`--preset` requires a value');
  });
});
