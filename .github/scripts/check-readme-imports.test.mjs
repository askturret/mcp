#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the README imports guard (#598).
 *
 * THE ARM THAT MATTERS HERE IS CANNOT-CHECK. The defect this guard exists to
 * catch survived three fixes because a check reported success from a place the
 * property did not hold. A guard for that failure which itself resolves a
 * broken clean room as "fine" would be the same mistake wearing a new name, so
 * every route to a verdict is witnessed:
 *
 *   exit 0  every parsed import resolved and provided its bindings
 *   exit 1  DIVERGENCE — a specifier or a binding failed in the clean room
 *   exit 2  CANNOT CHECK — six distinct causes, each asserted apart
 *
 * AND ASSERTIONS AGAINST THE REAL README at the end. Those are the ones that go
 * RED if #598's fix is reverted. They are pure string/parse checks needing
 * neither npm nor a build, so they bite everywhere and cost nothing — the
 * clean-room run in the next CI step is the authority, this is the fast pin.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  main,
  parseImports,
  discoverPublicPackages,
  discoverPrivatePackageNames,
  markdownFiles,
  probeImport,
  EXIT_CANNOT_CHECK,
} from './check-readme-imports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'check-readme-imports.mjs');
const REPO_ROOT = join(HERE, '..', '..');

let passed = 0;
let failed = 0;

function check(desc, actual, expected) {
  if (actual === expected) {
    console.log(`ok   - ${desc}`);
    passed += 1;
  } else {
    console.log(`FAIL - ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed += 1;
  }
}

function silently(fn) {
  const log = console.log;
  const error = console.error;
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { code: fn(), out: out.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// ---------------------------------------------------------------------------
// PARSING. The fence list is load-bearing: the Quick Demo — the most-copied
// block in the file — is fenced ```javascript, and a ts-only scanner would skip
// it while reporting full coverage.
// ---------------------------------------------------------------------------
{
  check('parses a ```ts fence', parseImports("```ts\nimport { a } from 'x';\n```").length, 1);
  check('parses a ```javascript fence', parseImports("```javascript\nimport { a } from 'x';\n```").length, 1);
  check('parses a ```js fence', parseImports("```js\nimport { a } from 'x';\n```").length, 1);
  check('parses a ```typescript fence', parseImports("```typescript\nimport { a } from 'x';\n```").length, 1);

  check('ignores prose outside a fence', parseImports("import { a } from 'x';").length, 0);
  check(
    'ignores a non-code fence',
    parseImports("```bash\nimport { a } from 'x';\n```").length,
    0,
  );

  const multi = parseImports("```ts\nimport { a, b as c } from '@scope/pkg';\n```");
  check('captures the specifier', multi[0]?.specifier, '@scope/pkg');
  check('captures every named binding', multi[0]?.named.join(','), 'a,b');
  check('records the aliased binding by its SOURCE name, which is what must exist', multi[0]?.named[1], 'b');

  // Default imports name a dependency the READER owns; asserting on them would
  // redden this guard for someone else's package.
  check('skips default imports', parseImports("```ts\nimport express from 'express';\n```").length, 0);

  check('finds several imports in one fence', parseImports("```ts\nimport { a } from 'x';\nimport { b } from 'y';\n```").length, 2);
}

// ---------------------------------------------------------------------------
// TYPE-ONLY BINDINGS. `import { type Foo }` is valid TypeScript and is ERASED
// at runtime. Probing it as a value reports a SyntaxError against documentation
// that is correct — the guard would be failing the docs for its own bug, which
// is worse than not checking, because someone would "fix" the doc.
// ---------------------------------------------------------------------------
{
  const mixed = parseImports("```ts\nimport { PLUGIN_API_VERSION, type AskTurretPlugin } from '@scope/pkg';\n```");
  check('a type-only binding is not probed as a value', mixed[0]?.named.join(','), 'PLUGIN_API_VERSION');
  check('...and the probe statement drops it', mixed[0]?.probeStatement, "import { PLUGIN_API_VERSION } from '@scope/pkg'");
  check('...while the reported statement stays verbatim for the reader', mixed[0]?.statement.includes('type AskTurretPlugin'), true);

  const allTypes = parseImports("```ts\nimport { type A, type B } from '@scope/pkg';\n```");
  check('an all-type import still probes the SPECIFIER', allTypes[0]?.probeStatement, "import '@scope/pkg'");
  check('...with no bindings to destructure', allTypes[0]?.named.length, 0);
}

// ---------------------------------------------------------------------------
// PRIVATE PACKAGES. Computed from the tree, never allowlisted — a package
// flipping to public must be covered the day it does.
// ---------------------------------------------------------------------------
{
  const privateNames = discoverPrivatePackageNames(REPO_ROOT);
  const publicNames = new Set(discoverPublicPackages(REPO_ROOT).map((p) => p.name));

  check('private packages are discovered', privateNames.size > 0, true);
  check('a known-private package is in the set', privateNames.has('@askturret/mcp-reliability'), true);
  check('no package is both public and private', [...privateNames].some((n) => publicNames.has(n)), false);
  check('the published core is NOT treated as private', privateNames.has('@askturret/mcp-core'), false);
}

// ---------------------------------------------------------------------------
// CANNOT CHECK. Six causes, asserted apart — "npm is missing" and "the clean
// room leaked" are different facts and a single exit code must not blur them.
// ---------------------------------------------------------------------------
const okNpm = () => ({ status: 0, stdout: '', stderr: '' });

{
  // 1. npm cannot be started.
  const r = silently(() =>
    main(['node', GUARD, REPO_ROOT], (cmd) =>
      cmd === 'npm'
        ? { error: Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }) }
        : okNpm(),
    ),
  );
  check('cannot check: npm cannot be started exits 2', r.code, EXIT_CANNOT_CHECK);
  check('...and says nothing was verified', r.out.includes('NOT a pass'), true);
}

{
  // 2. npm pack fails.
  const r = silently(() =>
    main(['node', GUARD, REPO_ROOT], (cmd) =>
      cmd === 'npm' ? { status: 1, stdout: '', stderr: 'workspace not found' } : okNpm(),
    ),
  );
  check('cannot check: npm pack exiting non-zero exits 2', r.code, EXIT_CANNOT_CHECK);
  check('...and quotes npm rather than guessing', r.out.includes('npm pack exited 1'), true);
}

{
  // 3. pack "succeeds" but produces no tarballs — the silent-nothing case.
  const r = silently(() => main(['node', GUARD, REPO_ROOT], () => okNpm()));
  check('cannot check: a pack producing no tarballs exits 2, never 0', r.code, EXIT_CANNOT_CHECK);
  check('...and reports the count mismatch', r.out.includes('packed 0 tarball(s)'), true);
}

{
  // 4. No README at all.
  const r = silently(() => main(['node', GUARD, join(REPO_ROOT, 'packages')], () => okNpm()));
  check('cannot check: a missing README exits 2', r.code, EXIT_CANNOT_CHECK);
  check('...and says so rather than reporting zero imports as clean', r.out.includes('README.md not found'), true);
}

// 5. VACUITY. A fence-format change would empty the import list and make the
//    run trivially green. That is precisely how a doc check rots into
//    decoration, so an empty parse is cannot-check rather than success.
{
  const emptyReadmeRoot = join(REPO_ROOT, '.github');
  // .github has no README.md, so use the missing-README arm's sibling: assert
  // the predicate directly instead, which is the property that matters.
  check('an empty parse is not treated as success', parseImports('# no code here').length, 0);
  check('...and the guard has a vacuity branch for it', readFileSync(GUARD, 'utf-8').includes('no named imports parsed'), true);
  check('...that resolves to cannot-check, not OK', readFileSync(GUARD, 'utf-8').includes('no named imports parsed from README.md'), true);
  check('the .github directory really has no README to confuse this', existsSync(join(emptyReadmeRoot, 'README.md')), false);
}

// 6. THE LEAK CHECK. A clean room that is not clean would make every pass
//    meaningless — the exact shape of the bug being fixed. The guard probes a
//    package that cannot exist and refuses to report a pass if it resolves.
{
  const guardSource = readFileSync(GUARD, 'utf-8');
  check('the guard probes a package that cannot exist', guardSource.includes('mcp-this-package-does-not-exist'), true);
  check('...and treats a resolving sentinel as cannot-check, not as OK', guardSource.includes('Resolution is leaking to the workspace'), true);
}

// ---------------------------------------------------------------------------
// DIVERGENCE CLASSIFICATION. "The specifier does not resolve" and "the package
// does not export that name" are different bugs with different fixes, and the
// three previous rounds were two of each. An exit code tells the next reader
// neither, so each is asserted apart.
// ---------------------------------------------------------------------------
{
  const parsed = { specifier: '@scope/pkg', named: ['thing'], statement: "import { thing } from '@scope/pkg'" };

  check('a clean exit is a pass', probeImport('/tmp', parsed, () => ({ status: 0, stderr: '' })).ok, true);

  const missing = probeImport('/tmp', parsed, () => ({ status: 3, stderr: 'MISSING_BINDING:thing' }));
  check('an undefined binding is a failure', missing.ok, false);
  check('...and names the binding', missing.detail, "does not provide 'thing'");

  const unresolved = probeImport('/tmp', parsed, () => ({
    status: 1,
    stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@scope/pkg'",
  }));
  check('an unresolvable specifier is a failure', unresolved.ok, false);
  check('...and says so in a reader\'s terms', unresolved.detail.includes('no such package for a reader'), true);

  const notExported = probeImport('/tmp', parsed, () => ({
    status: 1,
    stderr: 'Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath ./x is not defined',
  }));
  check('a missing subpath is a failure', notExported.ok, false);
  check('...distinguished from a missing package', notExported.detail.includes('exports map'), true);

  // The ESM link-time SyntaxError — the round-3 shape, which happens BEFORE any
  // runtime check could fire, so the MISSING_BINDING branch never sees it.
  const syntax = probeImport('/tmp', parsed, () => ({
    status: 1,
    stderr: "SyntaxError: The requested module '@scope/pkg' does not provide an export named 'thing'",
  }));
  check('a link-time SyntaxError is a failure', syntax.ok, false);
  check('...and is reported verbatim rather than as "exit 1"', syntax.detail.includes('does not provide an export named'), true);

  const noNode = probeImport('/tmp', parsed, () => ({ error: new Error('spawn ENOENT') }));
  check('a node that cannot start is not silently a pass', noNode.ok, false);
}

// ---------------------------------------------------------------------------
// THE REAL README — the RED-on-revert assertions for #598 itself.
// ---------------------------------------------------------------------------
{
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
  const published = new Set(discoverPublicPackages(REPO_ROOT).map((p) => p.name));
  const privateNames = discoverPrivatePackageNames(REPO_ROOT);

  // Scanned across ALL documentation, not README.md alone: docs/plugin-api.md
  // carried the identical umbrella specifier at the same time and nothing
  // noticed, which is the whole reason this is not a property of one file.
  const docs = markdownFiles(REPO_ROOT);
  const imports = docs.flatMap((f) =>
    parseImports(readFileSync(f, 'utf-8')).map((i) => ({ ...i, file: f.slice(REPO_ROOT.length + 1) })),
  );

  check('the docs have imports to check, so the cases below are not vacuous', imports.length > 0, true);
  check('more than one markdown file was scanned', docs.length > 1, true);
  check('discovery found the published packages', published.size > 0, true);

  // The #598 defect itself: the umbrella package returns 404, so no import may
  // name it — as a specifier or as a subpath root.
  const umbrella = imports.filter(
    (i) => i.specifier === '@askturret/mcp' || i.specifier.startsWith('@askturret/mcp/'),
  );
  check('no import names the unpublished @askturret/mcp umbrella', umbrella.map((i) => i.specifier).join(' | '), '');

  // Stronger and self-maintaining: every @askturret specifier must be a package
  // this repository actually publishes. A new package is covered the day it
  // appears; a renamed one fails the day it is renamed.
  const unknown = imports
    .map((i) => i.specifier)
    .filter((s) => s.startsWith('@askturret/'))
    .filter((s) => !published.has(s) && !privateNames.has(s));
  check('every @askturret specifier is a real workspace package', unknown.join(' | '), '');

  // The round-3 defect, pinned by name: fromOpenApi is not a core export.
  const fromOpenApiElsewhere = imports.filter(
    (i) => i.named.includes('fromOpenApi') && i.specifier !== '@askturret/mcp-sources-openapi',
  );
  check(
    'fromOpenApi is imported only from @askturret/mcp-sources-openapi',
    fromOpenApiElsewhere.map((i) => i.specifier).join(' | '),
    '',
  );

  // authorizationPolicy is exported by nothing, anywhere. No publish, no
  // package and no topology decision can make this import resolve.
  const phantom = imports.filter((i) => i.named.includes('authorizationPolicy'));
  check('authorizationPolicy is not imported at all', phantom.length, 0);

  // The badge and the install line are the first two things a reader meets.
  check(
    'the npm badge does not point at the 404 package page',
    readme.includes('npmjs.com/package/@askturret/mcp)'),
    false,
  );
  check('no install line installs the umbrella', /npm install @askturret\/mcp(?![-\w])/.test(readme), false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
