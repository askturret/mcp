// SPDX-License-Identifier: Apache-2.0
/**
 * `inspect`, `diff` and `diagnostics` refuse what they do not recognise (#261),
 * and `diagnostics --preset` refuses a value it cannot honour (#255).
 *
 * ## The shape
 *
 * Every command matched flags by exact string equality, and only `migrate` had
 * a `default:` that refused anything else. So these three silently discarded
 * any unrecognised `--token` and any `--flag=value` spelling — the same
 * false-green shape #169 was filed for and #256 fixed in `doctor` alone.
 *
 * ## Two layers, deliberately
 *
 * `normalizeFlags` is pure, so the matrix is cheap to pin exactly. But a
 * normaliser returning the right string proves nothing about the commands:
 * #110 in this repo was exactly that shape, and #253 repeated it — a bound that
 * worked perfectly on a path nobody called. So each command's exit code and
 * stderr are also asserted against the real built binary.
 *
 * The subprocess layer needs `packages/cli/dist`; `test-cli` runs
 * `npm run build -w packages/core -w packages/cli` first, and `test-integrity`
 * runs a full build.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeFlags, type FlagSpec } from '../args.js';
import { resolveDiagnosticsPreset } from '../commands/diagnostics.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = join(REPO_ROOT, 'packages/cli/dist/cli.js');

const SPEC: FlagSpec = {
  command: 'demo',
  value: ['--url', '--out'],
  boolean: ['--json', '--help', '-h'],
};

let workdir: string;
let specPath: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'cli-args-'));
  specPath = join(workdir, 'openapi.json');
  writeFileSync(
    specPath,
    JSON.stringify({ openapi: '3.0.0', info: { title: 'f', version: '1.0.0' }, paths: {} }),
  );
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('normalizeFlags (#261)', () => {
  it('rewrites --flag=value into the space-separated form', () => {
    // The whole point: each command's existing loop keeps working unchanged,
    // because it never sees the `=` spelling.
    expect(normalizeFlags(['--url=http://x', '--json'], SPEC).args).toEqual([
      '--url',
      'http://x',
      '--json',
    ]);
  });

  it('leaves the space-separated form alone', () => {
    expect(normalizeFlags(['--url', 'http://x'], SPEC).args).toEqual(['--url', 'http://x']);
  });

  it('refuses an unknown flag, names it, and lists what is accepted', () => {
    const { error } = normalizeFlags(['--bogus'], SPEC);

    expect(error).toContain('unknown flag `--bogus`');
    expect(error).toContain('demo accepts:');
    expect(error).toContain('--url <value>');
  });

  it('does not consume the token after an unknown flag', () => {
    // For a flag we do not recognise we cannot know whether it takes a value,
    // and swallowing the next one turns one error into two.
    const { args } = normalizeFlags(['--bogus', '--json'], SPEC);

    expect(args).toEqual(['--json']);
  });

  it('refuses a value on a boolean flag rather than ignoring it', () => {
    // Ignoring it would make `--json=false` switch JSON ON.
    expect(normalizeFlags(['--json=false'], SPEC).error).toContain('`--json` takes no value');
  });

  it('refuses a value flag with nothing after it', () => {
    expect(normalizeFlags(['--url'], SPEC).error).toContain('`--url` requires a value');
  });

  it('does not let a value flag swallow the next flag', () => {
    // `--url --json` used to set url to "--json" and fail somewhere unrelated.
    expect(normalizeFlags(['--url', '--json'], SPEC).error).toContain('requires a value');
  });

  it('treats an empty inline value as missing, not as the empty string', () => {
    expect(normalizeFlags(['--url='], SPEC).error).toContain('requires a value');
  });

  it('reports only the FIRST problem', () => {
    const { error } = normalizeFlags(['--bogus', '--alsobogus'], SPEC);

    expect(error).toContain('--bogus');
    expect(error).not.toContain('--alsobogus');
  });

  describe('the carve-outs — nothing that worked may break', () => {
    it('stops option parsing at `--`', () => {
      const { args, error } = normalizeFlags(['--', '--not-a-flag'], SPEC);

      expect(error).toBeUndefined();
      expect(args).toEqual(['--not-a-flag']);
    });

    it('passes a non-flag token through untouched', () => {
      // These commands take no positionals, so such a token is ignored
      // downstream exactly as before. This is not the place to start
      // rejecting it.
      const { args, error } = normalizeFlags(['stray'], SPEC);

      expect(error).toBeUndefined();
      expect(args).toEqual(['stray']);
    });

    it('passes an UNDECLARED single-dash token through rather than refusing it', () => {
      // `-x` did nothing before and still does nothing. Refusing it would be a
      // new rejection of something that previously "worked".
      const { args, error } = normalizeFlags(['-x'], SPEC);

      expect(error).toBeUndefined();
      expect(args).toEqual(['-x']);
    });

    it('recognises a DECLARED single-dash token', () => {
      expect(normalizeFlags(['-h'], SPEC).args).toEqual(['-h']);
    });
  });
});

describe('resolveDiagnosticsPreset (#255)', () => {
  it('includes production', () => {
    expect(resolveDiagnosticsPreset('production')).toEqual({
      kind: 'include',
      preset: 'production',
    });
  });

  it.each([
    ['regulated', /evidence verifier/],
    ['light', /inside the adapter/],
    ['nonsense', /unknown preset 'nonsense'/],
    [undefined, /requires a value/],
  ])('refuses %p with its own reason', (value, expected) => {
    const resolved = resolveDiagnosticsPreset(value as string | undefined);

    expect(resolved.kind).toBe('refuse');
    expect(resolved.kind === 'refuse' && resolved.message).toMatch(expected);
  });

  it('speaks about the BUNDLE, not about printing an expansion', () => {
    // #169's doctor wording does not transfer: there the flag prints an
    // expansion, here it decides what goes into the bundle. Telling an operator
    // to "expand it in code" would answer a question they did not ask.
    const resolved = resolveDiagnosticsPreset('regulated');

    expect(resolved.kind === 'refuse' && resolved.message).toContain('bundle');
    expect(resolved.kind === 'refuse' && resolved.message).not.toContain('doctor');
  });

  it('gives every refusal a distinct message', () => {
    // Guards the guard: four assertions above could all pass against one
    // generic string, and being able to tell the cases apart IS the issue.
    const messages = ['regulated', 'light', 'nonsense', undefined].map((v) => {
      const r = resolveDiagnosticsPreset(v as string | undefined);
      return r.kind === 'refuse' ? r.message : '(included)';
    });

    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe('the real binaries (#261)', () => {
  it.each([
    ['inspect', ['--url', 'http://127.0.0.1:1/mcp']],
    ['diff', ['--before', 'a.json', '--after', 'b.json']],
    ['diagnostics', ['--url', 'http://127.0.0.1:1/mcp']],
  ])('%s refuses an unknown flag with exit 2', (command, base) => {
    // Exit 2 is the usage-error code `inspect` and `diff` already document —
    // distinct from "the server was reached and is unhealthy".
    const { status, stderr } = cli(command, ...base, '--bogus');

    expect(status).toBe(2);
    expect(stderr).toContain('unknown flag `--bogus`');
    expect(stderr).toContain(`${command} accepts:`);
  });

  it.each([
    ['inspect', ['--url', 'http://127.0.0.1:1/mcp']],
    ['diff', ['--before', 'a.json', '--after', 'b.json']],
    ['diagnostics', ['--url', 'http://127.0.0.1:1/mcp']],
  ])('%s refuses the =value spelling of an unknown flag too', (command, base) => {
    const { status, stderr } = cli(command, ...base, '--bogus=1');

    expect(status).toBe(2);
    expect(stderr).toContain('unknown flag `--bogus`');
  });

  it.each(['inspect', 'diff', 'diagnostics'])('%s prints usage for --help, exit 0', (command) => {
    const { status, stdout } = cli(command, '--help');

    expect(status).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it('inspect gets PAST parsing on a valid command line', () => {
    // The control for inspect. Every assertion above is satisfied by a command
    // that refuses everything; this one must reach real work and fail on the
    // unreachable server instead — exit 1, which inspect reserves for exactly
    // that, not the usage code 2.
    const { status, stderr } = cli('inspect', '--url', 'http://127.0.0.1:1/mcp');

    expect(status).toBe(1);
    expect(stderr).not.toContain('unknown flag');
  });

  it('diff gets PAST parsing and reports the snapshot problem, not a usage one', () => {
    const { stderr } = cli('diff', '--before', join(workdir, 'missing.json'), '--after', 'x');

    expect(stderr).toContain('--before');
    expect(stderr).not.toContain('unknown flag');
  });
});

describe('diagnostics --preset through the real binary (#255)', () => {
  it('gives the two spellings the IDENTICAL refusal', () => {
    // Stops the spellings drifting apart: both route through one resolver.
    const inline = cli('diagnostics', '--url', 'http://127.0.0.1:1/mcp', '--preset=regulated');
    const spaced = cli('diagnostics', '--url', 'http://127.0.0.1:1/mcp', '--preset', 'regulated');

    expect(inline.stderr).toBe(spaced.stderr);
    expect(inline.status).toBe(spaced.status);
    expect(inline.status).toBe(2);
    expect(inline.stderr).toContain('evidence verifier');
  });

  it('refuses before writing a bundle', () => {
    // A refusal that arrived after the bundle was on disk would leave the
    // operator with an artifact they did not ask for.
    const out = join(workdir, 'should-not-exist.tar.gz');
    const { status } = cli('diagnostics', '--spec', specPath, '--preset', 'nonsense', '--out', out);

    expect(status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  it('still includes the expansion for --preset=production', () => {
    // The control. Asserted on the bundle's own bytes, because exit 0 proves
    // nothing about whether the preset was honoured — the exact silent drop
    // this issue is about.
    const out = join(workdir, 'ok.tar.gz');
    const { status } = cli('diagnostics', '--spec', specPath, '--preset=production', '--out', out);

    expect(status).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out).length).toBeGreaterThan(0);
  });
});
