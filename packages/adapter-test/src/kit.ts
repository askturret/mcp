// SPDX-License-Identifier: Apache-2.0
/**
 * The community-facing conformance kit (§12.2, #54).
 *
 * ## This package contains no assertions
 *
 * That is the point, and it is worth stating before anything else. Every
 * fixture and every assertion comes from `@askturret/mcp-adapter-conformance` —
 * the same bank the in-repo Express and Fastify adapters are held to, imported
 * rather than copied. §54 asks for the suite "verbatim (same fixtures, same
 * assertions)", and an import is the only way to make that true and keep it
 * true: a copy is verbatim exactly once, on the day it is made.
 *
 * So what lives here is a CLI, an adapter-shape adapter, and a result format.
 * If you find an assertion in this file, something has gone wrong.
 *
 * ## What a conformance result means
 *
 * It means: at kit version X, this adapter passed these categories. Nothing
 * more. §54 is explicit that a result is scoped to the kit version — passing
 * v1.0 does not imply passing v1.1 if v1.1 added a category — so `kitVersion`
 * is on every result and in the badge, and a table entry without one is
 * unfalsifiable.
 */

import {
  CATEGORIES,
  runBank,
  unknownCategories,
  type CategoryResult,
} from '@askturret/mcp-adapter-conformance';
import type { McpFacadeOptions } from '@askturret/mcp-core';

/**
 * The kit's OWN version (§54 "the conformance kit has its own semver").
 *
 * Deliberately not the package version of `@askturret/mcp`. It answers one
 * question — which categories does a passing result cover? — and it moves when
 * the ANSWER changes: a new category, or an existing one made stricter. A
 * cosmetic change to this CLI does not move it, because a result taken before
 * that change is still exactly as meaningful.
 */
export const KIT_VERSION = '1.0.0';

/**
 * Version of the `--json` document shape (§54 "documented as a public
 * contract").
 *
 * Separate from `KIT_VERSION` because they change for different reasons and a
 * consumer cares about them differently. A CI job parsing the JSON breaks when
 * the SHAPE changes; it does not break when a category is added. Collapsing
 * them into one number would make every new category look like a breaking
 * change to every parser.
 */
export const RESULT_SCHEMA_VERSION = 1;

/**
 * What a community adapter exports (§54).
 *
 * `TestServerConfig` in the issue is not defined anywhere, and no such type
 * exists. The bank starts servers with `McpFacadeOptions` — sources, executor,
 * policies — so that is what `createServer` receives. Aliased rather than
 * renamed so the issue's vocabulary still resolves. Logged to #156.
 */
export type TestServerConfig = McpFacadeOptions;

export interface AdapterUnderTest {
  readonly name: string;
  createServer(config: TestServerConfig): Promise<{
    url: string;
    close(): Promise<void>;
  }>;
}

/** A category outcome in the JSON document. */
export interface ConformanceCategoryReport {
  readonly id: number;
  readonly category: string;
  readonly passed: boolean;
  /** Assertion detail on failure; a short description of what held on success. */
  readonly note: string;
}

/**
 * The `--json` document. **This shape is a public contract.**
 *
 * Additive changes (a new optional field) keep `schemaVersion`; anything that
 * removes or repurposes a field bumps it. The public conformance table and
 * adopters' CI both parse this, so a silent reshape would break consumers we
 * cannot see.
 */
export interface ConformanceReport {
  readonly schemaVersion: number;
  readonly kitVersion: string;
  readonly adapter: string;
  readonly passed: boolean;
  /** Categories actually run — fewer than the full set when `--category` was used. */
  readonly categories: readonly ConformanceCategoryReport[];
  /** Every category the kit knows about at this version, run or not. */
  readonly knownCategories: readonly string[];
  /**
   * True when every known category ran.
   *
   * A filtered run is not a conformance claim, and without this flag a
   * `--category discovery` result that passed would look identical to a full
   * pass in the JSON. The table generator refuses partial results because of
   * this field.
   */
  readonly complete: boolean;
}

/** Every category name the kit knows about, in bank order. */
export function knownCategoryNames(): readonly string[] {
  return CATEGORIES.map((c) => c.name);
}

export class AdapterContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterContractError';
  }
}

/**
 * Validate a module's default/named export against `AdapterUnderTest`.
 *
 * Checked structurally and reported specifically, because the alternative is a
 * `TypeError: adapter.createServer is not a function` from somewhere inside the
 * bank — which reads like a bug in the kit rather than a mistake in the
 * adapter, and sends the author to the wrong repository.
 */
export function assertAdapterUnderTest(value: unknown): asserts value is AdapterUnderTest {
  if (value === null || typeof value !== 'object') {
    throw new AdapterContractError(
      `The adapter module did not export an object. Export an AdapterUnderTest: ` +
        `{ name: string, createServer(config): Promise<{ url, close }> }.`,
    );
  }

  const candidate = value as Partial<AdapterUnderTest>;

  if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
    throw new AdapterContractError(
      `The adapter is missing a non-empty 'name'. It labels every row of the report, so an ` +
        `unnamed adapter produces a result nobody can attribute.`,
    );
  }

  if (typeof candidate.createServer !== 'function') {
    throw new AdapterContractError(
      `Adapter '${candidate.name}' has no createServer(config) function. It must start a ` +
        `server and resolve { url, close } — the kit drives it over HTTP and never imports ` +
        `your framework.`,
    );
  }
}

export interface RunConformanceOptions {
  /** Category names to run. Absent means all. */
  readonly categories?: readonly string[];
}

/**
 * Run the bank against a community adapter.
 *
 * The whole function is a translation: `AdapterUnderTest.createServer` has the
 * same shape as the bank's internal factory, so this hands one to the other and
 * gets out of the way.
 */
export async function runConformance(
  adapter: AdapterUnderTest,
  options?: RunConformanceOptions,
): Promise<ConformanceReport> {
  const requested = options?.categories;

  if (requested !== undefined) {
    const unknown = unknownCategories(requested);
    if (unknown.length > 0) {
      throw new AdapterContractError(
        `Unknown categor${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}. ` +
          `Known: ${knownCategoryNames().join(', ')}.`,
      );
    }
    if (requested.length === 0) {
      throw new AdapterContractError('No categories selected; nothing would run.');
    }
  }

  const results: readonly CategoryResult[] = await runBank(
    adapter.name,
    (config) => adapter.createServer(config),
    requested === undefined ? undefined : { categories: requested },
  );

  const categories = results.map((r) => ({
    id: r.id,
    category: r.category,
    passed: r.passed,
    note: r.note,
  }));

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    kitVersion: KIT_VERSION,
    adapter: adapter.name,
    passed: categories.every((c) => c.passed),
    categories,
    knownCategories: knownCategoryNames(),
    complete: categories.length === CATEGORIES.length,
  };
}

/** Human-readable report (§54 "per-category pass/fail summary"). */
export function renderReport(report: ConformanceReport): string {
  const width = Math.max(...report.categories.map((c) => c.category.length), 'category'.length);

  const lines = [
    `Adapter conformance — ${report.adapter}`,
    `kit ${report.kitVersion} · schema ${report.schemaVersion}`,
    '',
    `${'category'.padEnd(width)} | result`,
    `${'-'.repeat(width)}-+-------`,
  ];

  for (const category of report.categories) {
    lines.push(`${category.category.padEnd(width)} | ${category.passed ? 'PASS' : 'FAIL'}`);
  }

  const failed = report.categories.filter((c) => !c.passed);
  lines.push('');
  lines.push(
    `${report.categories.length - failed.length}/${report.categories.length} passed` +
      (report.complete ? '' : ` (PARTIAL RUN — ${report.knownCategories.length} categories exist)`),
  );

  if (failed.length > 0) {
    lines.push('');
    lines.push('Failures:');
    // The note is the assertion message from the bank. Printed in full rather
    // than truncated: it is the only thing that tells an author WHY, and a
    // conformance tool that says FAIL without a reason just moves the work.
    for (const category of failed) lines.push(`  ${category.category}: ${category.note}`);
  }

  return lines.join('\n');
}

/**
 * A README badge (§54 `--generate-badge`).
 *
 * Hand-built SVG rather than a shields.io URL: a badge that fetches from a
 * third party at render time turns an outage there into a broken README here,
 * and leaks a view of who is reading the repo.
 *
 * The badge carries the KIT VERSION, not just pass/fail. A green badge that
 * does not say what it passed is the exact claim §54's versioning section
 * warns against — passing v1.0 does not imply passing v1.1.
 */
export function generateBadge(report: ConformanceReport): string {
  const label = 'conformance';
  const message = report.passed
    ? `pass · kit ${report.kitVersion}`
    : `fail · kit ${report.kitVersion}`;
  const colour = report.passed ? '#2ea44f' : '#d73a49';

  // ~6.6px per char at 11px DejaVu Sans is the conventional approximation.
  const labelWidth = Math.round(label.length * 6.6) + 12;
  const messageWidth = Math.round(message.length * 6.6) + 12;
  const total = labelWidth + messageWidth;

  const escape = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" `,
    `aria-label="${escape(label)}: ${escape(message)}">`,
    `<title>${escape(label)}: ${escape(message)}</title>`,
    `<rect width="${labelWidth}" height="20" fill="#555"/>`,
    `<rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${colour}"/>`,
    `<g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">`,
    `<text x="${labelWidth / 2}" y="14">${escape(label)}</text>`,
    `<text x="${labelWidth + messageWidth / 2}" y="14">${escape(message)}</text>`,
    `</g></svg>`,
  ].join('');
}
