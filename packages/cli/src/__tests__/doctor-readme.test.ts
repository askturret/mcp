/**
 * The README's worked `doctor` examples match what `doctor` actually prints (#107).
 *
 * ## Why this test exists
 *
 * Three sources disagreed about the same example output: the README documented
 * `95/100` with one warning, the original #17 spec described ~5 warnings, and the
 * shipped fixture produced 0. Nothing was wrong with the code — the numbers in
 * the README had simply never been printed by the command, and `95` was not even
 * reachable under the rubric (every bonus applied to the base is 90).
 *
 * Documentation drift like that is invisible: nothing fails, and a reader cannot
 * tell a stale example from a current one. It was flagged twice and deferred
 * twice before being filed. So rather than only correcting the numbers, this pins
 * them — the examples are compared against the real renderer, and a rubric,
 * check, fixture or layout change that moves the output fails here.
 *
 * ## Why the WHOLE transcript, not just the score
 *
 * The first draft of this test asserted only the summary facts (score and
 * counts), on the reasoning that byte-comparing would fail on a harmless spacing
 * tweak. That reasoning was wrong twice over:
 *
 *  1. It let a REAL defect through. While writing this PR, the README's broken
 *     example was pasted in truncated — missing three findings, the Light Preset
 *     section and the closing line. Every summary number matched, so the
 *     summary-only test passed. A full comparison caught it immediately.
 *  2. A renderer change IS drift. If `formatHumanReadable` starts printing
 *     something different, the README examples are stale by definition — that is
 *     the thing being guarded, not a false positive.
 *
 * So the assertion is the full rendered transcript, with colour codes stripped
 * (see below).
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { OpenAPIV3 } from 'openapi-types';

import { analyzeSpec } from '../commands/doctor.js';
import { formatHumanReadable } from '../commands/doctor-output.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** src/__tests__ (ts-jest) or dist/__tests__ (built) -> package root. */
const README_PATH = join(__dirname, '../../README.md');

/**
 * Strip SGR colour codes.
 *
 * The README transcribes output as a TERMINAL renders it, so the escapes are
 * applied rather than shown. Note this is not the same as a no-colour run:
 * `colorize` emits codes unconditionally (it honours neither `NO_COLOR` nor
 * whether stdout is a TTY), and the E/W columns are padded BEFORE colouring, so
 * a coloured count ends up a space narrower. Both are pre-existing cosmetic
 * quirks, deliberately not changed under a docs-reconciliation issue — but they
 * are why this strips rather than disables colour.
 */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripColour = (s: string): string => s.replace(SGR, '');

let readme: string;

beforeAll(async () => {
  readme = await readFile(README_PATH, 'utf-8');
});

async function loadFixture(name: string): Promise<OpenAPIV3.Document> {
  const content = await readFile(join(__dirname, 'fixtures', `${name}.json`), 'utf-8');
  return JSON.parse(content) as OpenAPIV3.Document;
}

/**
 * The transcript inside the first ```bash fence under `heading`, minus the
 * leading `$ ...` command line.
 */
function documentedTranscript(heading: string): string {
  const start = readme.indexOf(heading);
  if (start === -1) {
    throw new Error(
      `README section not found: "${heading}". If it was renamed, update this test — ` +
        'do not delete the assertion.',
    );
  }
  const section = readme.slice(start);
  const fenceStart = section.indexOf('```bash');
  const fenceEnd = section.indexOf('```', fenceStart + 7);
  if (fenceStart === -1 || fenceEnd === -1) {
    throw new Error(`No \`\`\`bash block found under "${heading}".`);
  }
  const fence = section.slice(fenceStart + '```bash'.length, fenceEnd);

  // Drop the leading `$ turret doctor ...` invocation line (and any blank lines
  // before it) so what remains is only the transcript. Matching on the `$ `
  // prompt rather than a fixed offset — an off-by-one here silently leaves the
  // command line in and makes every comparison fail for the wrong reason.
  const lines = fence.split('\n');
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  if (lines[0]?.startsWith('$ ')) lines.shift();
  return lines.join('\n').trim();
}

async function renderedTranscript(fixture: string): Promise<string> {
  const report = await analyzeSpec(await loadFixture(fixture));
  return stripColour(formatHumanReadable(report)).trim();
}

const CLEAN_HEADING = '### Clean spec (`fixtures/petstore.json`):';
const BROKEN_HEADING = '### Broken spec (`fixtures/broken.json`):';

describe('README doctor examples match real output (#107)', () => {
  it('transcribes the clean fixture exactly', async () => {
    expect(documentedTranscript(CLEAN_HEADING)).toBe(await renderedTranscript('petstore'));
  });

  it('transcribes the broken fixture exactly, findings and all', async () => {
    // This is the assertion that catches a partially-pasted example.
    expect(documentedTranscript(BROKEN_HEADING)).toBe(await renderedTranscript('broken'));
  });

  it('documents two genuinely different runs', async () => {
    // Anti-vacuity. If both headings resolved to the same fence — a copy-paste
    // slip, or the fence scan matching too greedily — the assertions above could
    // both pass while only one example was really checked.
    const clean = documentedTranscript(CLEAN_HEADING);
    const broken = documentedTranscript(BROKEN_HEADING);

    expect(clean).not.toBe(broken);
    expect(clean).toContain('No issues found');
    expect(broken).toContain('Fix errors before deployment');
  });

  it('states the reachable ceiling, and the clean fixture actually hits it', async () => {
    // The clean fixture earns EVERY bonus: no errors, every operationId and
    // description present, all schemas present, 0 warnings. So its score IS the
    // rubric's maximum, which makes this a check on the ceiling itself rather
    // than on one fixture's arithmetic.
    const report = await analyzeSpec(await loadFixture('petstore'));
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBe(0);
    expect(report.score).toBe(90);

    // And the README must not go back to advertising a band the code cannot emit.
    expect(readme).toContain('reachable range is 0-90');
    expect(readme).not.toMatch(/\*\*100\*\*:\s*Perfect spec/);
  });
});
