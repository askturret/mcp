#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The label-dependence registry guard (#565).
 *
 * #565 asks for the label-dependent checks to be ENUMERATED and made
 * deterministic or self-declaring. An enumeration in an issue comment or a PR
 * description is neither: nothing reads it, so it is stale the moment the
 * population changes and nobody finds out.
 *
 * So the enumeration is a committed artifact — `.github/label-dependent-checks.json`
 * — and this guard compares it against the tree in two directions. THE TWO ARE
 * NOT THE SAME STRENGTH. This comment used to say only "BOTH directions",
 * which reads as though they were (#602):
 *
 *   REGISTRY -> TREE   EXHAUSTIVE over the registry. Every entry is checked:
 *                      its file must exist, must still branch on a label, and
 *                      must contain the label it names. Nothing declared here
 *                      escapes.
 *
 *   TREE -> REGISTRY   BEST-EFFORT. It fails on the undeclared sites it finds,
 *                      and is SILENT on the ones it does not. Finding is
 *                      bounded by where it looks and by the shapes it
 *                      recognises.
 *
 * THE SECOND BOUND IS `scanTree` AND THE TWO PREDICATES BELOW — NOT THIS
 * PARAGRAPH. Read them: they are the only accurate statement of reach, and
 * they can be widened without anyone editing this text. As they stand today
 * they are regex matches over the TOP LEVEL of two directories, so a
 * label-dependent site in a subdirectory, in a file type not scanned, or
 * written in a shape the patterns do not recognise is not found. #593 is the
 * issue that widens them, and it enumerates the known blind spots.
 *
 * WHAT THAT MEANS FOR YOU, PRACTICALLY: adding an entry here IS checked.
 * FAILING to add one may not be.
 *
 * THE FIRST DIRECTION IS THE ONE THAT DECAYS, and it is the whole reason this
 * exists rather than a comment. Before it, `check-path-filters.mjs` asserted in
 * prose that lane-check.yml "will refuse it" and the self-test asserted only
 * that the STRING appeared. Deleting lane-check.yml, or typoing `ci:cheap`
 * inside it, left the suite green while the promise became false. Prose
 * asserting external state with nothing noticing when it diverges is exactly
 * the class #535 was filed about — reproduced, in the fix for #565.
 *
 * WHY A LABEL-DEPENDENCE REGISTRY AT ALL
 *
 * A PR is CREATED by one API call and LABELLED by a separate one, so the
 * `opened` run is dispatched before the label exists — measured on PR #555,
 * where the first run was created at 16:10:42Z and `ci:cheap` was applied at
 * 16:10:43Z. Every label-dependent check therefore inherits a sampling rule
 * nobody chose: it is exercised only on PRs pushed to at least twice. The
 * registry makes the population visible, and each entry must say how it copes.
 *
 * EXIT CODES
 *   0  the registry and the tree agree
 *   1  DIVERGENCE — undeclared site, or a declared entry that no longer holds
 *   2  CANNOT CHECK — the registry or the directories could not be read
 *
 * Never exit 0 when the comparison did not happen (#281).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REGISTRY_REL = '.github/label-dependent-checks.json';

export const EXIT_OK = 0;
export const EXIT_DIVERGENCE = 1;
export const EXIT_CANNOT_CHECK = 2;

/**
 * Does this workflow branch on a pull-request label?
 *
 * Three shapes, and all three are real label-dependence:
 *   - `github.event.label` .................. the label that triggered the event
 *   - `github.event.pull_request.labels` .... the PR's current label set
 *   - `types: [labeled]` / `[unlabeled]` .... triggered BY labelling
 */
export function workflowIsLabelDependent(text) {
  if (/github\.event\.label\b/.test(text)) return true;
  if (/github\.event\.pull_request\.labels/.test(text)) return true;
  if (/types:\s*\[[^\]]*\b(?:un)?labeled\b/.test(text)) return true;
  return false;
}

/**
 * Does this script branch on a pull-request label?
 *
 * Keyed on BEHAVIOUR rather than on a quoted string: the file must both read
 * the event payload and access `labels`. Matching a literal like
 * `pull_request.labels` would key on prose — several of this repo's occurrences
 * of that string are inside error messages — and would break the moment a
 * message was reworded, which is not a behaviour change.
 */
export function scriptIsLabelDependent(text) {
  // The env READ, not the bare name. Keying on the name alone made this guard
  // flag ITSELF on the first run — its own detection patterns contain the
  // string — which is a false positive worth keeping in mind rather than
  // exempting away: an exemption list is a place to hide a real dependence,
  // and a tighter predicate is not.
  const readsPayload = /process\.env\[['"]GITHUB_EVENT_PATH['"]\]|process\.env\.GITHUB_EVENT_PATH/.test(text);
  return readsPayload && /\.labels\b/.test(text);
}

/**
 * The file with comment lines removed, for the label-presence check only.
 *
 * WHY: the first version asserted `text.includes(label)` against the whole
 * file, and a measured mutation walked straight through it — typoing the gate
 * to `ci:chepa` left `ci:cheap` mentioned a dozen times in the surrounding
 * COMMENTS, so the check passed while the gate could never fire again. Matching
 * prose instead of behaviour is the exact defect this guard exists to catch,
 * one level down.
 *
 * A line-level strip is a heuristic, not a parser — it can only ever make this
 * check STRICTER than matching the raw text, never looser, so a false negative
 * here degrades to the behaviour it replaced rather than to a silent pass.
 */
export function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('#') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

/** Every label-dependent site in the tree, as repo-relative paths. */
export function scanTree(repoRoot) {
  const found = [];
  const problems = [];

  const workflowsDir = join(repoRoot, '.github', 'workflows');
  const scriptsDir = join(repoRoot, '.github', 'scripts');

  for (const [dir, rel, predicate, filter] of [
    [workflowsDir, '.github/workflows', workflowIsLabelDependent, (f) => /\.ya?ml$/.test(f)],
    // Self-tests are excluded: they FIXTURE label payloads to exercise the
    // guards, which is not the same as branching on a real one. Including them
    // would make every entry's own test look like a second dependent check.
    [scriptsDir, '.github/scripts', scriptIsLabelDependent, (f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')],
  ]) {
    let entries;
    try {
      entries = readdirSync(dir).filter(filter).sort();
    } catch (err) {
      problems.push(`cannot read ${rel} (${err?.message ?? err})`);
      continue;
    }
    if (entries.length === 0) problems.push(`${rel} contains no files to scan`);

    for (const name of entries) {
      let text;
      try {
        text = readFileSync(join(dir, name), 'utf-8');
      } catch (err) {
        problems.push(`cannot read ${rel}/${name} (${err?.message ?? err})`);
        continue;
      }
      if (predicate(text)) found.push(`${rel}/${name}`);
    }
  }

  return { found, problems };
}

const REQUIRED_FIELDS = ['id', 'kind', 'path', 'label', 'behaviour', 'sampling'];

export function main(argv) {
  const repoRoot = argv[2] ?? '.';
  const registryPath = join(repoRoot, REGISTRY_REL);

  if (!existsSync(registryPath)) {
    console.error(`check-label-dependence: CANNOT CHECK — ${REGISTRY_REL} does not exist, so nothing could be compared.`);
    return EXIT_CANNOT_CHECK;
  }

  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch (err) {
    console.error(`check-label-dependence: CANNOT CHECK — ${REGISTRY_REL} is not valid JSON (${err?.message ?? err}).`);
    return EXIT_CANNOT_CHECK;
  }

  if (!Array.isArray(registry?.checks)) {
    console.error(`check-label-dependence: CANNOT CHECK — ${REGISTRY_REL} has no \`checks\` array.`);
    return EXIT_CANNOT_CHECK;
  }

  const { found, problems } = scanTree(repoRoot);
  if (problems.length > 0) {
    console.error('check-label-dependence: CANNOT CHECK — the tree could not be scanned:');
    for (const p of problems) console.error(`   ${p}`);
    console.error('   Nothing was compared. This is NOT a pass.');
    return EXIT_CANNOT_CHECK;
  }

  const violations = [];
  const declared = new Set();

  for (const [i, entry] of registry.checks.entries()) {
    const missing = REQUIRED_FIELDS.filter((f) => typeof entry?.[f] !== 'string' || entry[f].trim() === '');
    if (missing.length > 0) {
      violations.push(`entry ${i} is missing required field(s): ${missing.join(', ')}`);
      continue;
    }
    if (declared.has(entry.path)) violations.push(`${entry.path} is declared twice`);
    declared.add(entry.path);

    // DIRECTION 2 — the one that decays.
    const abs = join(repoRoot, entry.path);
    if (!existsSync(abs)) {
      violations.push(
        `${entry.path} is declared label-dependent but DOES NOT EXIST. If it was deleted, remove its entry ` +
          'here — and check whether anything still promises that it runs.',
      );
      continue;
    }
    const text = readFileSync(abs, 'utf-8');
    const stillDependent = entry.path.endsWith('.mjs') ? scriptIsLabelDependent(text) : workflowIsLabelDependent(text);
    if (!stillDependent) {
      violations.push(
        `${entry.path} is declared label-dependent but no longer branches on a label. Either it changed and ` +
          'this entry is stale, or the detection missed it — both need a human.',
      );
    }
    if (!stripComments(text).includes(entry.label)) {
      violations.push(
        `${entry.path} is declared to depend on '${entry.label}', which does not appear in the file. ` +
          'A typo here is invisible: the check simply never fires.',
      );
    }
  }

  // DIRECTION 1 — a new label-dependent check appearing undeclared.
  for (const path of found) {
    if (!declared.has(path)) {
      violations.push(
        `${path} branches on a pull-request label but is NOT declared in ${REGISTRY_REL}. Every ` +
          'label-dependent check inherits the label-blind sampling rule (#565); declare it and say how it copes.',
      );
    }
  }

  if (violations.length > 0) {
    console.error('check-label-dependence: FAIL\n');
    for (const v of [...new Set(violations)].sort()) console.error(`  - ${v}`);
    console.error(`\n${violations.length} problem(s).`);
    return EXIT_DIVERGENCE;
  }

  console.log(
    `check-label-dependence: OK — ${registry.checks.length} declared label-dependent check(s), ` +
      `${found.length} found in the tree, and they agree.`,
  );
  return EXIT_OK;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exit(main(process.argv));
}
