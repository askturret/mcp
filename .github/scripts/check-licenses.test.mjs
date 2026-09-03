#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the licence policy and exception matching (#24).
 *
 * The SPDX expression evaluator is the part of this gate most likely to be
 * quietly wrong: an OR that behaves like an AND would wave GPL through, and an
 * AND that behaves like an OR would block work for no reason. Both directions
 * are covered here, along with the malformed inputs real package.json files
 * contain.
 *
 * Run: node .github/scripts/check-licenses.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { classifyExpression, classifyId } from './lib/license-policy.mjs';
import { parseExceptions, findException } from './check-licenses.mjs';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function check(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// --- permissive -------------------------------------------------------------
for (const id of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'CC0-1.0']) {
  check(`${id} is allowed`, classifyExpression(id), 'allowed');
}

// --- copyleft and source-available -----------------------------------------
for (const id of [
  'GPL-2.0',
  'GPL-3.0',
  'GPL-3.0-or-later',
  'GPL-3.0-only',
  'AGPL-3.0',
  'AGPL-3.0-or-later',
  'LGPL-2.1',
  'LGPL-3.0-only',
  'SSPL-1.0',
  'BUSL-1.1',
]) {
  check(`${id} is denied`, classifyExpression(id), 'denied');
}

// --- undeclared -------------------------------------------------------------
check('missing licence is denied', classifyExpression(null), 'denied');
check('undefined licence is denied', classifyExpression(undefined), 'denied');
check('empty string is denied', classifyExpression(''), 'denied');
check('whitespace only is denied', classifyExpression('   '), 'denied');
check('UNLICENSED is denied', classifyExpression('UNLICENSED'), 'denied');
check('SEE LICENSE IN … is denied', classifyExpression('SEE LICENSE IN LICENSE.txt'), 'denied');

// --- expressions ------------------------------------------------------------
// OR: the consumer picks, so one permissive option is enough.
check('(MIT OR GPL-3.0) is allowed', classifyExpression('(MIT OR GPL-3.0)'), 'allowed');
check('MIT OR GPL-3.0 without parens is allowed', classifyExpression('MIT OR GPL-3.0'), 'allowed');
check('(GPL-3.0 OR AGPL-3.0) is denied', classifyExpression('(GPL-3.0 OR AGPL-3.0)'), 'denied');

// AND: every term binds, so the worst one wins. Getting this backwards would
// let a GPL term through whenever it was paired with a permissive one.
check('(MIT AND GPL-3.0) is denied', classifyExpression('(MIT AND GPL-3.0)'), 'denied');
check('(MIT AND Apache-2.0) is allowed', classifyExpression('(MIT AND Apache-2.0)'), 'allowed');
check('(MIT AND MPL-2.0) needs review', classifyExpression('(MIT AND MPL-2.0)'), 'review');

check(
  'nested ((MIT OR GPL-3.0) AND Apache-2.0) is allowed',
  classifyExpression('((MIT OR GPL-3.0) AND Apache-2.0)'),
  'allowed',
);
check(
  'nested ((GPL-3.0 AND MIT) OR Apache-2.0) is allowed',
  classifyExpression('((GPL-3.0 AND MIT) OR Apache-2.0)'),
  'allowed',
);

// --- unrecognised -----------------------------------------------------------
check('MPL-2.0 needs review', classifyExpression('MPL-2.0'), 'review');
check('CC-BY-4.0 needs review', classifyExpression('CC-BY-4.0'), 'review');
check('EPL-2.0 needs review', classifyExpression('EPL-2.0'), 'review');
// Bare "BSD" is not a valid SPDX id — which variant is unknowable, so do not guess.
check('ambiguous bare BSD needs review', classifyExpression('BSD'), 'review');
check('lowercase mit needs review, not silent acceptance', classifyExpression('mit'), 'review');

// --- malformed --------------------------------------------------------------
check('unbalanced parens need review', classifyExpression('((MIT'), 'review');
check('trailing operator needs review', classifyExpression('MIT OR'), 'review');
check('garbage needs review', classifyExpression('%%%'), 'review');
// A licence-with-exception is not the bare licence.
check(
  'Apache-2.0 WITH LLVM-exception needs review',
  classifyExpression('Apache-2.0 WITH LLVM-exception'),
  'review',
);

// GPL must not be rescued by a prefix collision.
check('GPL alone is denied', classifyId('GPL'), 'denied');
check('a name merely starting with those letters is not denied', classifyId('GPLike-1.0'), 'review');

// --- exception parsing ------------------------------------------------------
const TABLE = `
| Package | Version | Licence | Scope | Reason | Approved by | Date |
|---|---|---|---|---|---|---|
| \`caniuse-lite\` | \`*\` | \`CC-BY-4.0\` | dev | data not code | @someone | 2026-01-01 |
| \`pinned-thing\` | \`1.2.3\` | \`MPL-2.0\` | runtime | vendored | @someone | 2026-01-02 |
| \`no-reason\` | \`*\` | \`MPL-2.0\` | dev |  |  | 2026-01-03 |
`;

const { exceptions, problems } = parseExceptions(TABLE);
check('parses the well-formed rows', exceptions.length, 2);
check('rejects a row with no reason or approver', problems.length, 1);
check('skips the header row', exceptions.some((e) => e.name === 'Package'), false);

const dep = (over) => ({ name: 'caniuse-lite', version: '9.9.9', license: 'CC-BY-4.0', scope: 'development', ...over });

check('wildcard version matches', Boolean(findException(exceptions, dep())), true);
check(
  'dev in the table matches development in the inventory',
  findException(exceptions, dep())?.scope,
  'dev',
);
check(
  'a runtime-scoped dependency is NOT covered by a dev-scoped exception',
  findException(exceptions, dep({ scope: 'runtime' })),
  undefined,
);
check(
  'a different licence is not covered',
  findException(exceptions, dep({ license: 'GPL-3.0' })),
  undefined,
);
check(
  'a pinned exception does not cover another version',
  findException(exceptions, { name: 'pinned-thing', version: '2.0.0', license: 'MPL-2.0', scope: 'runtime' }),
  undefined,
);
check(
  'a pinned exception covers its own version',
  Boolean(
    findException(exceptions, { name: 'pinned-thing', version: '1.2.3', license: 'MPL-2.0', scope: 'runtime' }),
  ),
  true,
);
check(
  'an unlisted package is not covered',
  findException(exceptions, dep({ name: 'something-else' })),
  undefined,
);

// ---------------------------------------------------------------------------
// THE TWO CANNOT-CHECK EXITS (#560, D3)
//
// Both are `exit(2)` — the #281 class. This file exercised the policy
// classifier and the exceptions parser and never drove `main`, so neither
// route out of "the inventory is unusable" had a witness.
//
// `check-licenses.mjs <repoRoot>` takes its root positionally and `inventory()`
// shells out to npm BY NAME, so a fixture root plus a shadowing `npm` decides
// both outcomes without touching production code.
//
// The two are distinguished deliberately: an inventory that THREW and one that
// came back EMPTY are different facts about the world, and collapsing them is
// how "no dependencies" and "npm never ran" become the same report.
// ---------------------------------------------------------------------------
{
  const licFixture = (npm) => {
    const dir = mkdtempSync(join(tmpdir(), 'lic-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    writeFileSync(join(bin, 'npm'), npm, { mode: 0o755 });
    return { dir, bin };
  };
  const runLicenses = ({ dir, bin }) =>
    spawnSync(process.execPath, [join(here, 'check-licenses.mjs'), dir], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });

  {
    const f = licFixture('#!/bin/sh\necho "npm exploded" >&2\nexit 1\n');
    try {
      const r = runLicenses(f);
      check('licenses: an inventory that cannot be built is CANNOT CHECK', r.status, 2);
      check('licenses: ...and says so rather than reporting a clean build', /could not build the dependency inventory/.test(r.stderr), true);
      // The distinction this exit exists for: a failure to MEASURE must not
      // read as a measurement that found nothing wrong.
      check('licenses: ...and does NOT report zero violations', /0 violations/.test(r.stdout), false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }

  {
    const f = licFixture('#!/bin/sh\necho \'{"dependencies":{}}\'\nexit 0\n');
    try {
      const r = runLicenses(f);
      check('licenses: an EMPTY inventory is CANNOT CHECK, not a clean pass', r.status, 2);
      check('licenses: ...and names the missing node_modules as the likely cause', /inventory is empty/.test(r.stderr), true);
      // Told apart from the throwing case above by its own wording, so one
      // fixture cannot satisfy both assertions.
      check('licenses: ...and is NOT reported as a build failure', /could not build/.test(r.stderr), false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// THE TWO VERDICT EXITS (#560, D3)
//
// Distinct from the cannot-check pair above: these are reached when the
// inventory WAS built and the policy has an answer. Both were unwitnessed
// because nothing drove the script to a verdict — the fixture needs a real
// `node_modules/<pkg>/package.json`, since `licenseOf` reads the manifest on
// disk while `npm ls` supplies only the names.
// ---------------------------------------------------------------------------
{
  const verdictFixture = (license) => {
    const dir = mkdtempSync(join(tmpdir(), 'lic-verdict-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'badpkg'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { badpkg: '1.0.0' } }));
    writeFileSync(
      join(dir, 'node_modules', 'badpkg', 'package.json'),
      JSON.stringify({ name: 'badpkg', version: '1.0.0', license }),
    );
    writeFileSync(
      join(bin, 'npm'),
      `#!/bin/sh\necho '{"name":"fixture","dependencies":{"badpkg":{"version":"1.0.0"}}}'\nexit 0\n`,
      { mode: 0o755 },
    );
    return { dir, bin };
  };
  const runVerdict = ({ dir, bin }, ...extra) =>
    spawnSync(process.execPath, [join(here, 'check-licenses.mjs'), dir, ...extra], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });

  {
    const f = verdictFixture('GPL-3.0');
    try {
      const r = runVerdict(f);
      check('licenses: a denied licence exits 1', r.status, 1);
      check('licenses: ...and is a VERDICT, not a cannot-check', r.status === 2, false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }

  // The --json path has its OWN exit, and it is a ternary: both arms are
  // asserted, because neutralising it to a constant satisfies whichever arm is
  // left untested.
  {
    const bad = verdictFixture('GPL-3.0');
    try {
      check('licenses: --json exits 1 when there are violations', runVerdict(bad, '--json').status, 1);
    } finally {
      rmSync(bad.dir, { recursive: true, force: true });
    }
    const good = verdictFixture('MIT');
    try {
      check('licenses: --json exits 0 when there are none', runVerdict(good, '--json').status, 0);
    } finally {
      rmSync(good.dir, { recursive: true, force: true });
    }
  }
}

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
