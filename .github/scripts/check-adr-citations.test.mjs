#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for check-adr-citations.mjs (#223).
 *
 * A guard that cannot fail reports safety it never checked — the same defect
 * class it exists to catch. So the negative cases carry the weight here.
 *
 * Runs the real script as a subprocess against scratch trees, so this exercises
 * the file CI runs rather than a re-implementation of its logic.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-adr-citations.mjs');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check(desc, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`ok   - ${desc}`);
  } else {
    failed++;
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'adr-cite-'));
  tmpDirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

const run = (dir) => {
  const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const AN_ADR = { 'docs/adr/ADR-014-executors.md': '# ADR-014\n' };

// --- The core claim.

check(
  'FLAGS a citation whose ADR file does not exist',
  run(scratch({ ...AN_ADR, 'src/a.ts': '// ADR-002: something\n' })).code,
  1,
);

check(
  'accepts a citation whose ADR file exists',
  run(scratch({ ...AN_ADR, 'src/a.ts': '// ADR-014: executors\n' })).code,
  0,
);

check(
  'names the file, line and number of a dangling citation',
  run(scratch({ ...AN_ADR, 'src/a.ts': '// x\n// ADR-002: something\n' })).out.includes(
    'src/a.ts:2 — ADR-002 has no file',
  ),
  true,
);

// --- Vacuous-pass refusal. With no records, "every citation resolves" is true
// --- and worthless — the exact "could not check" reported as "passed" shape
// --- these guards exist to refuse.

check(
  'REFUSES when docs/adr/ has no ADR files',
  run(scratch({ 'docs/adr/README.md': '# ADRs\n', 'src/a.ts': '// no citation\n' })).code,
  1,
);

check(
  'REFUSES when docs/adr/ does not exist at all',
  run(scratch({ 'src/a.ts': '// no citation\n' })).code,
  1,
);

// --- docs/adr/ is NO LONGER exempt (#321). The exemption sat exactly where the
// --- citations are densest — the backfilled records cross-reference each other
// --- constantly — so an intra-ADR typo was the one dangling class the guard
// --- could not catch. Every case below WITNESSES that change: each passed
// --- vacuously on the pre-fix tree, because the whole directory was skipped.

const MARKER = `adr-citation${'-'}exempt`;

check(
  'WITNESS: FLAGS a typo\'d cross-reference INSIDE an ADR',
  // The motivating case: ADR-016 written where ADR-014 was meant. Before #321
  // this returned 0 without reading the line.
  run(
    scratch({
      ...AN_ADR,
      'docs/adr/ADR-014-executors.md': '# ADR-014\n\nSee ADR-016 for the redaction pipeline.\n',
    }),
  ).code,
  1,
);

check(
  'WITNESS: names the ADR file, line and number of the intra-ADR typo',
  run(
    scratch({
      ...AN_ADR,
      'docs/adr/ADR-014-executors.md': '# ADR-014\n\nSee ADR-016 for the redaction pipeline.\n',
    }),
  ).out.includes('docs/adr/ADR-014-executors.md:3 — ADR-016 has no file'),
  true,
);

check(
  'WITNESS: FLAGS a dangling citation in the ADR index too',
  run(
    scratch({ ...AN_ADR, 'docs/adr/README.md': 'ADR-002 was reconstructed.\n' }),
  ).code,
  1,
);

// --- The per-line opt-out, which is what makes the above affordable.

check(
  'CONTROL: a marked line is exempt, so the deliberate hypothetical still passes',
  // Verified against a reverted guard: this passes there too, because the whole
  // directory was exempt anyway. It is a CONTROL — it pins the acceptance
  // criterion (the hypothetical must keep passing) rather than witnessing the
  // change. The witness that the MARKER is what does the exempting is the
  // outside-docs/adr/ case below, where no directory exemption can explain it.
  run(
    scratch({
      ...AN_ADR,
      'docs/adr/README.md': `A future reader finding an ADR-003 would assume. <!-- ${MARKER} -->\n`, // adr-citation-exempt: fixture text, not a citation
    }),
  ).code,
  0,
);

check(
  'WITNESS: the exemption is reported, so it cannot grow unnoticed',
  run(
    scratch({
      ...AN_ADR,
      'docs/adr/README.md': `An ADR-003 hypothetical. <!-- ${MARKER} -->\n`, // adr-citation-exempt: fixture text, not a citation
    }),
  ).out.includes('1 citation(s) skipped'),
  true,
);

check(
  'WITNESS: the marker exempts its LINE, not the file it sits in',
  // The property that separates this from the old whole-file exemption. A
  // marked line must not license a typo elsewhere in the same file — that
  // would reproduce the blind spot at smaller scale.
  run(
    scratch({
      ...AN_ADR,
      'docs/adr/README.md': `An ADR-003 hypothetical. <!-- ${MARKER} -->\nAnd a typo: ADR-016.\n`, // adr-citation-exempt: fixture text, not a citation
    }),
  ).code,
  1,
);

check(
  'WITNESS: the marker works outside docs/adr/ as well',
  // Not a docs/adr/ special case: any file may have a deliberately
  // unresolvable number. This reddens pre-fix, where no marker existed and a
  // dangling citation in src/ failed regardless.
  run(scratch({ ...AN_ADR, 'src/a.ts': `// ADR-002 was never written. ${MARKER}\n` })).code,
  0,
);

check(
  'CONTROL: an unmarked dangling citation outside docs/adr/ still fails',
  // Cannot fail on the pre-fix tree — this was already the behaviour. It is
  // here to show the marker did not widen into a general amnesty.
  run(scratch({ ...AN_ADR, 'src/a.ts': '// ADR-002 was never written.\n' })).code,
  1,
);

// --- Shape of the pattern. Three digits, so these are not citations.

check(
  'a bare "ADR" with no number is not a citation',
  run(scratch({ ...AN_ADR, 'src/a.ts': '// see the ADR for this\n' })).code,
  0,
);

check(
  'a one-digit "ADR-7" is not a citation',
  run(scratch({ ...AN_ADR, 'src/a.ts': '// ADR-7 maybe\n' })).code,
  0,
);

check(
  'flags a dangling citation in a markdown file too, not just source',
  // The original dangling set spanned .ts, .md and CHANGELOG.md.
  run(scratch({ ...AN_ADR, 'docs/architecture.md': 'Per ADR-019 the model...\n' })).code,
  1,
);

check(
  'WITNESS: counts every citation, not just the first per file',
  // Three, not two, since #321: the ADR file's own `# ADR-014` heading is
  // inside the scanned set now that docs/adr/ is no longer exempt. It resolves
  // — a record citing itself always does — so it is counted and not flagged.
  //
  // Labelled a witness because the NUMBER moved: this asserted 2 before and
  // reddens on a reverted guard. The count is the cheapest observable proof
  // that the scan actually widened, rather than the exemption merely being
  // reworded.
  run(
    scratch({ ...AN_ADR, 'src/a.ts': '// ADR-014 and ADR-014 again\n' }),
  ).out.includes('Checked 3 ADR citation(s)'),
  true,
);

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
