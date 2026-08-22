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

import { classifyExpression, classifyId } from './lib/license-policy.mjs';
import { parseExceptions, findException } from './check-licenses.mjs';

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

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
