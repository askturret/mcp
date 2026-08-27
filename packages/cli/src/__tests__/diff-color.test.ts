// SPDX-License-Identifier: Apache-2.0
/**
 * `NO_COLOR` suppression in `diff` output (#309).
 *
 * `diff-output.ts` used to decide colour with its own `process.stdout.isTTY`
 * check, so `NO_COLOR=1 askturret-mcp diff ...` still emitted SGR codes on a
 * terminal. It now delegates to the shared `shouldUseColor` that `doctor`
 * already uses, which is the whole of that helper's behaviour rather than a
 * re-statement of its TTY half:
 *
 * - `NO_COLOR` present and NON-EMPTY suppresses colour whatever its value
 *   (`NO_COLOR=0` still disables — the convention keys on presence).
 * - `NO_COLOR` present but EMPTY is NOT a request to disable.
 * - A non-TTY stdout suppresses colour.
 *
 * There is deliberately nothing here about `FORCE_COLOR`: neither `color.ts`
 * nor `doctor` implements it, so there is no neighbour behaviour to carry. Were
 * it added it belongs in `shouldUseColor`, and both commands would inherit it.
 *
 * ## Why this file mutates globals when `doctor-color.test.ts` refuses to
 *
 * `shouldUseColor` takes its stream and env as parameters precisely so tests do
 * not have to touch globals, and `doctor-color.test.ts` exercises it that way.
 * That seam cannot reach the bug #309 is about. The defect was in the DEFAULT
 * branch — the `options.color ?? …` fallback that `diff.ts` actually takes when
 * it calls `formatHumanReadable(report)` with no options — and that branch is
 * defined by reading `process.stdout` and `process.env`. A test that injects a
 * fake stream bypasses the very expression that was wrong.
 *
 * So the globals are patched, and restored in a `finally` so nothing leaks to
 * another test file sharing this jest worker. The mutation is the point, not a
 * shortcut around one.
 */

import { describe, it, expect } from '@jest/globals';
import type { DiffReport } from '@askturret/mcp-core';

import { formatHumanReadable } from '../commands/diff-output.js';

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`);

/** A report with changes in it, so a coloured render has something to paint. */
function report(): DiffReport {
  return {
    before: { version: 1, hash: 'aaaaaaaaaaaaaaaa' },
    after: { version: 2, hash: 'bbbbbbbbbbbbbbbb' },
    changes: [
      {
        code: 'operation-removed',
        severity: 'breaking',
        operationId: 'listUsers',
        detail: 'operation removed',
      },
      {
        code: 'input-optional-field-added',
        severity: 'non-breaking',
        operationId: 'getUser',
        detail: 'optional field added',
        path: 'input.nickname',
      },
    ],
    summary: { breaking: 1, nonBreaking: 1, doubleCheck: 0, ambiguous: 0 },
    hasBreaking: true,
  };
}

/**
 * Run `render` with `process.stdout.isTTY` and `NO_COLOR` pinned, then put both
 * back exactly as they were — including restoring "was not set at all", which a
 * plain reassignment would turn into the string `"undefined"`.
 */
function withTerminal(
  { isTTY, noColor }: { isTTY: boolean; noColor?: string },
  render: () => string,
): string {
  const priorIsTTY = process.stdout.isTTY;
  const priorNoColor = process.env['NO_COLOR'];

  process.stdout.isTTY = isTTY;
  if (noColor === undefined) delete process.env['NO_COLOR'];
  else process.env['NO_COLOR'] = noColor;

  try {
    return render();
  } finally {
    process.stdout.isTTY = priorIsTTY;
    if (priorNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = priorNoColor;
  }
}

describe('diff output colour suppression (#309)', () => {
  // THE witness. Reverting diff-output.ts to `process.stdout.isTTY === true`
  // reddens exactly this assertion: isTTY is pinned true, so the old expression
  // returns true, colour is painted, and the SGR match fires.
  it('suppresses colour on a TTY when NO_COLOR is set', () => {
    const text = withTerminal({ isTTY: true, noColor: '1' }, () => formatHumanReadable(report()));
    expect(text).not.toMatch(SGR);
    expect(text).not.toContain(ESC);
  });

  // The control. Without it the assertion above could be satisfied by a
  // renderer that never emits colour at all, which would pass while breaking
  // the feature — the "Decorative Guard" shape docs/TESTING.md names.
  it('still emits colour on a TTY when NO_COLOR is unset', () => {
    const text = withTerminal({ isTTY: true }, () => formatHumanReadable(report()));
    expect(text).toMatch(SGR);
  });

  it('does NOT treat an EMPTY NO_COLOR as a request to disable colour', () => {
    // https://no-color.org: the variable must be present AND non-empty. This is
    // inherited from `shouldUseColor` rather than restated here.
    const text = withTerminal({ isTTY: true, noColor: '' }, () => formatHumanReadable(report()));
    expect(text).toMatch(SGR);
  });

  it.each(['1', '0', 'false', 'no', 'true', ' '])(
    'suppresses colour for NO_COLOR=%p — presence, not value',
    (value) => {
      const text = withTerminal({ isTTY: true, noColor: value }, () =>
        formatHumanReadable(report()),
      );
      expect(text).not.toMatch(SGR);
    },
  );

  it('still suppresses colour when stdout is not a TTY (behaviour #309 must not regress)', () => {
    const text = withTerminal({ isTTY: false }, () => formatHumanReadable(report()));
    expect(text).not.toMatch(SGR);
  });

  it('keeps the report content when colour is off — suppression must not drop data', () => {
    const text = withTerminal({ isTTY: true, noColor: '1' }, () => formatHumanReadable(report()));
    expect(text).toContain('BREAKING (1)');
    expect(text).toContain('listUsers');
    expect(text).toContain('operation removed');
  });
});
