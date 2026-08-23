// SPDX-License-Identifier: Apache-2.0
/**
 * The public conformance table (§54).
 *
 * Generated from real runs, never hand-written. A table typed by hand is a
 * claim about adapters rather than a measurement of them, and it goes stale
 * silently — which is the specific failure a conformance table exists to
 * prevent.
 */

import { knownCategoryNames, type ConformanceReport } from './kit.js';

/**
 * Render reports as a markdown table.
 *
 * PARTIAL reports are refused rather than rendered with a footnote. A row built
 * from `--category discovery` would look identical to a full pass once it is a
 * PASS cell in a table, and a conformance table that can contain a partial
 * result is one nobody can rely on.
 */
export function renderConformanceTable(
  reports: readonly ConformanceReport[],
  generatedAt: string,
): string {
  const partial = reports.filter((r) => !r.complete);
  if (partial.length > 0) {
    throw new Error(
      `Refusing to build a conformance table from partial runs: ` +
        `${partial.map((r) => r.adapter).join(', ')}. Run every category.`,
    );
  }

  const categories = knownCategoryNames();
  const header = `| adapter | kit | ${categories.join(' | ')} | result |`;
  const divider = `|---|---|${categories.map(() => '---').join('|')}|---|`;

  const rows = reports.map((report) => {
    const cells = categories.map((name) => {
      const result = report.categories.find((c) => c.category === name);
      return result === undefined ? '—' : result.passed ? '✅' : '❌';
    });
    return `| \`${report.adapter}\` | ${report.kitVersion} | ${cells.join(' | ')} | ${
      report.passed ? '**PASS**' : '**FAIL**'
    } |`;
  });

  return [header, divider, ...rows, '', `_Generated ${generatedAt}._`].join('\n');
}
