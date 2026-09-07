#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Scripts that run in a job with no `npm ci` import only Node builtins (#743).
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 *
 * Some jobs run `.github/scripts` code with NO install step — a checkout, a
 * `setup-node`, and a `node` invocation. In those jobs `node_modules` does not
 * exist, so a single bare import turns the script into a crash on a line that
 * looks fine in review.
 *
 * That property was documented as a COUNT. PR #742 declared `js-yaml` as a
 * devDependency and defended the trade by inventorying which scripts must stay
 * dependency-free — an inventory that said "exactly one family" and said it in
 * four places (the script header, the `test.yml` comment, the PR body, and the
 * commit message). There were five at the time of writing and six by the end of
 * the same day: a nightly job added two hours later made `ci-throughput-metric`
 * the sixth, and no copy of the number moved.
 *
 * The number was never the point. What matters is the PROPERTY, and this guard
 * asserts it directly instead of asking a reader to keep a tally accurate in
 * four files:
 *
 *   1. DERIVE, from the workflow files, every `.github/scripts` entry point
 *      invoked by a job that does not install.
 *   2. Follow each entry point's relative imports transitively.
 *   3. Require every specifier reached to be a Node builtin or a relative path.
 *
 * Nothing here is hand-maintained. Adding an install-less job extends the
 * inventory automatically; adding a dependency to a script already in it fails
 * on the next PR.
 *
 * ---------------------------------------------------------------------------
 * WHY A COUNT IN PROSE WAS THE WRONG INSTRUMENT
 * ---------------------------------------------------------------------------
 *
 * The count is guidance, and guidance is consulted by whoever happens to read
 * it. Someone reading "exactly one family" and adding a dependency to
 * `check-path-filters.mjs` would break `lane-check.yml` — a workflow that fires
 * only on `labeled` events, so the breakage surfaces LATE and attributed to
 * whatever was being labelled at the time, not to the change that caused it.
 * `check-path-filters.mjs` is also what verifies the `ci:cheap` claim against
 * the diff, which the sequential-PR capacity gate rests on.
 *
 * This guard runs in `test.yml`'s `test-integrity` job, on every PR, and names
 * the offending script and the job that would have broken. That is the same
 * failure, moved from "some future labelled PR" to "the PR that caused it".
 *
 * ---------------------------------------------------------------------------
 * THIS GUARD TAKES THE DEPENDENCY IT FORBIDS, AND THAT IS NOT A CONTRADICTION
 * ---------------------------------------------------------------------------
 *
 * It imports `js-yaml`, because deriving the job graph needs a real parser and
 * a hand-rolled one is lenient exactly where YAML is strict (#698). It runs in
 * `test-integrity`, which installs before any guard runs — so it is not in its
 * own install-less set and does not flag itself.
 *
 * If it were ever wired into an install-less job it WOULD flag itself, by the
 * ordinary operation of the rule. That is the intended behaviour, not a hole.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CLAIMS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * It claims: every module reachable by RELATIVE import from a script named in
 * an install-less `run:` block imports only `node:` builtins and relative
 * paths.
 *
 * It does NOT claim:
 *
 *   - that a script works. Resolvable imports are necessary, not sufficient.
 *   - anything about SHELL scripts. `dco.yml` runs `.github/scripts/*.sh` in
 *     two install-less jobs; those depend on `git` and `bash`, not on
 *     `node_modules`, so they are a different question and are out of scope
 *     rather than silently counted as passing.
 *   - completeness of DISCOVERY beyond literal mentions. A script named in a
 *     `run:` block is found; one invoked through a variable, or by another
 *     script it shells out to, is not. Discovery is deliberately literal
 *     because the alternative is a resolver that guesses.
 *
 * The literal scan errs toward INCLUDING scripts (a mention inside a comment or
 * heredoc still counts). Over-inclusion costs a false failure that names its
 * own cause; under-inclusion would be a silent pass.
 *
 * ---------------------------------------------------------------------------
 * CANNOT-CHECK IS EXIT 2 AND IS NEVER A PASS
 * ---------------------------------------------------------------------------
 *
 * A missing parser, an unreadable workflow directory, a workflow that does not
 * parse, or a `run:` block naming a script that is not on disk all exit 2. Each
 * one means the inventory could not be derived, and an underived inventory is
 * empty — which would otherwise pass loudly and vacuously, having checked
 * nothing. Same discipline as check-workflows-parse.mjs and check-runners.mjs.
 *
 * Run: node .github/scripts/check-install-less-deps.mjs [repoRoot]
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { builtinModules } from 'node:module';

export const EXIT_OK = 0;
export const EXIT_FORBIDDEN_DEPENDENCY = 1;
export const EXIT_CANNOT_CHECK = 2;

/** GitHub loads `.yml` and `.yaml` from `.github/workflows` and nothing else. */
const WORKFLOW_EXTENSIONS = ['.yml', '.yaml'];

/**
 * Any step that populates `node_modules` makes a job install-full.
 *
 * Broad on purpose: the question is whether dependencies are present, not which
 * package manager put them there. A job this misreads as installing is a script
 * this guard stops checking, so the pattern covers the alternatives rather than
 * assuming npm.
 */
const INSTALL_PATTERN = /\b(?:npm\s+(?:ci|install|i)|pnpm\s+(?:install|i)|yarn\s+(?:install)?)\b/;

/** A `.github/scripts` JavaScript file named literally in a `run:` block. */
const SCRIPT_PATTERN = /\.github\/scripts\/([A-Za-z0-9._/-]+\.(?:mjs|cjs|js))\b/g;

/** Node builtins, with and without the `node:` prefix. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/**
 * The workflow files GitHub would attempt to load, sorted for stable output.
 *
 * Non-recursive: GitHub does not load workflows from subdirectories.
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
 * Null rather than a throw so the caller can turn a missing parser into an
 * explicit CANNOT CHECK instead of a crash a reader could mistake for a
 * finding.
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
 * Every module specifier `source` imports, however it spells the import.
 *
 * Covers static `import`/`export ... from`, dynamic `import()` and `require()`.
 * Bare-word dynamic forms (`import(someVariable)`) are not resolvable by
 * reading and are skipped — see the discovery bound in the header.
 */
export function importSpecifiers(source) {
  const specs = [];
  const patterns = [
    /\b(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) specs.push(match[1]);
  }
  return [...new Set(specs)];
}

/** True when a specifier names a Node builtin. */
export function isBuiltin(spec) {
  return BUILTINS.has(spec) || spec.startsWith('node:');
}

/** True when a specifier is a relative path this guard should follow. */
export function isRelative(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

/**
 * The jobs in one parsed workflow that run `.github/scripts` JavaScript without
 * installing first.
 *
 * A job's steps are the unit of analysis: `node_modules` does not survive
 * between jobs, so an install in one job says nothing about another.
 */
export function installLessJobsIn(doc, workflowName) {
  const found = [];
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const runText = steps.map((s) => (typeof s?.run === 'string' ? s.run : '')).join('\n');
    if (INSTALL_PATTERN.test(runText)) continue;

    const scripts = [...new Set([...runText.matchAll(SCRIPT_PATTERN)].map((m) => m[1]))];
    if (scripts.length > 0) found.push({ workflow: workflowName, job: jobId, scripts: scripts.sort() });
  }
  return found;
}

/**
 * Walk relative imports from `entryPath`, collecting forbidden specifiers.
 *
 * Returns `{ violations, missing, visited }`. A relative import that does not
 * exist on disk is `missing` — a cannot-check, not a pass: an unreadable module
 * is one whose imports were never examined.
 */
export function walkImports(entryPath, scriptsRoot) {
  const violations = [];
  const missing = [];
  const visited = new Set();
  const queue = [entryPath];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    if (!existsSync(current)) {
      missing.push(current);
      continue;
    }

    let source;
    try {
      source = readFileSync(current, 'utf8');
    } catch (err) {
      missing.push(`${current} (${err.message})`);
      continue;
    }

    for (const spec of importSpecifiers(source)) {
      if (isBuiltin(spec)) continue;
      if (isRelative(spec)) {
        queue.push(resolve(dirname(current), spec));
        continue;
      }
      violations.push({ file: relative(scriptsRoot, current) || current, spec });
    }
  }

  return { violations, missing, visited };
}

export async function main(argv) {
  const root = resolve(argv[2] ?? '.');
  const workflowDir = join(root, '.github', 'workflows');

  if (!existsSync(workflowDir)) {
    console.error(`::error::CANNOT CHECK — no .github/workflows directory under ${root}.`);
    console.error('  The install-less inventory is DERIVED from the workflows. With none to');
    console.error('  read the inventory is empty, and an empty inventory passes vacuously.');
    console.error('  Nothing was verified. This is NOT a pass.');
    return EXIT_CANNOT_CHECK;
  }

  const files = workflowFiles(workflowDir);
  if (files.length === 0) {
    console.error('::error::CANNOT CHECK — .github/workflows contains no .yml/.yaml files.');
    console.error('  Nothing was verified. This is NOT a pass.');
    return EXIT_CANNOT_CHECK;
  }

  const yaml = await loadParser();
  if (yaml === null) {
    console.error('::error::CANNOT CHECK — the YAML parser (js-yaml) could not be loaded.');
    console.error('  Run `npm ci` first. js-yaml is a declared devDependency of the root package.');
    console.error('  Nothing was verified. This is NOT a pass.');
    return EXIT_CANNOT_CHECK;
  }

  const inventory = [];
  for (const name of files) {
    let doc;
    try {
      doc = yaml.load(readFileSync(join(workflowDir, name), 'utf8'));
    } catch (err) {
      console.error(`::error::CANNOT CHECK — .github/workflows/${name} does not parse: ${err.reason ?? err.message}`);
      console.error('  A workflow that does not parse cannot contribute its jobs to the');
      console.error('  inventory, so the derived set would be silently incomplete.');
      console.error('  check-workflows-parse.mjs reports this failure in its own right.');
      return EXIT_CANNOT_CHECK;
    }
    inventory.push(...installLessJobsIn(doc, name));
  }

  const scriptsRoot = join(root, '.github', 'scripts');
  const violations = [];
  const missing = [];
  const checked = new Set();

  for (const entry of inventory) {
    for (const script of entry.scripts) {
      const entryPath = join(root, '.github', 'scripts', script.replace(/^.*\.github\/scripts\//, ''));
      const walked = walkImports(entryPath, scriptsRoot);
      for (const v of walked.violations) violations.push({ ...v, job: `${entry.workflow}::${entry.job}` });
      for (const m of walked.missing) missing.push({ path: m, job: `${entry.workflow}::${entry.job}` });
      for (const f of walked.visited) checked.add(f);
    }
  }

  // The derived inventory is printed on every run, pass or fail. It is the
  // replacement for the hand-maintained count — a reader who wants the number
  // reads it out of CI, where it cannot be stale.
  console.log('check-install-less-deps: jobs running .github/scripts JavaScript with no install:');
  for (const entry of inventory) {
    console.log(`   ${entry.workflow}::${entry.job} -> ${entry.scripts.join(', ')}`);
  }
  console.log('');

  if (missing.length > 0) {
    console.error('::error::CANNOT CHECK — a script named by an install-less job is not on disk:');
    for (const m of missing) console.error(`   ${m.job}: ${m.path}`);
    console.error('  Its imports were never examined, so nothing can be concluded about them.');
    console.error('  Nothing was verified. This is NOT a pass.');
    return EXIT_CANNOT_CHECK;
  }

  if (violations.length > 0) {
    console.error('❌ A script that runs WITHOUT `npm ci` imports something that will not be installed:');
    for (const v of violations) {
      console.error(`   ${v.file} imports '${v.spec}'  (reached from ${v.job})`);
    }
    console.error('');
    console.error('   `node_modules` does not exist in that job, so this is a crash at runtime,');
    console.error('   not a resolution warning. Either keep the script to Node builtins, or add');
    console.error('   an install step to the job that runs it and accept the cost there.');
    console.error('');
    console.error(`::error::${violations.length} forbidden import(s) in install-less scripts.`);
    return EXIT_FORBIDDEN_DEPENDENCY;
  }

  console.log(
    `check-install-less-deps: OK — ${inventory.length} install-less job(s), ` +
      `${checked.size} module(s) reachable from them, all importing only Node builtins. ` +
      'Shell scripts and non-literal invocations are out of scope — see the header.',
  );
  return EXIT_OK;
}

// Runs UNCONDITIONALLY, and the self-test spawns this file rather than
// importing it. The idiomatic `import.meta.url === \`file://${process.argv[1]}\``
// entry guard is wrong in a way that fails SILENTLY: argv[1] may be relative
// and import.meta.url is percent-encoded, so on a checkout whose path contains
// a space the comparison is always false, main() never runs, and the process
// exits 0 having checked nothing. That was observed on this repository, and is
// documented at the foot of check-workflows-parse.mjs.
process.exit(await main(process.argv));
