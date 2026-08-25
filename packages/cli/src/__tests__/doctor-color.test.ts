// SPDX-License-Identifier: Apache-2.0
/**
 * Colour suppression (#203) and E/W column alignment (#204) in doctor output.
 *
 * These drive the REAL `shouldUseColor` and the REAL `formatHumanReadable`.
 * The alignment assertions deliberately measure the rendered string rather
 * than re-deriving the expected padding from `padEnd(2)` — a test that
 * recomputes the production formula passes whatever that formula does, which
 * is the "Transcribed Oracle" antipattern `docs/TESTING.md` names.
 *
 * `shouldUseColor` takes its stream and env as parameters, so nothing here
 * mutates `process.env` or `process.stdout` — mutation leaks across test files
 * sharing a jest worker.
 */

import { describe, it, expect } from '@jest/globals';
import { shouldUseColor } from '../color.js';
import { formatHumanReadable } from '../commands/doctor-output.js';
import type { AnalysisResult, OperationAnalysis } from '../commands/doctor-types.js';

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const stripColour = (s: string): string => s.replace(SGR, '');

const TTY = { isTTY: true };
const PIPE = { isTTY: false };

function op(overrides: Partial<OperationAnalysis> = {}): OperationAnalysis {
  return {
    path: '/users',
    method: 'GET',
    findings: [],
    wouldBeExposedInLight: true,
    ...overrides,
  };
}

/** A result with BOTH coloured (non-zero) and uncoloured (`-`) E/W cells. */
function mixedResult(): AnalysisResult {
  return {
    score: 42,
    operations: [
      op({
        operationId: 'listUsers',
        findings: [
          { severity: 'error', code: 'E1', message: 'boom' },
          { severity: 'error', code: 'E2', message: 'boom' },
          { severity: 'warning', code: 'W1', message: 'meh' },
        ],
      }),
      // No findings at all -> both cells render the uncoloured '-'.
      op({ operationId: 'getUser', method: 'POST', wouldBeExposedInLight: false }),
    ],
    globalFindings: [],
    summary: {
      totalOperations: 2,
      errors: 2,
      warnings: 1,
      info: 0,
      lightExposed: 2,
      lightDropped: 0,
    },
    spec: { openApiVersion: '3.0.0' },
  };
}

/** Where the `E` column starts, taken from the rendered header. */
function eColumn(lines: string[], header: number): number {
  const index = lines[header]?.indexOf('E  W  Light') ?? -1;
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

/**
 * The operations-table body rows, colour stripped.
 *
 * Returns whole lines rather than pre-sliced cells: the property under test is
 * that the columns line up ACROSS rows, and slicing by a width this test
 * computed would re-derive the production padding rather than observe it.
 */
function tableBody(rendered: string): { rows: string[]; eStart: number } {
  const lines = stripColour(rendered).split('\n');
  const header = lines.findIndex((l) => l.includes('E  W  Light'));
  expect(header).toBeGreaterThanOrEqual(0);

  const rows: string[] = [];
  // +2 skips the header and the ─── rule; the table ends at the first blank line.
  for (const line of lines.slice(header + 2)) {
    if (line.trim() === '') break;
    rows.push(line);
  }
  return { rows, eStart: eColumn(lines, header) };
}

describe('shouldUseColor (#203)', () => {
  it('enables colour on a TTY with no NO_COLOR set', () => {
    expect(shouldUseColor(TTY, {})).toBe(true);
  });

  it('disables colour when stdout is not a TTY', () => {
    expect(shouldUseColor(PIPE, {})).toBe(false);
  });

  it('treats a missing isTTY (a plain pipe) as not a TTY', () => {
    expect(shouldUseColor({}, {})).toBe(false);
  });

  it('disables colour when NO_COLOR is set, even on a TTY', () => {
    expect(shouldUseColor(TTY, { NO_COLOR: '1' })).toBe(false);
  });

  it.each(['1', '0', 'false', 'no', 'true', ' '])(
    'disables colour for NO_COLOR=%p — the convention keys on presence, not value',
    (value) => {
      expect(shouldUseColor(TTY, { NO_COLOR: value })).toBe(false);
    },
  );

  it('does NOT disable colour for an EMPTY NO_COLOR — an empty value is not a request', () => {
    // https://no-color.org: the variable must be present AND non-empty.
    expect(shouldUseColor(TTY, { NO_COLOR: '' })).toBe(true);
  });
});

describe('doctor output colour suppression (#203)', () => {
  it('emits SGR codes on a TTY', () => {
    const text = formatHumanReadable(mixedResult(), { color: true });
    expect(text).toMatch(SGR);
  });

  it('emits NO SGR codes when colour is disabled', () => {
    const text = formatHumanReadable(mixedResult(), { color: false });
    expect(text).not.toMatch(SGR);
    expect(text).not.toContain(ESC);
  });

  it('defaults to the DETECTED setting, not a hardcoded one', () => {
    // Without this, every other test here passes `color` explicitly and a
    // regression that hardcodes `const color = true` — i.e. undoes #203
    // entirely — would go unnoticed. Asserts the wiring rather than a fixed
    // answer, so it holds whether or not the test runner owns a TTY.
    const expected = shouldUseColor();
    const hasEscapes = new RegExp(`${ESC}\\[[0-9;]*m`).test(formatHumanReadable(mixedResult()));
    expect(hasEscapes).toBe(expected);
  });

  it('still reports the counts when colour is off — suppression must not drop data', () => {
    // Guards the lazy fix of returning '' instead of the plain value.
    const text = formatHumanReadable(mixedResult(), { color: false });
    expect(text).toContain('Errors:           2');
    expect(text).toContain('Warnings:         1');
  });
});

describe('E/W column alignment (#204)', () => {
  it('puts the Light column at the same offset on coloured and uncoloured rows', () => {
    // The property, stated without reference to any padding width: row 0 has
    // coloured counts (2 errors, 1 warning), row 1 has the uncoloured '-'.
    // Before the fix the coloured cells were padded as if their SGR escape
    // bytes were visible, so padEnd(2) no-opped and row 0's trailing columns
    // sat two characters left of row 1's.
    const { rows } = tableBody(formatHumanReadable(mixedResult(), { color: true }));
    expect(rows).toHaveLength(2);

    const lightOffsets = rows.map((r) => Math.max(r.indexOf('✓'), r.indexOf('✗')));
    expect(lightOffsets.every((i) => i >= 0)).toBe(true);
    expect(new Set(lightOffsets).size).toBe(1);
  });

  it('renders the E/W/Light cells exactly', () => {
    // A golden of the observed rendering, to catch a change that keeps the
    // rows aligned with each other but shifts both.
    const { rows, eStart } = tableBody(formatHumanReadable(mixedResult(), { color: true }));
    expect(rows[0]?.slice(eStart)).toBe('2   1   ✓');
    expect(rows[1]?.slice(eStart)).toBe('-   -   ✗');
  });

  it('renders the same layout with colour on and off', () => {
    // The equivalence doctor-readme.test.ts relies on when it strips colour.
    const withColour = stripColour(formatHumanReadable(mixedResult(), { color: true }));
    const withoutColour = formatHumanReadable(mixedResult(), { color: false });
    expect(withColour).toBe(withoutColour);
  });
});
