// SPDX-License-Identifier: Apache-2.0
/**
 * `--help` and the unknown-flag refusal name the same flags (#264).
 *
 * ## The disagreement
 *
 * #261 generated the unknown-flag refusal from each command's `FlagSpec` and
 * left `--help` hand-maintained. They promptly disagreed: `diagnostics --help`
 * listed nine flags while its refusal advertised twelve.
 *
 * `--help` missing from its own help is a near-universal CLI quirk. The one that
 * mattered was **`--regulated`** — a real, working disclosure control, and one
 * the `--preset regulated` refusal added in the very same PR explicitly points
 * operators at:
 *
 *   > This flag is separate from `--regulated`, which governs how much the
 *   > bundle discloses and works with any preset.
 *
 * An operator following that advice to `--help` did not find it. The only way to
 * discover a disclosure control was to trigger an error.
 *
 * ## Why this file asserts agreement rather than content
 *
 * Both lists are now rendered from one `FlagSpec`, so they cannot disagree —
 * there is no second copy left to drift. That makes these assertions cheap to
 * satisfy today and, more usefully, impossible to break accidentally: the way
 * to break them is to reintroduce a hand-maintained list, which is exactly what
 * should fail.
 *
 * Asserted against the REAL binaries, not the renderer, because a renderer that
 * agrees with itself proves nothing about what a command actually prints —
 * #110, #253 and #261 each turned on precisely that gap.
 */

import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acceptedSummary, renderOptions, type FlagSpec } from '../args.js';
import { INSPECT_FLAGS } from '../commands/inspect.js';
import { DIFF_FLAGS } from '../commands/diff.js';
import { DIAGNOSTICS_FLAGS } from '../commands/diagnostics.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = join(REPO_ROOT, 'packages/cli/dist/cli.js');

const SPECS: ReadonlyArray<readonly [string, FlagSpec]> = [
  ['inspect', INSPECT_FLAGS],
  ['diff', DIFF_FLAGS],
  ['diagnostics', DIAGNOSTICS_FLAGS],
];

function cli(...args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Every `--flag` and `-x` token appearing in a blob, deduped. */
function flagsIn(text: string): string[] {
  return [...new Set(text.match(/(?<![\w-])--?[a-z][a-z-]*/g) ?? [])].sort();
}

/** Every spelling the spec declares. */
function declared(spec: FlagSpec): string[] {
  return [
    ...new Set(spec.flags.flatMap((f) => (f.alias === undefined ? [f.name] : [f.name, f.alias]))),
  ].sort();
}

describe('help and the unknown-flag refusal agree (#264)', () => {
  it.each(SPECS)('%s: every declared flag appears in --help', (command, spec) => {
    const { stdout } = cli(command, '--help');

    // The #264 assertion. `--regulated` was declared, accepted, working, and
    // absent from this output.
    for (const flag of declared(spec)) {
      expect(stdout).toContain(flag);
    }
  });

  it.each(SPECS)('%s: every declared flag appears in the refusal list', (command, spec) => {
    const { stderr } = cli(command, '--definitely-not-a-flag');

    for (const flag of declared(spec)) {
      expect(stderr).toContain(flag);
    }
  });

  it.each(SPECS)('%s: the two lists name the SAME set', (command, spec) => {
    // The agreement itself, independent of the spec — if both renderings ever
    // stop coming from one list, this is what notices.
    const help = cli(command, '--help').stdout;
    const refusal = cli(command, '--definitely-not-a-flag').stderr;

    const inHelp = flagsIn(help).filter((f) => declared(spec).includes(f));
    const inRefusal = flagsIn(refusal).filter((f) => declared(spec).includes(f));

    expect(inHelp).toEqual(inRefusal);
    expect(inHelp).toEqual(declared(spec));
  });

  it('diagnostics documents --regulated, which the --preset refusal points at', () => {
    // The specific loop #264 closed, pinned end to end: the refusal sends an
    // operator to --help, and --help must answer.
    const refusal = cli('diagnostics', '--url', 'http://127.0.0.1:1/mcp', '--preset', 'regulated');
    const help = cli('diagnostics', '--help');

    expect(refusal.stderr).toContain('--regulated');
    expect(help.stdout).toContain('--regulated');
    // And says what it does, not merely that it exists — the reason an operator
    // was sent here is to learn the difference from `--preset`.
    expect(help.stdout).toMatch(/--regulated[\s\S]{0,200}disclos/i);
  });
});

describe('the renderers themselves', () => {
  it('renders one option line per flag, plus its continuations', () => {
    const spec: FlagSpec = {
      command: 'demo',
      flags: [
        { name: '--one', placeholder: '<v>', description: 'first' },
        { name: '--two', alias: '-t', description: 'second\nwrapped' },
      ],
    };

    expect(renderOptions(spec)).toEqual([
      '  --one <v>  first',
      '  --two, -t  second',
      '             wrapped',
    ]);
  });

  it('summarises accepted flags by name, without the descriptions', () => {
    // A refusal points at `--help`; it does not replace it. A paragraph per flag
    // in an error message would bury the flag that was actually wrong.
    const spec: FlagSpec = {
      command: 'demo',
      flags: [
        { name: '--one', placeholder: '<v>', description: 'a long explanation' },
        { name: '--help', alias: '-h', description: 'another long explanation' },
      ],
    };

    expect(acceptedSummary(spec)).toBe('--one <v>, --help, -h');
  });

  it('treats the placeholder as the only marker of a value flag', () => {
    // Guards the modelling choice: there is no separate boolean list to keep in
    // step, which is one fewer thing that can disagree.
    const spec: FlagSpec = {
      command: 'demo',
      flags: [
        { name: '--takes', placeholder: '<v>', description: 'x' },
        { name: '--bare', description: 'y' },
      ],
    };

    expect(acceptedSummary(spec)).toBe('--takes <v>, --bare');
  });
});
