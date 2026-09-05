#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for the version-literal registry guard (#601).
 *
 * BOTH DIRECTIONS ARE WITNESSED, and they are not the same strength — which is
 * the thing this file has to make executable rather than describe:
 *
 *   registry -> tree   EXHAUSTIVE. A stale entry, a literal that disagrees with
 *                      its declared canonical source, an unreadable source, a
 *                      duplicate, an ambiguous match — each asserted apart.
 *   tree -> registry   BEST-EFFORT. An undeclared literal fails; the shapes it
 *                      CANNOT see are pinned below as `false` assertions.
 *
 * READ THE BOUND CASES AS SPECIFICATIONS OF A KNOWN GAP, NOT AS DESIRED
 * BEHAVIOUR. Each says "this version literal is invisible to discovery". Widen
 * the pattern to catch one and the matching assertion REDDENS, which forces the
 * guard's header and the registry note to be corrected in the same change. A
 * described bound is what went stale in #593; an asserted one cannot.
 *
 * AND ASSERTIONS AGAINST THE REAL REGISTRY at the end, because a guard that is
 * only ever run against fixtures is one whose real subject nobody checked.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  main,
  discoverLiterals,
  resolveCanonical,
  normaliseSource,
  REGISTRY_REL,
  EXIT_OK,
  EXIT_DIVERGENCE,
  EXIT_CANNOT_CHECK,
} from './check-version-literals.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'check-version-literals.mjs');
const REPO_ROOT = join(HERE, '..', '..');

let passed = 0;
let failed = 0;
const tmpDirs = [];

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

/** A throwaway repo: one package with a source file and a manifest, plus a registry. */
function fixture({ version = '1.2.3', source = "export const VERSION = '1.2.3';", literals, extraFiles = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'version-literals-'));
  tmpDirs.push(dir);
  const src = join(dir, 'packages', 'pkg', 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(dir, 'packages', 'pkg', 'package.json'), JSON.stringify({ name: 'pkg', version }, null, 2));
  writeFileSync(join(src, 'index.ts'), `${source}\n`);
  for (const [rel, body] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  if (literals !== undefined) {
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'version-literals.json'), JSON.stringify({ literals }, null, 2));
  }
  return dir;
}

const entry = (over = {}) => ({
  id: 'pkg:VERSION',
  path: 'packages/pkg/src/index.ts',
  source: "export const VERSION = '1.2.3';",
  mirrors: 'packages/pkg/package.json#version',
  reason: 'declared for the test',
  ...over,
});

const run = (dir) => silently(() => main(['node', GUARD, dir]));

// ---------------------------------------------------------------------------
// THE AGREEING BASELINE. Without it every failure below is consistent with a
// guard that simply always fails.
// ---------------------------------------------------------------------------
{
  const r = run(fixture({ literals: [entry()] }));
  check('registry and tree agree -> exit 0', r.code, EXIT_OK);
  check('...and says how many it compared against a canonical source', r.out.includes('1 compared'), true);
}

// ---------------------------------------------------------------------------
// REGISTRY -> TREE. The exhaustive direction, and the one that decays.
// ---------------------------------------------------------------------------
{
  // THE DEFECT ITSELF: the literal disagrees with the manifest it declares.
  const r = run(fixture({ version: '0.1.2', literals: [entry()] }));
  check('a literal that disagrees with its declared source -> exit 1', r.code, EXIT_DIVERGENCE);
  check("...and names both values", r.out.includes("carries '1.2.3'") && r.out.includes("is '0.1.2'"), true);

  // A stale entry: the line changed, so the declaration now describes nothing.
  const stale = run(fixture({ source: "export const VERSION = '1.2.3'; // moved", literals: [entry()] }));
  check('an entry whose source line no longer exists -> exit 1', stale.code, EXIT_DIVERGENCE);
  check('...and says the entry may be stale', stale.out.includes('this entry is stale'), true);

  // A canonical source that cannot be read is NOT silently skipped.
  const badRef = run(fixture({ literals: [entry({ mirrors: 'packages/pkg/package.json#nope' })] }));
  check('an unreadable canonical source -> exit 1', badRef.code, EXIT_DIVERGENCE);
  check('...and says which reference failed', badRef.out.includes("has no string 'nope'"), true);

  // Missing fields: an entry that cannot say what it mirrors is not a declaration.
  const thin = run(fixture({ literals: [{ id: 'x', path: 'packages/pkg/src/index.ts' }] }));
  check('an entry missing required fields -> exit 1', thin.code, EXIT_DIVERGENCE);
  check('...and names the missing fields', thin.out.includes('missing required field(s)'), true);

  // Two entries for one line: refused rather than deduplicated.
  const dupe = run(fixture({ literals: [entry(), entry({ id: 'pkg:VERSION-again' })] }));
  check('the same source line declared twice -> exit 1', dupe.code, EXIT_DIVERGENCE);
  check('...and says so', dupe.out.includes('declared twice'), true);
}

// ---------------------------------------------------------------------------
// TREE -> REGISTRY. Best-effort, and the direction that catches a NEW literal.
// ---------------------------------------------------------------------------
{
  // The #601 case: a literal nobody declared. This is what would have caught
  // `transports/http/index.ts:662`, which was on nobody's list.
  const undeclared = run(
    fixture({
      source: "export const VERSION = '1.2.3';\nexport const OTHER = '9.9.9';",
      literals: [entry()],
    }),
  );
  check('an UNDECLARED version literal -> exit 1', undeclared.code, EXIT_DIVERGENCE);
  check('...and names the line', undeclared.out.includes("export const OTHER = '9.9.9';"), true);
  check('...and asks what it mirrors', undeclared.out.includes('Declare what it mirrors'), true);
}

// ---------------------------------------------------------------------------
// THE STRUCTURAL EXCLUSION (#601 acceptance 3).
//
// `mirrors: none` means NO comparison is performed — not a comparison that
// happens to pass. The distinction is the whole reason plugin/kit apiVersions
// are safe here: there is no path by which the guard could measure one against
// a package manifest, so the exclusion cannot be lost by an edit that changes
// which manifest a package has.
// ---------------------------------------------------------------------------
{
  // The literal is 1.0.0 while the manifest is 9.9.9. Under any derive-from-
  // package.json design this would fail. It must pass.
  const r = run(
    fixture({
      version: '9.9.9',
      source: "export const PLUGIN_API_VERSION = '1.0.0';",
      literals: [
        entry({
          id: 'pkg:PLUGIN_API_VERSION',
          source: "export const PLUGIN_API_VERSION = '1.0.0';",
          mirrors: 'none',
          reason: 'plugin API version, moves independently of the package version',
        }),
      ],
    }),
  );
  check('a `none` entry is NOT compared to any manifest, however far apart they are', r.code, EXIT_OK);
  check('...and the run reports zero comparisons for it', r.out.includes('0 compared'), true);

  // And the entry is still CHECKED — `none` suppresses the comparison, not the
  // decay check. Without this, `none` would be a way to hide a literal.
  const stale = run(
    fixture({
      version: '9.9.9',
      source: "export const PLUGIN_API_VERSION = '2.0.0';",
      literals: [
        entry({
          id: 'pkg:PLUGIN_API_VERSION',
          source: "export const PLUGIN_API_VERSION = '1.0.0';",
          mirrors: 'none',
          reason: 'plugin API version',
        }),
      ],
    }),
  );
  check('a `none` entry still reddens when its source line goes stale', stale.code, EXIT_DIVERGENCE);
}

// ---------------------------------------------------------------------------
// CANNOT CHECK. Never exit 0 when the comparison did not happen (#281).
// ---------------------------------------------------------------------------
{
  const noRegistry = run(fixture({}));
  check('a missing registry is CANNOT CHECK, never a pass', noRegistry.code, EXIT_CANNOT_CHECK);

  const dir = fixture({ literals: [entry()] });
  writeFileSync(join(dir, '.github', 'version-literals.json'), '{ not json');
  check('an unparseable registry is CANNOT CHECK', run(dir).code, EXIT_CANNOT_CHECK);

  const dir2 = fixture({ literals: [entry()] });
  writeFileSync(join(dir2, '.github', 'version-literals.json'), JSON.stringify({ nope: [] }));
  check('a registry with no `literals` array is CANNOT CHECK', run(dir2).code, EXIT_CANNOT_CHECK);
}

// ---------------------------------------------------------------------------
// THE BOUND OF DISCOVERY, MADE EXECUTABLE (#601 acceptance 5).
//
// These are the shapes `discoverLiterals` cannot see. They are asserted as
// MISSED so the limit is a measurement rather than a sentence in a header — and
// so that widening the pattern reddens here first.
// ---------------------------------------------------------------------------
{
  const seen = (source) => {
    const dir = fixture({ source });
    return discoverLiterals(dir).found.length;
  };

  // The control: the shape it CAN see. Without this every `0` below is
  // satisfied by a discovery pass that finds nothing at all.
  check('bound control: a quoted three-component version IS found', seen("export const V = '1.2.3';"), 1);

  check('bound: a version built by concatenation is NOT found', seen("export const V = '1.' + '2.3';"), 0);
  check('bound: a template-string version is NOT found', seen('export const V = `1.2.${patch}`;'), 0);
  check('bound: a two-component version is NOT found', seen("export const V = '1.2';"), 0);
  // MEASURED, and it corrected my own assumption: I expected the pattern to
  // match the `1.2.3` prefix and drop the suffix. It does not match AT ALL —
  // the closing quote must follow the third component. So a prerelease or
  // build-suffixed version is invisible, which is a cleaner limit than a
  // truncating one, and it is asserted here rather than believed.
  check('bound: a prerelease version is NOT found at all', seen("export const V = '1.2.3-rc.1';"), 0);
  check('bound: a build-suffixed version is NOT found either', seen("export const V = '1.2.3+build.5';"), 0);
  check(
    'bound: a version re-exported from elsewhere is NOT found',
    seen("import { V } from './other.js';\nexport { V };"),
    0,
  );

  // Scope, not shape: a file type and a location the walk does not reach.
  {
    const dir = fixture({ source: 'export const NOTHING = 1;', extraFiles: { 'packages/pkg/src/thing.js': "export const V = '4.5.6';\n" } });
    check('bound: a .js file is NOT scanned', discoverLiterals(dir).found.length, 0);
  }
  {
    const dir = fixture({ source: 'export const NOTHING = 1;', extraFiles: { 'scripts/tool.ts': "export const V = '4.5.6';\n" } });
    check('bound: a .ts file outside packages/<pkg>/src is NOT scanned', discoverLiterals(dir).found.length, 0);
  }
  {
    const dir = fixture({ source: 'export const NOTHING = 1;', extraFiles: { 'packages/pkg/src/__tests__/x.ts': "const V = '4.5.6';\n" } });
    check('bound: a __tests__ directory is NOT scanned', discoverLiterals(dir).found.length, 0);
  }
  {
    const dir = fixture({ source: 'export const NOTHING = 1;', extraFiles: { 'packages/pkg/src/x.test.ts': "const V = '4.5.6';\n" } });
    check('bound: a .test.ts file is NOT scanned', discoverLiterals(dir).found.length, 0);
  }
}

// ---------------------------------------------------------------------------
// resolveCanonical — never returns a bare undefined, because an unresolvable
// reference comparing equal to an absent literal reports agreement between two
// nothings.
// ---------------------------------------------------------------------------
{
  const dir = fixture({ version: '3.2.1' });
  check('resolves a manifest field', resolveCanonical(dir, 'packages/pkg/package.json#version').value, '3.2.1');
  check('a reference with no # is an error', resolveCanonical(dir, 'packages/pkg/package.json').error !== undefined, true);
  check('a missing file is an error', resolveCanonical(dir, 'nope.json#version').error !== undefined, true);
  check('a missing field is an error', resolveCanonical(dir, 'packages/pkg/package.json#nope').error !== undefined, true);
  check(
    'a failed resolution never returns a value',
    'value' in resolveCanonical(dir, 'packages/pkg/package.json#nope'),
    false,
  );
}

check('normaliseSource collapses whitespace', normaliseSource('   a    b  '), 'a b');

// ---------------------------------------------------------------------------
// THE REAL REGISTRY. These are the assertions that bite on the actual tree.
// ---------------------------------------------------------------------------
{
  const real = JSON.parse(readFileSync(join(REPO_ROOT, REGISTRY_REL), 'utf-8'));
  const ids = real.literals.map((l) => l.id);

  check('the real registry declares every literal the tree carries', discoverLiterals(REPO_ROOT).found.length, real.literals.length);
  check('every real entry has a unique id', new Set(ids).size, ids.length);
  check('every real entry states a reason', real.literals.every((l) => typeof l.reason === 'string' && l.reason.length > 20), true);

  // The four package-version literals, named — this is the list the issue was
  // scoped from PLUS the one that was missing from it.
  for (const id of ['core:VERSION', 'gateway:GATEWAY_VERSION', 'cli:inspect-server-version', 'transports:http-server-version']) {
    check(`the real registry declares ${id} against a manifest`, real.literals.find((l) => l.id === id)?.mirrors?.includes('package.json#version'), true);
  }

  // THE ONE THAT WAS ON NOBODY'S LIST. Named explicitly so that if the entry is
  // ever removed, the removal is deliberate rather than a reversion to the
  // enumeration this issue was scoped from.
  check(
    'transports/http/index.ts — absent from the original enumeration — is declared',
    real.literals.some((l) => l.path === 'packages/transports/src/http/index.ts'),
    true,
  );

  // The plugin/kit literals declare NO manifest. If one of these ever gains a
  // `package.json#version` mirror, a published compatibility guarantee breaks.
  for (const id of [
    'core:PLUGIN_API_VERSION',
    'core:plugin-doc-example-version',
    'observability:OTEL_EXPORTER_PLUGIN_VERSION',
    'adapter-test:KIT_VERSION',
    'adapter-conformance:client-info-version',
  ]) {
    check(`${id} mirrors NO manifest`, real.literals.find((l) => l.id === id)?.mirrors, 'none');
  }

  // The guard against the real tree.
  check('the real tree passes its own guard', run(REPO_ROOT).code, EXIT_OK);
}

// ---------------------------------------------------------------------------
// THE REAL ENTRY POINT, in a subprocess. An injected `main` cannot witness
// `process.exit(main(process.argv))`, and that line is what CI depends on.
// ---------------------------------------------------------------------------
{
  const r = spawnSync(process.execPath, [GUARD, REPO_ROOT], { encoding: 'utf-8' });
  check('the guard exits 0 through its real entry point', r.status, EXIT_OK);
  check('...and says what it compared', /\d+ declared literal\(s\)/.test(`${r.stdout}${r.stderr}`), true);
}

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
