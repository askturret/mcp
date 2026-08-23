// SPDX-License-Identifier: Apache-2.0
/**
 * Golden fixture classifications (§13 "Golden fixtures").
 *
 * Drives the REAL diff engine over snapshot pairs on disk and asserts the exact
 * set of change codes each pair produces. The expectations live in
 * `fixtures/golden.json` rather than inline, so "what counts as breaking" is
 * reviewable as data in a PR instead of being spread across assertions.
 *
 * The set comparison is EXACT in both directions. A rule that stops firing and
 * a rule that starts firing spuriously are the same defect from a release
 * gate's point of view — one lets a break through, the other trains people to
 * ignore the gate.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deserializeSnapshot } from '../../snapshot-io.js';
import { diffSnapshots } from '../diff.js';
import type { ChangeSeverity, EffectClassification } from '../../index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface GoldenCase {
  readonly name: string;
  readonly before: string;
  readonly after: string;
  readonly renames?: Record<string, string>;
  readonly confirmFor?: string[];
  readonly hasBreaking: boolean;
  readonly codes: Record<string, ChangeSeverity>;
}

function load(file: string) {
  return deserializeSnapshot(JSON.parse(readFileSync(join(FIXTURES, file), 'utf-8')));
}

const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf-8')) as {
  cases: GoldenCase[];
};

describe('golden diff fixtures', () => {
  it.each(golden.cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const report = diffSnapshots(load(testCase.before), load(testCase.after), {
      ...(testCase.renames === undefined ? {} : { renames: testCase.renames }),
      ...(testCase.confirmFor === undefined
        ? {}
        : { confirmFor: testCase.confirmFor as EffectClassification[] }),
    });

    const actual: Record<string, ChangeSeverity> = {};
    for (const change of report.changes) {
      actual[change.code] = change.severity;
    }

    expect(actual).toEqual(testCase.codes);
    expect(report.hasBreaking).toBe(testCase.hasBreaking);
  });

  it('every fixture file is referenced by at least one golden case', () => {
    // An orphaned fixture is a case someone meant to cover and did not. Without
    // this the file sits in the tree looking like coverage that does not exist.
    const referenced = new Set(golden.cases.flatMap((c) => [c.before, c.after]));
    const onDisk = readdirSync(FIXTURES).filter(
      (f) => f.endsWith('.json') && f !== 'golden.json',
    );

    expect([...onDisk].filter((f) => !referenced.has(f))).toEqual([]);
  });

  it('summary counts agree with the changes actually emitted', () => {
    // The summary is what a CI gate reads instead of counting for itself, so a
    // summary that drifts from `changes` is a silently wrong gate.
    for (const testCase of golden.cases) {
      const report = diffSnapshots(load(testCase.before), load(testCase.after), {
        ...(testCase.renames === undefined ? {} : { renames: testCase.renames }),
      });

      const count = (severity: ChangeSeverity): number =>
        report.changes.filter((c) => c.severity === severity).length;

      expect(report.summary.breaking).toBe(count('breaking'));
      expect(report.summary.nonBreaking).toBe(count('non-breaking'));
      expect(report.summary.doubleCheck).toBe(count('double-check'));
      expect(report.summary.ambiguous).toBe(count('ambiguous'));
      expect(report.hasBreaking).toBe(report.summary.breaking > 0);
    }
  });
});
