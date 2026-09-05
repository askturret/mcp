#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Every import in README.md resolves FOR A READER, not just for this repo (#598).
 *
 * ## Why this exists, and why three previous fixes did not stop it
 *
 * #41 round 2, #41 round 3 and #149 each found a broken README import. Each was
 * fixed. Each was verified with `cwd` inside this repository — where the root
 * package is named `@askturret/mcp` and declares `exports`, so every specifier
 * resolves through **package self-reference**. #149's acceptance explicitly
 * demanded "real import resolution (not just an exports-map read)" and was met
 * honestly. The resolution was real; it was real in the one place no reader
 * stands.
 *
 * That is the whole mechanism: `@askturret/mcp` returns 404 on npm, and the
 * monorepo resolved it anyway. A check that verifies the property it can see
 * (does this specifier resolve HERE) rather than the property that matters
 * (does it resolve for someone who ran `npm install`).
 *
 * So this guard does not run in the repository. It builds a CLEAN ROOM in a
 * temp directory from PACKED TARBALLS and runs each import there.
 *
 * ## What the clean room is, precisely
 *
 *   <tmp>/node_modules/@askturret/*   REAL directories, extracted from
 *                                     `npm pack` output. Nothing is symlinked
 *                                     back to the workspace, so a specifier
 *                                     that is not a published package name
 *                                     cannot resolve.
 *   <tmp>/node_modules/<third-party>  symlinked to this repo's already-installed
 *                                     copies. These are NOT under test — they
 *                                     are what lets an import execute far enough
 *                                     to prove the binding exists.
 *
 * `<tmp>` is under the OS temp dir, so node's upward node_modules walk never
 * reaches this repository. Self-reference cannot save a broken specifier here:
 * there is no package.json named `@askturret/mcp` anywhere above the probe.
 *
 * ## EXIT CODES
 *
 *   0  every parsed import resolved and provided every binding it names
 *   1  DIVERGENCE — a specifier did not resolve, or a named binding was absent
 *   2  CANNOT CHECK — the clean room could not be built (npm/tar missing, pack
 *      failed, a package is unbuilt, a third-party dependency is not installed)
 *
 * NEVER exit 0 when the clean room was not built. "I could not check" is not
 * "it passed" (#281) — and on this guard specifically, a silent pass would be
 * the fifth instance of the exact bug it exists to catch.
 *
 * MUST RUN AFTER `npm ci` AND `npm run build`: packing an unbuilt package
 * yields a tarball with no dist/, which is reported as cannot-check.
 *
 * ## THE BOUND: THIS CHECKS IMPORTS. IT DOES NOT CHECK USE-WITHOUT-IMPORT (#608)
 *
 * The unit of work is an import statement. `parseImports` finds them, and every
 * one it finds is probed in the clean room — that half is exhaustive. But a
 * document that names a symbol WITHOUT importing it contributes nothing to
 * parse, so it is never probed. THAT IS NOT A FAILURE MODE, IT IS AN INPUT
 * SHAPE THIS GUARD DOES NOT REACH, and the difference matters: a file with no
 * imports is not "checked and found clean", it is NOT CHECKED.
 *
 * Measured rather than supposed: `docs/why-not-generate.md` carried three
 * symbols no package exports — `rolesBased`, `authorizationPolicy` and
 * `fromExpress` — live on main, in a file this guard walks. `parseImports`
 * returns 0 for it, because it contains no import statements at all. They were
 * found by a human READING it, the same sub-shape as the `allOf` defect #606
 * fixed.
 *
 * ## WHY THAT IS NOT CLOSED HERE, AND THE MEASUREMENT THAT DECIDED IT
 *
 * Closing it means detecting a symbol USED but never imported, which in markdown
 * means "a bare identifier called inside a code fence that is not one of our
 * exports". That detector was BUILT AND MEASURED against this tree before this
 * note was written — 41 docs, 749 real exported bindings:
 *
 *   - it WOULD have caught all three phantoms above .......... 3 true positives
 *   - across the other docs it flags 11 identifiers of which .. 0 are real
 *
 * The false positives are not tuning noise, they are the shape of the problem.
 * `startYourFramework()` is deliberate placeholder prose; `evaluate(` and
 * `execute(` are interface METHOD declarations rather than calls. A document is
 * allowed to contain illustrative code, and no static rule separates
 * illustrative from wrong. Shipping it would mean a guard wrong 11 times in 14
 * on today's tree, blocking pull requests on pseudo-code — a third guard whose
 * stated reach exceeds its actual reach, which is #593's whole subject.
 *
 * So the bound is STATED rather than half-closed, AND ASSERTED — in
 * `check-readme-imports.test.mjs` — because a merely described bound is what
 * went stale in #593. The assertion pins that a fence-only document yields zero
 * imports; widen `parseImports` to reach these and the test REDDENS, forcing
 * this paragraph to be corrected in the same change.
 */

import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isProcessEntryPoint } from './lib/entry-point.mjs';

export const EXIT_OK = 0;
export const EXIT_DIVERGENCE = 1;
export const EXIT_CANNOT_CHECK = 2;

/**
 * Fenced languages whose contents are executable JavaScript/TypeScript.
 *
 * `javascript` and `js` are here because the Quick Demo — the first code a
 * reader meets — is fenced ```javascript. A scanner that only read ```ts would
 * skip the single most-copied block in the file while reporting full coverage.
 */
const CODE_FENCES = ['ts', 'typescript', 'js', 'javascript'];

/**
 * Named-binding imports (`import { a, b as c } from 'x'`) from code fences.
 *
 * Default and namespace imports are deliberately out of scope: `import express
 * from 'express'` names a dependency the READER owns, not one this repository
 * publishes, and asserting on it would redden this guard for someone else's
 * package. Named imports are where all four rounds of this bug have lived.
 */
export function parseImports(markdown) {
  const out = [];
  const fence = new RegExp('```(' + CODE_FENCES.join('|') + ')\\n([\\s\\S]*?)```', 'g');

  for (const block of markdown.matchAll(fence)) {
    const code = block[2] ?? '';
    for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
      const entries = (m[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      // `import { type Foo }` is valid TypeScript and ERASED at runtime, so a
      // type-only binding must not be probed as a value — doing so reports a
      // SyntaxError against documentation that is perfectly correct. Only value
      // bindings can be asserted to exist in a built package.
      const named = entries
        .filter((s) => !/^type\s/.test(s))
        .map((s) => s.split(/\s+as\s+/)[0]?.trim() ?? '')
        .filter((s) => s.length > 0);

      const specifier = m[2] ?? '';
      // With no value bindings left there is nothing to destructure, but the
      // specifier must still resolve — a type-only import from a package that
      // does not exist is still a broken instruction to a reader.
      const probeStatement =
        named.length > 0 ? `import { ${named.join(', ')} } from '${specifier}'` : `import '${specifier}'`;

      out.push({ specifier, named, statement: m[0], probeStatement });
    }
  }
  return out;
}

/**
 * Workspace packages marked `private: true`.
 *
 * These are internal — `mcp-reliability` and friends are test and example
 * suites that are deliberately never published. A contributor-facing doc may
 * legitimately import one, and no reader can `npm install` it, so probing it in
 * the clean room would report a failure against documentation that is correct
 * for its audience. Reported as a warning instead of a divergence, and computed
 * from the tree rather than allowlisted, so a package flipping to public is
 * covered the day it does.
 */
export function discoverPrivatePackageNames(repoRoot) {
  const dir = join(repoRoot, 'packages');
  if (!existsSync(dir)) return new Set();
  const names = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (manifest.private === true && typeof manifest.name === 'string') names.add(manifest.name);
    } catch {
      // Unreadable manifests are the public discovery's problem, not this one.
    }
  }
  return names;
}

/**
 * The root package's own name — the specifier package self-reference resolves.
 *
 * Read from the tree rather than hardcoded: the name IS the leak sentinel's
 * subject, and a hardcoded copy would go stale exactly when the repository is
 * renamed, silently disarming the check. Returns null if it cannot be read,
 * which the caller must treat as cannot-check rather than as "no leak".
 */
export function readRootPackageName(repoRoot) {
  try {
    const name = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).name;
    return typeof name === 'string' && name !== '' ? name : null;
  } catch {
    return null;
  }
}

/** Public workspace packages, discovered rather than hardcoded. */
export function discoverPublicPackages(repoRoot) {
  const dir = join(repoRoot, 'packages');
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue;
    }
    if (manifest.private === true) continue;
    found.push({ name: manifest.name, manifest });
  }
  return found;
}

/**
 * Build the clean room. Returns { ok, dir } or { ok: false, reason }.
 *
 * Every failure here is a CANNOT CHECK, never a pass — an unbuildable clean
 * room means nothing was verified.
 */
export function buildCleanRoom(repoRoot, run = spawnSync) {
  const packages = discoverPublicPackages(repoRoot);
  if (packages.length === 0) {
    return { ok: false, reason: 'no public packages were discovered under packages/' };
  }

  const dir = mkdtempSync(join(tmpdir(), 'readme-imports-'));
  const tarballs = join(dir, 'tarballs');
  const modules = join(dir, 'node_modules', '@askturret');
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(modules, { recursive: true });

  const packArgs = ['pack', '--silent', '--pack-destination', tarballs];
  for (const p of packages) packArgs.push('--workspace', p.name);

  const packed = run('npm', packArgs, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (!packed || packed.error) {
    const code = (packed && packed.error && (packed.error.code || packed.error.message)) || 'unknown';
    return { ok: false, dir, reason: `npm could not be started (${code})` };
  }
  if (packed.status !== 0) {
    const tail = String(packed.stderr || '').trim().split('\n').slice(-2).join(' | ');
    return { ok: false, dir, reason: `npm pack exited ${packed.status}${tail ? ` — ${tail}` : ''}` };
  }

  const files = readdirSync(tarballs).filter((f) => f.endsWith('.tgz'));
  if (files.length !== packages.length) {
    return { ok: false, dir, reason: `packed ${files.length} tarball(s) for ${packages.length} package(s)` };
  }

  // Extract each tarball into node_modules/@askturret/<short name>. Real
  // directories, not links — this is what makes the room a clean room.
  for (const p of packages) {
    const short = p.name.split('/')[1];
    const tgz = files.find((f) => f.startsWith(`askturret-${short}-`));
    if (tgz === undefined) return { ok: false, dir, reason: `no tarball found for ${p.name}` };

    const dest = join(modules, short);
    mkdirSync(dest, { recursive: true });
    const untar = run('tar', ['-xzf', join(tarballs, tgz), '-C', dest, '--strip-components=1'], { encoding: 'utf-8' });
    if (!untar || untar.error || untar.status !== 0) {
      const why = untar && untar.error ? untar.error.code || untar.error.message : `tar exited ${untar && untar.status}`;
      return { ok: false, dir, reason: `could not extract ${tgz} (${why})` };
    }
    if (!existsSync(join(dest, 'dist'))) {
      return {
        ok: false,
        dir,
        reason: `${p.name} packed with no dist/ — the package looks UNBUILT, so its tarball is not representative. Run \`npm run build\` first.`,
      };
    }
  }

  // Third-party dependencies are NOT under test; they only need to be present
  // so an import can execute. Symlinked from the repo's install, so node
  // resolves their own transitive deps from there via realpath.
  const repoModules = join(repoRoot, 'node_modules');
  const wanted = new Set();
  for (const p of packages) {
    for (const spec of [p.manifest.dependencies, p.manifest.peerDependencies]) {
      for (const name of Object.keys(spec ?? {})) {
        if (!name.startsWith('@askturret/')) wanted.add(name);
      }
    }
  }
  for (const name of wanted) {
    const src = join(repoModules, name);
    if (!existsSync(src)) {
      return { ok: false, dir, reason: `third-party dependency '${name}' is not installed in the repo — run \`npm ci\` first` };
    }
    const dest = join(dir, 'node_modules', name);
    mkdirSync(join(dest, '..'), { recursive: true });
    if (!existsSync(dest)) symlinkSync(src, dest, 'dir');
  }

  return { ok: true, dir };
}

/** Run one import statement in the clean room. */
export function probeImport(cleanRoom, parsed, run = spawnSync) {
  const statement = parsed.probeStatement ?? parsed.statement;
  const probe = [
    statement + ';',
    `const bindings = { ${parsed.named.join(', ')} };`,
    'for (const [name, value] of Object.entries(bindings)) {',
    "  if (typeof value === 'undefined') { console.error('MISSING_BINDING:' + name); process.exit(3); }",
    '}',
  ].join('\n');

  const r = run(process.execPath, ['--input-type=module', '-e', probe], { cwd: cleanRoom, encoding: 'utf-8' });
  if (!r || r.error) {
    return {
      ok: false,
      reason: 'spawn-failed',
      detail: String((r && r.error && r.error.message) || 'node could not be started'),
    };
  }
  if (r.status === 0) return { ok: true, reason: 'resolved' };

  // Surface the real reason: a specifier that does not resolve and a binding
  // that does not exist are different bugs with different fixes, and "exit 1"
  // tells the next reader neither.
  //
  // `reason` is a STABLE CODE, and callers must branch on it rather than on
  // `detail` or on `ok` (#607). `ok: false` collapses "was not found" together
  // with "was found and then threw", and for the leak sentinel below those are
  // opposite answers — the second one means the module WAS resolved, which is
  // the entire question it asks. Matching the prose instead would key a safety
  // decision on wording that a later edit is free to reword.
  const stderr = String(r.stderr || '');
  const missing = stderr.match(/MISSING_BINDING:(\w+)/);
  if (missing) return { ok: false, reason: 'missing-binding', detail: `does not provide '${missing[1]}'` };
  if (stderr.includes('ERR_MODULE_NOT_FOUND') || stderr.includes('Cannot find package')) {
    return { ok: false, reason: 'not-found', detail: `specifier does not resolve — no such package for a reader` };
  }
  if (stderr.includes('ERR_PACKAGE_PATH_NOT_EXPORTED')) {
    return { ok: false, reason: 'not-exported', detail: 'subpath is not in the package exports map' };
  }
  const line = stderr.trim().split('\n').find((l) => l.includes('Error')) ?? stderr.trim().split('\n')[0] ?? '';
  return { ok: false, reason: 'threw', detail: line.slice(0, 200) };
}

/**
 * What a leak probe's result says about the clean room (#607).
 *
 * The sentinel's SUBJECT was fixed first — probe the self-reference name rather
 * than a name that exists nowhere. This is its PREDICATE, which had the same
 * shape one axis over: it read `ok === false` as "no leak", and `ok` is false
 * for ANY non-zero exit — including a specifier that RESOLVED and then THREW.
 *
 * Resolving and throwing is a leak. The module was FOUND, which is the only
 * question this sentinel asks; what it did afterwards is irrelevant. Verified
 * rather than reasoned: with the root's `exports['.']` pointed at a throwing
 * module, the old predicate reported no leak and the guard printed
 * "OK — every documented import resolves and provides its bindings for a
 * reader" while the room was leaking.
 *
 *   'clean'          the name was genuinely NOT FOUND — the only proof of
 *                    isolation, because it is the only outcome that requires
 *                    the module to be absent
 *   'leak'           it resolved, or resolved and then failed for any reason
 *   'indeterminate'  the probe itself could not run; not evidence either way
 */
export function classifyLeakProbe(result) {
  if (!result || typeof result !== 'object') return 'indeterminate';
  if (result.reason === 'not-found') return 'clean';
  if (result.reason === 'spawn-failed') return 'indeterminate';
  return 'leak';
}

/**
 * Whether the leak sentinel applies to this repository at all.
 *
 * Separated so the SKIP branch is executable rather than only readable: reaching
 * it through `main()` needs a workspace whose root name is also a packed public
 * package, and building one trips the unbuilt-package cannot-check long before
 * the sentinel is reached.
 */
export function shouldProbeForLeak(rootName, packedNames) {
  if (typeof rootName !== 'string' || rootName === '') return false;
  return !packedNames.has(rootName);
}

/**
 * Every markdown file in the repository, excluding dependency and build output.
 *
 * Scanned across all documentation rather than README.md alone: the bug class is
 * "we documented an import and nothing checked it", and that is not a property
 * of one file. #598 was found in README.md and `docs/plugin-api.md` carried the
 * identical broken specifier, unnoticed, at the same time.
 */
export function markdownFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, found);
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

export function main(argv, run = spawnSync) {
  const repoRoot = resolve(argv[2] || '.');
  const readmePath = join(repoRoot, 'README.md');

  if (!existsSync(readmePath)) {
    console.error('\n::error::CANNOT CHECK — README.md not found; nothing was verified.');
    return EXIT_CANNOT_CHECK;
  }

  const docs = markdownFiles(repoRoot);
  const imports = docs.flatMap((file) =>
    parseImports(readFileSync(file, 'utf-8')).map((i) => ({ ...i, file: file.slice(repoRoot.length + 1) })),
  );

  // Guard the guard. A fence-format change would silently empty this list and
  // make the run vacuously green — which is how a doc check rots into decoration.
  if (imports.length === 0) {
    console.error(`\n::error::CANNOT CHECK — no named imports parsed from README.md or the other ${docs.length - 1} markdown file(s). Either the fences changed or the parser is broken; nothing was verified.`);
    return EXIT_CANNOT_CHECK;
  }

  const room = buildCleanRoom(repoRoot, run);
  if (!room.ok) {
    if (room.dir) rmSync(room.dir, { recursive: true, force: true });
    console.error(`\n⚠️  CANNOT CHECK — the clean room could not be built: ${room.reason}`);
    console.error('   This is NOT a pass. No README import was verified.');
    console.error(`\n::error::CANNOT CHECK — ${imports.length} README import(s) were not verified.`);
    return EXIT_CANNOT_CHECK;
  }

  const failures = [];
  const internal = [];
  const privateNames = discoverPrivatePackageNames(repoRoot);
  try {
    // ---- Prove the room is isolated BEFORE trusting any green from it -------
    //
    // THE LEAK SENTINEL (#607). Probes the ROOT PACKAGE'S OWN NAME, because that
    // is the specifier package self-reference resolves and a clean room must
    // not.
    //
    // The original sentinel probed `@askturret/mcp-this-package-does-not-exist`,
    // and that was the wrong question. A name that exists nowhere does not
    // resolve under self-reference EITHER, so it stayed silent in exactly the
    // condition it was there to detect — it verified an ADJACENT property (some
    // package fails to resolve) rather than the one that matters (the umbrella
    // name fails to resolve).
    //
    // Measured, not reasoned: with TMPDIR pointed inside the checkout the clean
    // room lands under the repository, node's upward node_modules walk reaches
    // the root package.json, self-reference revives, and the guard reported 2
    // failures where the same broken docs produce 14 outside it. Twelve real
    // defects invisible, under a check mark.
    //
    // Containment was only ever a property of WHERE TMPDIR happens to point —
    // a choice made elsewhere, by the environment, which this guard neither
    // makes nor previously checked. This probe is what turns that inherited
    // assumption into an assertion.
    const rootName = readRootPackageName(repoRoot);
    const packedNames = new Set(discoverPublicPackages(repoRoot).map((p) => p.name));

    if (rootName === null) {
      console.error('\n⚠️  CANNOT CHECK — the root package.json could not be read, so the clean room could not be proven isolated.');
      console.error('   This is NOT a pass. No documented import was verified.');
      return EXIT_CANNOT_CHECK;
    }

    // If the root name is itself a packed workspace package it SHOULD resolve
    // here, and probing it would be a false alarm. That is not the case today —
    // the root is not under packages/ and is never packed — but it becomes the
    // case the day an umbrella package ships, and a guard that reddens on a
    // correct change is one someone deletes.
    if (!shouldProbeForLeak(rootName, packedNames)) {
      console.log(
        `check-readme-imports: leak sentinel skipped — '${rootName}' is itself a packed public package, so it resolves here legitimately.`,
      );
    } else {
      const leak = probeImport(room.dir, {
        statement: `import '${rootName}'`,
        named: [],
      }, run);

      // Branch on the CLASSIFICATION, never on `ok`. Only "genuinely not found"
      // proves isolation; resolve-then-throw means the module was found, which
      // is a leak wearing a non-zero exit code.
      const verdict = classifyLeakProbe(leak);

      if (verdict === 'leak') {
        console.error(`\n⚠️  CANNOT CHECK — '${rootName}' resolved inside the clean room.`);
        console.error('   That is the repository\'s OWN package name. It resolves here only through');
        console.error('   package self-reference, which means the room is inside the checkout and');
        console.error('   every specifier below would resolve for a reason no reader has.');
        if (!leak.ok) {
          console.error(`   It then failed (${leak.detail}) — but FINDING it is the leak; what it did next is not the question.`);
        }
        console.error(`   Most likely cause: TMPDIR points inside the repository (TMPDIR=${process.env.TMPDIR ?? '<unset>'}).`);
        console.error('   This is NOT a pass. No documented import was verified.');
        return EXIT_CANNOT_CHECK;
      }

      if (verdict === 'indeterminate') {
        console.error(`\n⚠️  CANNOT CHECK — the leak sentinel could not run: ${leak.detail}`);
        console.error('   Isolation was therefore never established, and an unproven room is not a clean one.');
        console.error('   This is NOT a pass. No documented import was verified.');
        return EXIT_CANNOT_CHECK;
      }
    }

    for (const parsed of imports) {
      if (privateNames.has(parsed.specifier)) {
        internal.push(`${parsed.file}: ${parsed.specifier} is a private workspace package — no reader can install it`);
        continue;
      }
      const r = probeImport(room.dir, parsed, run);
      if (!r.ok) failures.push(`${parsed.file}: ${parsed.specifier} — ${r.detail}\n      in: ${parsed.statement}`);
    }
  } finally {
    rmSync(room.dir, { recursive: true, force: true });
  }

  console.log(
    `check-readme-imports: probed ${imports.length - internal.length} of ${imports.length} documented import(s) from ${docs.length} markdown file(s) against packed tarballs in a clean temp directory; ` +
      `${failures.length} failure(s), ${internal.length} skipped as internal.`,
  );

  // Printed even on success: an unprobed import is not a verified one, and a
  // count that only appears on failure is a count nobody reads.
  if (internal.length > 0) {
    console.log('\n   Not probed — private workspace packages, documented for contributors:');
    for (const i of internal) console.log(`     ${i}`);
  }

  if (failures.length > 0) {
    console.error('\n❌ DOCUMENTED IMPORT — this is what a reader gets after `npm install`:');
    for (const f of failures) console.error(`   ${f}`);
    console.error('\n   These resolve inside this repository via package self-reference and');
    console.error('   fail for everyone else. That difference is the whole of #598.');
    console.error(`\n::error::${failures.length} documented import(s) do not work outside this repository.`);
    return EXIT_DIVERGENCE;
  }

  console.log('check-readme-imports: OK — every documented import resolves and provides its bindings for a reader.');
  return EXIT_OK;
}

if (isProcessEntryPoint(import.meta.url)) {
  process.exit(main(process.argv));
}
