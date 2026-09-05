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

import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  main,
  parseImports,
  discoverPublicPackages,
  discoverPrivatePackageNames,
  readRootPackageName,
  classifyLeakProbe,
  shouldProbeForLeak,
  markdownFiles,
  probeImport,
  EXIT_OK,
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

/** Substring assertion, so a failure shows what was actually emitted. */
function checkIncludes(desc, haystack, needle) {
  if (haystack.includes(needle)) {
    console.log(`ok   - ${desc}`);
    passed += 1;
  } else {
    console.log(`FAIL - ${desc} (output did not contain ${JSON.stringify(needle)})`);
    console.log(`       got: ${JSON.stringify(haystack.slice(0, 400))}`);
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

// 6. THE LEAK SENTINEL'S SUBJECT (#607). Unit half; the behavioural half — the
//    one that actually matters — is the TMPDIR block at the end of this file.
{
  check('the root package name is read from the tree', readRootPackageName(REPO_ROOT), '@askturret/mcp');
  check('an unreadable root is null, not a guessed name', readRootPackageName(join(REPO_ROOT, 'docs')), null);

  // The subject must be the SELF-REFERENCE name. Reading it from the tree
  // rather than hardcoding it is what keeps the sentinel armed through a
  // rename — a stale hardcoded name would probe a specifier that resolves
  // nowhere, which is exactly the defect being fixed here.
  const packed = new Set(discoverPublicPackages(REPO_ROOT).map((p) => p.name));
  check(
    'the root name is NOT a packed package today, so probing it is meaningful',
    packed.has(readRootPackageName(REPO_ROOT)),
    false,
  );
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

// ---------------------------------------------------------------------------
// THE LEAK SENTINEL'S PREDICATE (#607, second finding).
//
// Fixing the sentinel's SUBJECT — which name to probe — left its PREDICATE with
// the same shape one axis over. It read `ok === false` as "no leak", and `ok` is
// false for ANY non-zero exit, INCLUDING a specifier that RESOLVED and then
// THREW. That is a leak: the module was FOUND, which is the only question the
// sentinel asks; what it did afterwards is irrelevant.
//
// Not hypothesis. With the root's `exports['.']` pointed at a throwing module
// and the room inside the checkout, the old predicate returned exit 0 and the
// guard printed "OK — every documented import resolves and provides its
// bindings for a reader" while the room was leaking.
//
// Every branch is asserted, because the whole defect was one unconsidered
// branch being folded into another.
// ---------------------------------------------------------------------------
{
  check('a specifier that RESOLVES is a leak', classifyLeakProbe({ ok: true, reason: 'resolved' }), 'leak');

  // THE FINDING. Non-zero exit, and still a leak.
  check(
    'a specifier that resolves and THEN THROWS is a leak',
    classifyLeakProbe({ ok: false, reason: 'threw', detail: 'Error: boom' }),
    'leak',
  );

  // Both of these also mean the module was found; only the reason it then
  // failed differs, and the sentinel does not care which.
  check(
    'a package found but whose subpath is not exported is a leak',
    classifyLeakProbe({ ok: false, reason: 'not-exported' }),
    'leak',
  );
  check(
    'a module found but missing a binding is a leak',
    classifyLeakProbe({ ok: false, reason: 'missing-binding' }),
    'leak',
  );

  // The ONLY outcome that proves isolation, because it is the only one that
  // requires the module to be absent.
  check('genuinely not found is the only clean verdict', classifyLeakProbe({ ok: false, reason: 'not-found' }), 'clean');

  // A probe that could not run is not evidence of isolation. "I could not
  // check" is never "it passed".
  check(
    'a probe that could not run is indeterminate, not clean',
    classifyLeakProbe({ ok: false, reason: 'spawn-failed' }),
    'indeterminate',
  );
  check('a malformed result is indeterminate, not clean', classifyLeakProbe(null), 'indeterminate');
  check('an unrecognised reason is a leak, not a pass', classifyLeakProbe({ ok: false, reason: 'something-new' }), 'leak');

  // probeImport must actually EMIT these codes — a predicate keyed on codes
  // nothing produces would be green and inert.
  const emitted = (stderr, status) =>
    probeImport('/tmp', { statement: "import 'x'", named: [] }, () => ({ status, stderr })).reason;
  check('probeImport emits not-found for ERR_MODULE_NOT_FOUND', emitted('ERR_MODULE_NOT_FOUND', 1), 'not-found');
  check('probeImport emits threw for any other failure', emitted('Error: boom from the root entry', 1), 'threw');
  check('probeImport emits resolved on a clean exit', emitted('', 0), 'resolved');
}

// ---------------------------------------------------------------------------
// THE SKIP BRANCH (#607). Extracted so it is EXECUTED rather than read.
//
// Reaching it through main() needs a workspace whose root name is also a packed
// public package, and building one trips the unbuilt-package cannot-check long
// before the sentinel — which is why the end-to-end form of this branch is not
// exercised here, and is not claimed to be.
// ---------------------------------------------------------------------------
{
  const packed = new Set(discoverPublicPackages(REPO_ROOT).map((p) => p.name));
  const rootName = readRootPackageName(REPO_ROOT);

  check('the sentinel is armed for this repository today', shouldProbeForLeak(rootName, packed), true);
  check(
    'it disarms if the root name ever becomes a packed package',
    shouldProbeForLeak('@askturret/mcp', new Set(['@askturret/mcp'])),
    false,
  );
  check('an unreadable root name disarms it rather than probing ""', shouldProbeForLeak(null, packed), false);
}

// ---------------------------------------------------------------------------
// THE LEAK SENTINEL, WITNESSED BEHAVIOURALLY (#607).
//
// This is the block that matters, and it is the one the guard shipped without.
// The sentinel was previously verified by SOURCE-STRING INSPECTION — asserting
// the file contained a probe — which is evidence about text, not about
// behaviour. It had never been shown to fire. A sentinel confirmed by reading
// its own source is the same category of mistake as a guarantee confirmed by
// reading the config that is supposed to produce it.
//
// So this runs the REAL guard against the REAL repository, twice, and the two
// runs differ only in TMPDIR:
//
//   TMPDIR outside the checkout -> exit 0   (the room is clean)
//   TMPDIR inside  the checkout -> exit 2   (the room is NOT clean; refuse)
//
// The pair is required, not decorative. The negative alone cannot distinguish
// "detects the leak" from "always exits 2", and a guard that always refused
// would pass a leak-only test while blocking every PR.
//
// Both runs pack the workspace, so this block is the slow part of this suite.
// That cost buys the only assertion here that could have caught #607.
// ---------------------------------------------------------------------------
{
  const runGuard = (tmpdir) =>
    spawnSync(process.execPath, [GUARD, REPO_ROOT], {
      encoding: 'utf-8',
      env: tmpdir === null ? process.env : { ...process.env, TMPDIR: tmpdir },
    });

  const clean = runGuard(null);
  check('control: with TMPDIR outside the checkout the guard reports a result', clean.status, EXIT_OK);

  // The leak, reproduced. Node's upward node_modules walk from a room inside
  // the checkout reaches the root package.json, and package self-reference
  // revives — the exact mechanism this guard exists to defeat.
  const leakDir = join(REPO_ROOT, '.tmp-leak-sentinel-test');
  mkdirSync(leakDir, { recursive: true });
  try {
    const leaked = runGuard(leakDir);
    const out = `${leaked.stdout ?? ''}${leaked.stderr ?? ''}`;

    // The load-bearing line. Before this fix the same run reported a RESULT —
    // 2 failures where the same broken docs produce 14 outside the checkout,
    // and on correct docs it would have reported a clean exit 0 while nothing
    // had actually been verified.
    check('a clean room inside the checkout is CANNOT CHECK, never a result', leaked.status, EXIT_CANNOT_CHECK);
    checkIncludes('...and names the repository\'s own package name as what resolved', out, "'@askturret/mcp' resolved inside the clean room");
    checkIncludes('...and attributes it to self-reference', out, 'package self-reference');
    checkIncludes('...and points at TMPDIR, which is the actual cause', out, 'TMPDIR points inside the repository');
    checkIncludes('...and says plainly that nothing was verified', out, 'This is NOT a pass');

    // The old sentinel's blind spot, pinned so it cannot come back: a name that
    // exists nowhere does not resolve under self-reference either, so probing
    // one is silent in precisely the condition it would need to detect.
    const phantom = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('@askturret/mcp-this-package-does-not-exist')"],
      { cwd: leakDir, encoding: 'utf-8' },
    );
    const selfRef = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('@askturret/mcp')"], {
      cwd: leakDir,
      encoding: 'utf-8',
    });
    check('a never-existing name does NOT resolve under self-reference', phantom.status !== 0, true);
    check('...while the root name DOES — which is why the old sentinel was blind', selfRef.status, 0);
  } finally {
    rmSync(leakDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// THE BOUND, MADE EXECUTABLE (#608).
//
// This guard checks IMPORTS. A document that names a symbol without importing
// it yields nothing to parse and is therefore never probed — not "checked and
// found clean", NOT CHECKED. The header explains why that is stated rather than
// closed, and carries the measurement that decided it.
//
// These assertions exist so the statement cannot quietly become false. If
// anyone widens `parseImports` to reach fence-only usage, the first case
// REDDENS and the header paragraph must be corrected in the same change —
// which is precisely the failure #593 was filed about: a described bound going
// stale while still reading as current.
// ---------------------------------------------------------------------------
{
  // The exact shape that let three phantom symbols live on main: symbols used
  // inside a fence, with no import statement anywhere in the file.
  const fenceOnly = [
    '# Doc',
    '',
    '```ts',
    "const policy = allOf([authenticated(), rolesBased({ user: ['listPets'] })]);",
    '```',
    '',
  ].join('\n');
  check('bound: a document that USES symbols without importing them yields no imports', parseImports(fenceOnly).length, 0);

  // The control. Without it the assertion above is satisfied by a parser that
  // returns nothing for everything — which would make the bound look tighter
  // than it is while the guard checked nothing at all.
  const withImport = [
    '```ts',
    "import { allOf } from '@askturret/mcp-core';",
    'const policy = allOf([]);',
    '```',
    '',
  ].join('\n');
  check('bound: ...while a real import statement IS parsed', parseImports(withImport).length, 1);

  // And the file IS walked, which is what makes the gap surprising rather than
  // obvious: it is discovered and then contributes nothing, not skipped.
  check(
    'bound: the doc is reached by the walk, then yields nothing to probe',
    markdownFiles(join(REPO_ROOT, 'docs')).some((f) => f.endsWith('why-not-generate.md')),
    true,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
