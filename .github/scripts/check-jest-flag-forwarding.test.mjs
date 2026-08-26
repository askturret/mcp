#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for check-jest-flag-forwarding.mjs (#207).
 *
 * A guard that cannot fail is worse than no guard: it reports safety it never
 * checked, which is the exact defect class it exists to catch. So the negative
 * cases below matter more than the positive ones — each asserts the guard goes
 * RED on a form that really does misbehave, verified against npm's actual
 * behaviour before being encoded here.
 *
 * The guard runs as a SUBPROCESS against the real script, so this exercises the
 * file CI runs rather than a re-implementation of its logic.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-jest-flag-forwarding.mjs');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check(desc, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`ok   - ${desc}`);
  } else {
    failed++;
    console.log(`FAIL - ${desc} (expected ${expected}, got ${actual})`);
  }
}

/** A throwaway repo root containing `files`, keyed by repo-relative path. */
function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'jestflag-'));
  tmpDirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

const run = (dir) => spawnSync('node', [GUARD, dir], { encoding: 'utf-8' });

/** A workflow whose single `run:` step is `command`. */
const workflow = (command) =>
  `name: T\non: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${command}\n`;

// --- The two broken forms. Both were reproduced against npm 11.8 / jest 29.7
// --- before being encoded here, rather than assumed from the flag's shape.

check(
  'FAILS on a jest flag with no `--` (npm eats it and runs everything)',
  run(scratch({ '.github/workflows/t.yml': workflow('npm test --testPathPattern="parity"') })).status,
  1,
);

check(
  'FAILS on `--` without `-w` (flag reaches every workspace; jest exits 1 on a miss)',
  run(scratch({ '.github/workflows/t.yml': workflow('npm test -- --testPathPattern="parity"') }))
    .status,
  1,
);

// --- #312: the false negative. `-w` was checked for PRESENCE while `--` was
// --- checked for POSITION, so a `-w` sitting after the separator counted as
// --- scoping when npm hands it to jest as a plain argument. Measured during
// --- #207 QA at 54 suites / 844 tests, exit 0 — the full core suite, not the
// --- one file the pattern named. That is the #207 silent no-op, reintroduced
// --- through the form this guard was written to prevent.
// ---
// --- The guard's OWN remediation text produced it: "add `--` before the flag,
// --- and `-w <package>` to scope it", followed literally, appends both after
// --- `--` in that order.

{
  const after = run(
    scratch({
      '.github/workflows/t.yml': workflow(
        'npm test -- -w packages/core --testPathPattern="parity"',
      ),
    }),
  );
  check('FAILS on `-w` AFTER `--`, which npm forwards instead of consuming (#312)', after.status, 1);

  // Exit 1 alone would also be satisfied by the guard failing for an unrelated
  // reason, so assert it identified THIS defect and said where the fix goes.
  check(
    '...and reports that the `-w` is on the wrong side of the separator',
    /sits AFTER `--`/.test(after.stderr),
    true,
  );
  check(
    '...and tells the author to MOVE it rather than add one they already typed',
    /move `-w <package>` BEFORE the `--`/.test(after.stderr),
    true,
  );
}

check(
  'PASSES on the correct form, `-w <pkg>` AND `--`',
  run(
    scratch({
      '.github/workflows/t.yml': workflow(
        'npm test -w packages/core -- --testPathPattern="parity"',
      ),
    }),
  ).status,
  0,
);

check(
  'accepts the long spelling --workspace=',
  run(
    scratch({
      '.github/workflows/t.yml': workflow(
        'npm test --workspace=packages/core -- --testPathPattern="parity"',
      ),
    }),
  ).status,
  0,
);

// --- Position matters: a `--` AFTER the flag does not forward it. Without this
// --- the guard would bless a command npm still silently no-ops.

check(
  'FAILS when the `--` comes AFTER the flag rather than before it',
  run(
    scratch({
      '.github/workflows/t.yml': workflow('npm test -w packages/core --testPathPattern="p" --'),
    }),
  ).status,
  1,
);

// --- Other jest flags in the same family, so the guard is about the CLASS
// --- rather than the one flag #207 happened to name.

check(
  'FAILS on --testNamePattern with no `--`',
  run(
    scratch({ '.github/workflows/t.yml': workflow('npm test --testNamePattern="slug"') }),
  ).status,
  1,
);

check(
  'FAILS on jest 30 spelling --testPathPatterns with no `--`',
  // The flag was renamed in jest 30. Covered now so the guard does not quietly
  // stop applying the day this repo upgrades.
  run(
    scratch({ '.github/workflows/t.yml': workflow('npm test --testPathPatterns="slug"') }),
  ).status,
  1,
);

// --- package.json scripts are the other place the string EXECUTES.

check(
  'FAILS on a broken invocation inside a package.json script',
  run(
    scratch({
      'package.json': JSON.stringify({
        name: 't',
        scripts: { 'test:one': 'npm test --testPathPattern=x' },
      }),
    }),
  ).status,
  1,
);

check(
  'PASSES on a correct invocation inside a package.json script',
  run(
    scratch({
      'package.json': JSON.stringify({
        name: 't',
        scripts: { 'test:one': 'npm test -w packages/core -- --testPathPattern=x' },
      }),
    }),
  ).status,
  0,
);

// --- Things that must NOT trip it. A guard with false positives gets disabled,
// --- which is the same outcome as not having written it.

check(
  'a plain `npm test` is not flagged',
  run(scratch({ '.github/workflows/t.yml': workflow('npm test') })).status,
  0,
);

check(
  'a bare `jest --testPathPattern=x` is not flagged — npm is not in the path',
  // Running jest directly has no npm layer to eat the flag, so it works and is
  // none of this guard's business.
  run(scratch({ '.github/workflows/t.yml': workflow('npx jest --testPathPattern=x') })).status,
  0,
);

check(
  'PROSE is not scanned, so CONTRIBUTING can show the broken form as an example',
  // Load-bearing: the documentation added by #207 quotes `npm test
  // --testPathPattern=X` as the thing NOT to do. A guard that scanned prose
  // would fail on its own docs, or force them to omit the string a reader needs
  // in order to recognise the mistake.
  run(
    scratch({
      'CONTRIBUTING.md': 'Do NOT run `npm test --testPathPattern=X` — npm eats the flag.\n',
    }),
  ).status,
  0,
);

check(
  'a package.json with no scripts block does not crash the guard',
  run(scratch({ 'package.json': JSON.stringify({ name: 't' }) })).status,
  0,
);

check(
  'malformed package.json is skipped rather than reported as a flag problem',
  // Not this guard's job, and crashing here would mask the real finding.
  run(scratch({ 'package.json': '{ not json' })).status,
  0,
);

// --- The guard names the offending file and line, since a report that cannot
// --- be acted on is only a slower way to fail.

const named = run(
  scratch({ '.github/workflows/t.yml': workflow('npm test --testPathPattern="parity"') }),
);
check(
  'names the file and line of the offending command',
  /t\.yml:7/.test(named.stderr),
  true,
);
check(
  'quotes the offending command back',
  named.stderr.includes('npm test --testPathPattern="parity"'),
  true,
);

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
