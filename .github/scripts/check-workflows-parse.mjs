#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Every workflow file is loadable YAML (#698).
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 *
 * On PR #697, `.github/workflows/reliability-nightly.yml:133` shipped as:
 *
 *   run: echo "Integrated tree under test: $GITHUB_SHA"
 *
 * A plain (unquoted) YAML scalar cannot contain `: ` — colon-space. A real
 * loader stops at the colon after `test` and tries to open a nested mapping:
 *
 *   fca8746   js-yaml: "bad indentation of a mapping entry (133:46)"
 *
 * GITHUB DOES NOT LOAD AN INVALID WORKFLOW FILE AT ALL. It does not run a
 * partial file and it does not report a failing check — the jobs simply never
 * exist. That same PR removed `push: main` from `test.yml` and moved the
 * integrated-tree assertion INTO this file, so on merge the protection would
 * have been removed, its replacement would never have run, the pre-existing
 * `reliability` job in the same file would have stopped as collateral, and the
 * board would have been green throughout.
 *
 * Two checks read that file and passed it. `check-runners.mjs` walks the
 * directory with a HAND-ROLLED parser; `check-guards.test.mjs` greps the text.
 * Neither asks whether the file is loadable at all, and a hand-rolled parser
 * cannot: it is lenient exactly where YAML is strict, so it will keep passing
 * files the real loader rejects. That is not a bug in those checks — it is the
 * wrong instrument for this question, which is why this is a separate guard
 * rather than an edit to either.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT TAKES A DEPENDENCY, AND WHAT THAT COSTS
 * ---------------------------------------------------------------------------
 *
 * `.github/scripts` is deliberately zero-dependency. `check-runners.mjs` states
 * the reason: it "uses only Node builtins, so it needs no install to be
 * trustworthy — same reasoning as the readiness-matrix gate." THIS SCRIPT
 * BREAKS THAT PROPERTY, on purpose, and the trade is argued here rather than
 * made silently.
 *
 * What the property protects is a script that must run in a job with NO
 * `npm ci`. Exactly one family does: `check-readiness-matrix.mjs` and its
 * self-test, invoked by `supply-chain.yml`'s `readiness` job and by
 * `tag-readiness-advisory.yml`, whose own comment reads "No `npm ci`: the
 * script and its self-test use only Node builtins". THOSE ARE UNTOUCHED and
 * must stay that way.
 *
 * This guard runs in `test.yml`'s `test-integrity` job, which does `npm ci`
 * before any guard runs — the same job, and after the same install, as
 * `check-runners.mjs` itself. So the dependency costs nothing operationally
 * where it is used, and the install-less contract is preserved where it is
 * load-bearing.
 *
 * The alternative was writing another hand-rolled parser, which is the precise
 * instrument the observed failure defeated. A parser that is lenient where YAML
 * is strict cannot answer "would a strict loader reject this?" — so a
 * zero-dependency version of this guard would be a guard that cannot fail on
 * the input it exists to catch.
 *
 * `js-yaml` was already resolvable in this tree, but was an UNDECLARED
 * transitive hoist — so a dependency bump could remove it without any manifest
 * changing. #698's own text says "js-yaml is already available"; that was true
 * and load-bearing on something nothing declared. It is now a direct
 * devDependency pinned at 4.3.1, which is one line of manifest and one line of
 * lockfile, and turns an accident into a stated fact.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARD CLAIMS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * It claims exactly one thing: THIS FILE IS PARSEABLE YAML AND ITS DOCUMENT IS
 * A MAPPING.
 *
 * It does NOT claim GitHub will load the file. Schema validity, `${{ }}`
 * expression syntax, job-graph rules (`needs:` naming a job that exists),
 * action references and permission names are all beyond a YAML parser and are
 * NOT checked here. A file can pass this guard and still be rejected by GitHub.
 *
 * Parsing is NECESSARY, NOT SUFFICIENT — and it is worth having precisely
 * because the observed failure was in the necessary half, where a cheap check
 * is decisive. Do not let a green here be read as "GitHub accepts this"; the
 * post-merge complement is `GET /repos/{owner}/{repo}/actions/workflows`
 * showing `state: active`, which asks the system that actually loads the file
 * but can only speak about `main`'s registered copy — which is why it cannot
 * be this pre-merge gate.
 *
 * ---------------------------------------------------------------------------
 * CANNOT-CHECK IS EXIT 2 AND IS NEVER A PASS
 * ---------------------------------------------------------------------------
 *
 * If the parser cannot be loaded, if the workflow directory is missing, or if
 * it contains no workflow files, this exits 2 rather than 0. A guard that
 * silently passes when it could not look is indistinguishable in a CI log from
 * one that looked and found nothing — and "could not check" is never "passed",
 * the same discipline check-runners.mjs, check-path-filters.mjs and
 * check-audit-append-only.mjs already follow.
 *
 * That is also what keeps the dependency honest: if `js-yaml` ever stops
 * resolving, this goes RED and names the reason. It cannot degrade into a
 * green that checked nothing.
 *
 * ALL offenders are reported in one pass, so a directory with three broken
 * files does not cost three CI runs.
 *
 * Run: node .github/scripts/check-workflows-parse.mjs [repoRoot]
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const EXIT_OK = 0;
export const EXIT_UNPARSEABLE = 1;
export const EXIT_CANNOT_CHECK = 2;

/** GitHub loads `.yml` and `.yaml` from `.github/workflows` and nothing else. */
const WORKFLOW_EXTENSIONS = ['.yml', '.yaml'];

/**
 * The workflow files GitHub would attempt to load, sorted for stable output.
 *
 * Non-recursive on purpose: GitHub does not load workflows from subdirectories,
 * so recursing would report files that cannot fail in production.
 */
export function workflowFiles(dir) {
  return readdirSync(dir)
    .filter((name) => WORKFLOW_EXTENSIONS.some((ext) => name.endsWith(ext)))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
}

/**
 * The YAML parser, or `null` when it cannot be loaded.
 *
 * Returning null rather than throwing is what lets the caller turn a missing
 * parser into an explicit CANNOT CHECK instead of an unhandled crash that a
 * reader could mistake for an ordinary failure.
 */
export async function loadParser() {
  try {
    const mod = await import('js-yaml');
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/**
 * Where a YAMLException happened, as `line:column`, both 1-based.
 *
 * js-yaml marks are 0-based; a parse error without a location is not
 * actionable, so the conversion is done here rather than left to the reader.
 */
function locationOf(error) {
  const mark = error?.mark;
  if (!mark || typeof mark.line !== 'number') return null;
  return `${mark.line + 1}:${mark.column + 1}`;
}

export async function main(argv) {
  const root = resolve(argv[2] ?? '.');
  const dir = join(root, '.github', 'workflows');

  if (!existsSync(dir)) {
    console.error(`::error::CANNOT CHECK — no .github/workflows directory under ${root}.`);
    console.error('  Nothing was verified. This is NOT a pass.');
    return EXIT_CANNOT_CHECK;
  }

  const files = workflowFiles(dir);
  if (files.length === 0) {
    console.error(`::error::CANNOT CHECK — .github/workflows contains no .yml/.yaml files.`);
    console.error('  A repository with no workflow files is more likely a broken checkout than');
    console.error('  a deliberate state, so this reports rather than passing vacuously.');
    return EXIT_CANNOT_CHECK;
  }

  const yaml = await loadParser();
  if (yaml === null) {
    console.error('::error::CANNOT CHECK — the YAML parser (js-yaml) could not be loaded.');
    console.error('  This guard needs a REAL parser: a hand-rolled one is lenient exactly where');
    console.error('  YAML is strict, which is how the #698 failure passed two existing checks.');
    console.error('  Run `npm ci` first. js-yaml is a declared devDependency of the root package.');
    console.error('  Nothing was verified. This is NOT a pass.');
    return EXIT_CANNOT_CHECK;
  }

  const failures = [];
  for (const name of files) {
    const path = join(dir, name);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      failures.push({ name, where: null, reason: `could not be read: ${err.message}` });
      continue;
    }

    let doc;
    try {
      doc = yaml.load(text);
    } catch (err) {
      failures.push({ name, where: locationOf(err), reason: err.reason ?? err.message });
      continue;
    }

    // A file that parses to null (empty or comments-only) or to a scalar/array
    // is still not a workflow GitHub can load. This stays a parse-level claim —
    // it asserts the SHAPE of the document, not the schema inside it.
    if (doc === null || doc === undefined) {
      failures.push({ name, where: null, reason: 'parses to an empty document — no workflow to load' });
    } else if (typeof doc !== 'object' || Array.isArray(doc)) {
      failures.push({
        name,
        where: null,
        reason: `parses to a ${Array.isArray(doc) ? 'sequence' : typeof doc}, not a mapping`,
      });
    }
  }

  if (failures.length > 0) {
    console.error('');
    console.error('❌ UNLOADABLE WORKFLOW FILE — GitHub does not load an invalid workflow at all:');
    for (const f of failures) {
      console.error(`   .github/workflows/${f.name}${f.where ? `:${f.where}` : ''}: ${f.reason}`);
    }
    console.error('');
    console.error('   The jobs in an unloadable file do not run and do not report a failure —');
    console.error('   they simply never exist, so the board stays green while the protection');
    console.error('   is gone. A common cause is `: ` (colon-space) inside an unquoted scalar;');
    console.error('   quote the string or use a block scalar.');
    console.error('');
    console.error(`::error::${failures.length} workflow file(s) could not be parsed.`);
    return EXIT_UNPARSEABLE;
  }

  console.log(
    `check-workflows-parse: OK — ${files.length} workflow file(s) parse as YAML mappings. ` +
      'This does NOT assert GitHub accepts them: schema, expression syntax and job-graph ' +
      'rules are out of scope.',
  );
  return EXIT_OK;
}

// Runs UNCONDITIONALLY, like check-runners.mjs. There is deliberately no
// "am I the entry point?" guard here.
//
// The idiomatic form — `import.meta.url === \`file://${process.argv[1]}\`` —
// is WRONG in a way that fails silently: argv[1] may be relative, and
// import.meta.url is percent-encoded and symlink-resolved, so a path
// containing a space produces `file:///…/Application%20Support/…` on one side
// and `file://…/Application Support/…` on the other. The comparison is false,
// main() never runs, and the process EXITS 0 HAVING CHECKED NOTHING.
//
// That was observed here, not reasoned about: the first version of this file
// printed no output and exited 0 against the real repository. A guard for
// "checks that cannot fail" that itself cannot fail would be a poor joke, so
// the failure mode is removed rather than corrected — the self-test spawns
// this script as a child process and never imports it, so nothing needs the
// guard. The same shape is documented in packages/gateway/src/cli.ts, where
// the two normalisations are required and "both fail SILENTLY when missed".
process.exit(await main(process.argv));
