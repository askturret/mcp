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
  const r = spawnSync('node', [GUARD, dir], { encoding: 'utf-8' });
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

// --- docs/adr/ is exempt: the index names every number, and an ADR may discuss
// --- a number whose allocation is disputed (ADR-014, ADR-020).

check(
  'does NOT flag citations inside docs/adr/ itself',
  run(
    scratch({
      ...AN_ADR,
      'docs/adr/README.md': 'ADR-002, ADR-006 and ADR-018 were reconstructed.\n',
    }),
  ).code,
  0,
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
  'counts every citation, not just the first per file',
  run(
    scratch({ ...AN_ADR, 'src/a.ts': '// ADR-014 and ADR-014 again\n' }),
  ).out.includes('Checked 2 ADR citation(s)'),
  true,
);

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
