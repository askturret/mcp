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
 * THE TREE -> REGISTRY BOUND IS `scanTree` AND THE TWO PREDICATES BELOW — NOT
 * THIS PARAGRAPH. Read them: they are the only accurate statement of reach, and
 * they can be widened without anyone editing this text. As they stand today
 * they are pattern matches over the TOP LEVEL of two directories, so a
 * label-dependent site in a subdirectory, in a file type not scanned, or
 * written in a shape the patterns do not recognise is not found.
 *
 * THE KNOWN BLIND SPOTS, MEASURED (#593). QA enumerated these by IMPORTING the
 * predicates rather than reasoning about them; each is now pinned as an
 * executable assertion in the self-test, so this list cannot quietly go stale
 * and a future widening REDDENS the test that says it is missed:
 *
 *   CLOSED by #593:
 *     - `types:` in YAML BLOCK-SEQUENCE style (the ordinary idiom, previously
 *       invisible — only the flow style `types: [labeled]` was seen)
 *     - `labels` reached by BRACKET notation, `payload.pull_request["labels"]`
 *
 *   STILL NOT DETECTED, and accepted as such rather than half-closed:
 *     - `gh pr view --json labels` — a label read through a subprocess
 *     - octokit `listLabelsOnIssue` — a label read through the API
 *     - labels arriving in an arbitrary environment variable
 *     - a DESTRUCTURED payload read, `const { GITHUB_EVENT_PATH } = process.env`
 *     - files that are not `.mjs` / `.yml`, and any subdirectory of the two
 *       scanned directories
 *     - A SECOND label-dependent site inside an ALREADY-DECLARED file
 *
 * WHY THOSE ARE ACCEPTED RATHER THAN CHASED. The first three are a different
 * KIND of problem: the label arrives at runtime through a channel no static
 * reading of this file can see, so detecting them means detecting "a subprocess
 * or an HTTP call might return labels", which is not decidable here. The
 * destructured read is deliberately left alone for a reason already written
 * into `scriptIsLabelDependent`: keying on the bare identifier made this guard
 * flag ITSELF, and re-widening to catch destructuring reintroduces exactly that
 * false positive.
 *
 * THE ALREADY-DECLARED-FILE CASE deserves its own note, because it is the
 * cheapest to hit and the tempting fix is worse than the gap. A declared path
 * is skipped by the TREE -> REGISTRY loop, so a SECOND dependency added to it —
 * on a different label — is invisible. The obvious close is to record a site
 * COUNT per entry and compare. That is rejected: a hand-maintained count that
 * every edit must remember to update is the tally trap this repository keeps
 * removing (#599's `23 on the approved pool`, #541's `honoured` counter), and
 * it would go stale in the same silent way while reading as though it were
 * verified. Counting sites soundly needs the parse this file deliberately does
 * not do, so the gap is STATED and asserted instead.
 *
 * WHAT THAT MEANS FOR YOU, PRACTICALLY: adding an entry here IS checked.
 * FAILING to add one may not be.
 *
 * REGISTRY -> TREE IS THE ONE THAT DECAYS, and it is the whole reason this
 * guard exists rather than a comment. Before this guard, `check-path-filters.mjs`
 * asserted in prose that lane-check.yml "will refuse it" and the self-test
 * asserted only that the STRING appeared. Deleting lane-check.yml, or typoing
 * `ci:cheap` inside it, left the suite green while the promise became false.
 * Prose asserting external state with nothing noticing when it diverges is
 * exactly the class #535 was filed about — reproduced, in the fix for #565.
 *
 * NAMED, NEVER NUMBERED — and that is a correction to this very comment (#602).
 * An earlier revision of it said "THE FIRST DIRECTION", which was accurate only
 * for the order the two happened to be listed in. Reordering the list above
 * silently inverted it against `// REGISTRY -> TREE` below and against the
 * self-test, and nothing could notice: an ordinal expires when the DOCUMENT
 * changes rather than when the world does, which is a tally in a costume. Name
 * the direction and it cannot invert.
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
import { isProcessEntryPoint } from './lib/entry-point.mjs';

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
  // BLOCK-SEQUENCE `types:` (#593). The flow-style test above sees
  // `types: [labeled]` and nothing else, so the ordinary YAML idiom
  //
  //   types:
  //     - labeled
  //
  // was invisible — a workflow triggered BY labelling that the label-dependence
  // guard could not see. Measured as MISSED against the real predicate before
  // this was added.
  if (typesBlockSequenceIncludesLabeled(text)) return true;
  return false;
}

/**
 * `types:` as a YAML block sequence, containing `labeled` or `unlabeled`.
 *
 * A LINE SCAN, NOT A PARSER — deliberately, and the distinction is the whole of
 * what this can claim. It walks from a bare `types:` through the `- item` lines
 * that follow and stops at the first line that is not one. It therefore knows
 * nothing about anchors, multi-document files, flow mappings, or a `types:` key
 * nested somewhere that does not mean what it looks like.
 *
 * It is chosen over a real YAML parse because direction B is a HEURISTIC by
 * construction (see the header), and a parser here would buy exactness for the
 * two syntaxes while leaving every non-syntactic miss — `gh --json labels`,
 * octokit, labels arriving through an environment variable — exactly where it
 * is. Trading "regex that under-covers" for "parser that under-covers" while
 * gaining the word "parse" is the kind of claim this issue exists to stop.
 */
export function typesBlockSequenceIncludesLabeled(text) {
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*types:\s*$/.test(lines[i])) continue;

    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*-\s*(?:un)?labeled\s*$/.test(lines[j])) return true;
      // Another sequence item — keep walking. `labeled` is frequently not first.
      if (/^\s*-\s*[A-Za-z_][\w-]*\s*$/.test(lines[j])) continue;
      // Anything else ends the sequence. A blank line does too: continuing past
      // it would let an unrelated later list satisfy an earlier `types:`.
      break;
    }
  }
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
  // Dot AND bracket access (#593). `p.pull_request["labels"]` is the same read
  // written the other way, and it was MISSED — measured, not assumed. Accepting
  // both syntaxes widens no CONCEPT: the key is still "reads the payload AND
  // reaches for labels".
  const reachesForLabels = /\.labels\b/.test(text) || /\[\s*['"]labels['"]\s*\]/.test(text);
  return readsPayload && reachesForLabels;
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

    // REGISTRY -> TREE — the one that decays.
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

  // TREE -> REGISTRY — a new label-dependent check appearing undeclared.
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

if (isProcessEntryPoint(import.meta.url)) {
  process.exit(main(process.argv));
}
