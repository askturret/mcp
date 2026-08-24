// SPDX-License-Identifier: Apache-2.0
/**
 * `doctor` accepts `--flag=value`, and refuses flags it does not know (#256).
 *
 * ## The bypass
 *
 * `parseArgs` matched flags by exact string equality with no final `else`, so
 * every `--flag=value` spelling and every unrecognised `--` token was discarded
 * without comment:
 *
 *   --preset=regulated   silently ignored -> clean report, exit 0
 *   --jsonn              silently ignored -> human output, exit 0
 *
 * The first reproduced #169's harm exactly. That issue was filed because an
 * operator running a compliance-adjacent check could not distinguish "not
 * supported" from "I typo'd it" from "I forgot the flag" — every case gave a
 * green report. #254 fixed that for `--preset regulated` and not for
 * `--preset=regulated`, a completely conventional spelling, so the refusal was
 * bypassable by an operator who did nothing unusual.
 *
 * ## Why these run the real binary
 *
 * Same reason as `doctor-preset-refusal.test.ts`: what is under test is what a
 * user's shell gets — the exit code and stderr — and #110 in this repo is the
 * standing example of a unit-tested function passing while the entry point
 * never ran it.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = join(REPO_ROOT, 'packages/cli/dist/cli.js');

let workdir: string;
let specPath: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'doctor-args-'));
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

function doctorIn(
  cwd: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, 'doctor', ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function doctor(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return doctorIn(REPO_ROOT, ...args);
}

describe('the `=` spelling reaches the same decision (#256)', () => {
  it('gives --preset=regulated the IDENTICAL refusal to --preset regulated', () => {
    // The assertion the issue asked for, and the one that stops the two
    // spellings drifting apart. Equality, not `toContain`: two messages that
    // merely both mention "regulated" could still diverge in the part an
    // operator needs — which is the whole content of the refusal.
    const inline = doctor(specPath, '--preset=regulated');
    const spaced = doctor(specPath, '--preset', 'regulated');

    expect(inline.stderr).toBe(spaced.stderr);
    expect(inline.status).toBe(spaced.status);
    expect(inline.status).toBe(1);
    expect(inline.stderr).toContain('evidence verifier');
  });

  it.each([
    ['nonsense', /unknown preset 'nonsense'/],
    ['light', /applied inside the adapter/],
  ])('routes --preset=%s into the same resolver', (value, expected) => {
    // All four #169 refusals are inherited by the `=` form for free, because
    // both spellings converge on one resolvePresetFlag call rather than each
    // carrying its own copy of the messages.
    const { status, stderr } = doctor(specPath, `--preset=${value}`);

    expect(status).toBe(1);
    expect(stderr).toMatch(expected);
  });

  it('treats --preset= as a MISSING value, not the empty string as a value', () => {
    // Otherwise it reports `unknown preset ''`, which sends the operator
    // looking for a preset they never named.
    const { status, stderr } = doctor(specPath, '--preset=');

    expect(status).toBe(1);
    expect(stderr).toContain('`--preset` requires a value');
  });

  it('still EXPANDS for --preset=production', () => {
    // The control for this half. Every assertion above is satisfied by a parser
    // that refuses every `=` form, which would "fix" the bypass by breaking the
    // feature. Asserted on the JSON, because exit 0 alone proves nothing.
    const { status, stdout } = doctor(specPath, '--preset=production', '--json');

    expect(status).toBe(0);
    expect((JSON.parse(stdout) as { preset?: { preset?: string } }).preset?.preset).toBe(
      'production',
    );
  });
});

describe('unknown flags are refused rather than dropped (#256)', () => {
  it.each(['--bogus', '--jsonn', '--Preset'])('refuses %s and names it', (flag) => {
    // --jsonn is the case with teeth: a typo'd --json in a CI pipeline used to
    // yield human-readable output and exit 0, so the JSON parse failed
    // downstream and the blame landed on the wrong layer.
    const { status, stderr } = doctor(specPath, flag);

    expect(status).toBe(1);
    expect(stderr).toContain(`unknown flag \`${flag}\``);
    expect(stderr).toContain('doctor accepts:');
  });

  it('refuses a value on --json instead of ignoring it', () => {
    // Ignoring the value would switch JSON ON for `--json=false`, which is the
    // opposite of what was typed.
    const { status, stderr } = doctor(specPath, '--json=false');

    expect(status).toBe(1);
    expect(stderr).toContain('`--json` takes no value');
  });

  it('refuses --url with no value rather than eating the next flag', () => {
    const { status, stderr } = doctor(specPath, '--url', '--json');

    expect(status).toBe(1);
    expect(stderr).toContain('`--url` requires a value');
  });

  it('reports the flag problem even when the spec argument is also missing', () => {
    // Ordering. "Missing required argument" for `doctor --preset=regulated`
    // would send the operator to fix the wrong thing, and they would then meet
    // the real refusal on the second attempt.
    const { status, stderr } = doctor('--preset=regulated');

    expect(status).toBe(1);
    expect(stderr).toContain('is not supported');
    expect(stderr).not.toContain('Missing required argument');
  });
});

describe('what must keep working (#256)', () => {
  it('analyses a plain positional spec, unchanged', () => {
    const { status, stdout } = doctor(specPath);

    expect(status).toBe(0);
    expect(stdout).not.toContain('expands to');
  });

  it('treats a token after `--` as a file name, even when it looks like a flag', () => {
    // The conventional escape hatch for a path that looks like a flag, and it
    // must not itself be refused as an unknown flag — the obvious way to get
    // the new final `else` wrong.
    //
    // Deliberately a RELATIVE path whose first characters are dashes, run from
    // the fixture directory. Two earlier drafts of this test were vacuous:
    // `doctor -- spec.json` passes on the old parser because `--` was silently
    // dropped rather than honoured, and an ABSOLUTE path to a dash-named file
    // begins with `/`, so it never looks like a flag either. Only a relative
    // `--dashed.json` can distinguish "the separator works" from "the separator
    // was ignored and the argument happened not to need it".
    writeFileSync(
      join(workdir, '--dashed.json'),
      JSON.stringify({ openapi: '3.0.0', info: { title: 'd', version: '1.0.0' }, paths: {} }),
    );

    const { status, stderr } = doctorIn(workdir, '--', '--dashed.json');

    expect(status).toBe(0);
    expect(stderr).toBe('');
  });

  it.each(['--help', '-h'])('prints usage for %s and exits 0', (flag) => {
    // Previously `doctor --help` fell through to "Missing required argument",
    // and refusing it as an unknown flag would have been worse still.
    const { status, stdout } = doctor(flag);

    expect(status).toBe(0);
    expect(stdout).toContain('Usage: npx @askturret/mcp doctor');
    expect(stdout).toContain('--preset');
  });

  it('mixes the two spellings in one command line and honours both', () => {
    // `--preset=production` inline alongside a bare `--json`. Asserting the
    // preset actually landed, not merely that the command exited 0 — the old
    // parser also exits 0 here, having dropped the preset silently, so a
    // weaker assertion would pass on the very code this fixes.
    const { status, stdout } = doctor(specPath, '--preset=production', '--json');
    const parsed = JSON.parse(stdout) as { preset?: { preset?: string } };

    expect(status).toBe(0);
    expect(parsed.preset?.preset).toBe('production');
  });
});
