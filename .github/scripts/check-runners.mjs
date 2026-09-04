#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Every workflow job runs on the self-hosted pool (#280, follow-up to #111 / PR #279).
 *
 * ---------------------------------------------------------------------------
 * WHY HOSTED RUNNERS ARE REFUSED — read this before deleting or relaxing it
 * ---------------------------------------------------------------------------
 *
 * The repo-wide GitHub Actions budget is exhausted. A job scheduled onto a
 * GitHub-hosted runner is refused at "Set up job" with NO OUTPUT — no error in
 * the log, no failing assertion, nothing that names the cause. On PR #278 that
 * shape cost a full investigation cycle before the answer turned out to be
 * billing rather than code.
 *
 * So the failure this guard prevents is not "a job runs somewhere else". It is
 * "a job fails in the least attributable way this repository can produce". A
 * loud red guard naming the file and the job is strictly better than that.
 *
 * PR #279 moved every job to the self-hosted pool. Nothing stopped the next
 * workflow edit from putting `ubuntu-latest` back, and the likelier route is a
 * NEW workflow file rather than an edit to an existing one — `ubuntu-latest` is
 * what every example on the internet says, so the default pull is toward it.
 * That is why this guard walks the whole directory rather than a known list.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LABEL SET IS HARDCODED BELOW
 * ---------------------------------------------------------------------------
 *
 * Deliberate. A second runner pool should require a visible edit to this file,
 * reviewed on its own merits, rather than being picked up implicitly from
 * whatever a workflow happens to say. Deriving the allowlist FROM the workflows
 * would make the guard tautological — it would approve whatever it found,
 * including the `ubuntu-latest` it exists to reject.
 *
 * IF YOU ARE HERE BECAUSE YOU ADDED A SECOND SELF-HOSTED POOL: add its labels
 * to APPROVED_LABELS and say why in the commit. That is the intended path, and
 * it is two lines. Deleting the guard, or widening it to "anything
 * self-hosted-ish", is not — it restores a silent failure mode that has already
 * cost this project a full investigation cycle once.
 *
 * ---------------------------------------------------------------------------
 * IF YOU ARE HERE BECAUSE ONE JOB MUST RUN ON A GITHUB-HOSTED RUNNER (#595)
 * ---------------------------------------------------------------------------
 *
 * Do NOT add the hosted label to APPROVED_LABELS. That set is repo-wide, so a
 * single entry there would permit EVERY job in every workflow to go hosted —
 * all 24 of them, each failing at "Set up job" with an empty log the moment the
 * budget runs out. That is #280 reopened, and it would be reopened silently, by
 * a change that looks like the two-line edit the paragraph above invites.
 *
 * Use HOSTED_JOB_CARVE_OUTS instead. It is keyed by `file::job`, so it permits
 * exactly one named job in one named workflow, and only with the exact labels
 * recorded against it. Every other job — including another job in the same
 * file, and a same-named job in a different file — is still refused.
 *
 * A carve-out is reviewable as itself: it names the job, the labels and the
 * reason in one place, and a reviewer can see its blast radius without
 * reasoning about what else the change might have permitted.
 *
 * ---------------------------------------------------------------------------
 *
 * Shapes handled, because GitHub accepts all of them and a guard that
 * understands only some is worse than none — it reports a clean pass over the
 * form it cannot see:
 *
 *   runs-on: ubuntu-latest                     bare scalar  <- the likeliest reintroduction
 *   runs-on: [self-hosted, Linux]              flow sequence
 *   runs-on:                                   block sequence
 *     - self-hosted
 *   runs-on:                                   mapping form
 *     group: my-group
 *     labels: [self-hosted, Linux]
 *
 * The bare scalar is called out specifically: it is both the form a person
 * reintroducing a hosted runner would type, and the form a list-only parser
 * silently passes.
 *
 * Exit codes: 0 pass, 1 violations found, 2 could not check.
 *
 * `2` is not a lesser `1`. A guard that cannot read its input and exits 0 is
 * indistinguishable in a CI log from one that checked and found nothing —
 * "could not check" is never "passed" (the reasoning check-audit-append-only.mjs
 * and check-path-filters.mjs already follow). Where a job's runner cannot be
 * determined at all, this guard exits 2 even if it also found real violations:
 * an unreadable workflow undermines the whole verdict, not just one line of it.
 *
 * ALL offenders are reported in one pass. Fixing them one CI run at a time
 * would spend the very resource this guard exists to protect.
 *
 * Deliberately uses only Node builtins, so it needs no install to be
 * trustworthy — same reasoning as the readiness-matrix gate. The parser REFUSES
 * what it does not recognise rather than skipping it, so an unexpected edit
 * cannot quietly reduce what is covered.
 *
 * Run: node .github/scripts/check-runners.mjs [repoRoot]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The approved self-hosted pool (PR #279). Compared case-insensitively, so a
 * `Ubuntu-Latest` variant cannot slip past on casing alone.
 *
 * See the header before changing this. Adding a pool here is the supported
 * path; removing the guard is not.
 */
const APPROVED_LABELS = new Set(['self-hosted', 'linux', 'x64', 'askturret']);

/**
 * A compliant job must carry this label explicitly.
 *
 * The allowlist alone is not sufficient. `runs-on: [Linux]` uses only approved
 * labels yet asserts nothing about WHERE it runs; `self-hosted` is the single
 * label that actually keeps a job off the hosted fleet, which is the property
 * this guard is protecting.
 */
const REQUIRED_LABEL = 'self-hosted';

/**
 * Named per-job exemptions from the self-hosted rule (#595).
 *
 * Keyed `<workflow path>::<job name>` and carrying the EXACT labels permitted,
 * so an entry cannot generalise: it does not cover another job in the same
 * file, a same-named job in a different file, or the same job on different
 * labels. Anything not matching all three falls through to the normal rules.
 *
 * This is deliberately not a label allowlist. See the header — widening
 * APPROVED_LABELS would permit every job in the repository to go hosted, which
 * is the failure #280 exists to prevent.
 *
 * Each entry must record WHY the job is worth hosted minutes, because that is
 * the judgement a reviewer has to re-make when the budget is next under
 * pressure.
 */
const HOSTED_JOB_CARVE_OUTS = new Map([
  [
    '.github/workflows/supply-chain.yml::publish',
    {
      labels: ['ubuntu-latest'],
      reason:
        'npm refuses `--provenance` on a self-hosted runner outright — E422 ' +
        '"Only \'github-hosted\' runners are supported when publishing with provenance" ' +
        '(#595, observed, not inferred). The job is `if: github.event_name == \'release\'`, ' +
        'so it costs minutes per release rather than the 17-jobs-per-PR load that drove #280.',
    },
  ],
]);

/**
 * The carve-out for a job, if one applies to it EXACTLY.
 *
 * Label comparison is case-insensitive, order-insensitive and length-checked:
 * a carved-out job that quietly gains a second label is no longer the job that
 * was reviewed, so it is refused rather than tolerated.
 */
function carveOutFor(relPath, jobName, labels) {
  const entry = HOSTED_JOB_CARVE_OUTS.get(`${relPath.split(sep).join('/')}::${jobName}`);
  if (entry === undefined) return null;

  const got = labels.map((l) => l.toLowerCase()).sort();
  const want = entry.labels.map((l) => l.toLowerCase()).sort();
  if (got.length !== want.length) return null;
  if (!got.every((l, i) => l === want[i])) return null;

  return entry;
}

const repoRoot = resolve(
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
);
const workflowsDir = join(repoRoot, '.github', 'workflows');

/** Exit 2: the guard could not answer. Never conflate this with a pass. */
function cannotCheck(message) {
  console.error(`check-runners: CANNOT CHECK — ${message}`);
  process.exit(2);
}

const indentOf = (line) => line.match(/^(\s*)/)[1].length;
const isSkippable = (line) => line.trim() === '' || /^\s*#/.test(line);

/**
 * Drop a trailing `# comment`, respecting quotes.
 *
 * `runs-on: [self-hosted] # our pool` must not be read as an unterminated
 * flow sequence, and a `#` inside a quoted label must not truncate the value.
 */
function stripComment(text) {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

/** Strip one layer of matching quotes, if present. */
function unquote(text) {
  const t = text.trim();
  const quoted =
    t.length >= 2 &&
    ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')));
  return quoted ? t.slice(1, -1) : t;
}

/** Split a `[a, b, c]` flow sequence. Returns null if it is not one. */
function parseFlowSequence(text) {
  const t = text.trim();
  if (!t.startsWith('[')) return null;
  if (!t.endsWith(']')) return null; // a multi-line flow sequence: not recognised, not guessed

  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((part) => unquote(part));
}

/**
 * Split the file into `{ name, lines }` for each entry under `jobs:`.
 *
 * Refuses rather than guesses. A file whose job block cannot be walked is
 * reported, never skipped — skipping is how a new workflow with `ubuntu-latest`
 * would pass unnoticed, which is the exact scenario #280 describes.
 */
function parseJobs(text, file) {
  const lines = text.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(stripComment(l)));
  if (jobsIdx === -1) cannotCheck(`${file} has no top-level \`jobs:\` block`);

  let jobIndent = null;
  const jobs = [];
  let current = null;

  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippable(line)) {
      if (current) current.lines.push(line);
      continue;
    }

    const indent = indentOf(line);
    if (indent === 0) break; // back to a top-level key: the jobs block ended

    if (jobIndent === null) jobIndent = indent;

    if (indent === jobIndent) {
      const key = stripComment(line).match(/^\s*([A-Za-z0-9_.-]+):\s*$/);
      if (!key) {
        cannotCheck(
          `${file}: unrecognised entry in the \`jobs:\` block (line ${i + 1}): ` +
            JSON.stringify(line),
        );
      }
      current = { name: key[1], lines: [], line: i + 1 };
      jobs.push(current);
      continue;
    }

    if (indent < jobIndent) {
      cannotCheck(
        `${file}: line ${i + 1} is indented less than the job keys but is not top-level: ` +
          JSON.stringify(line),
      );
    }

    if (current === null) {
      cannotCheck(`${file}: content inside \`jobs:\` before any job name (line ${i + 1})`);
    }
    current.lines.push(line);
  }

  if (jobs.length === 0) cannotCheck(`${file}: the \`jobs:\` block declares no jobs`);
  return jobs;
}

/**
 * Resolve a job's runner labels.
 *
 * Returns `{ labels }` when they could be determined, or `{ unknown }` with a
 * reason when they could not. A job whose runner is UNDETERMINED is never
 * treated as compliant.
 */
function resolveRunsOn(job, file) {
  const body = job.lines.filter((l) => !isSkippable(l));
  if (body.length === 0) {
    return { unknown: 'the job body is empty' };
  }

  // The job's own keys sit at the shallowest indent in its block. Anything
  // deeper belongs to a step, so a `runs-on:` down there is not this job's.
  const keyIndent = Math.min(...body.map(indentOf));

  const matches = [];
  for (let i = 0; i < job.lines.length; i++) {
    const line = job.lines[i];
    if (isSkippable(line)) continue;
    if (indentOf(line) !== keyIndent) continue;
    const m = stripComment(line).match(/^\s*runs-on\s*:(.*)$/);
    if (m) matches.push({ index: i, inline: m[1] });
  }

  if (matches.length > 1) {
    return { unknown: `the job declares \`runs-on\` ${matches.length} times` };
  }

  if (matches.length === 0) {
    // A job that delegates to a reusable workflow has no runner of its own;
    // the callee's jobs carry it. Anything else with no `runs-on` is either
    // invalid Actions YAML or a shape this parser missed — both are CANNOT
    // CHECK, because "I did not find one" must not read as "it is fine".
    const delegates = job.lines.some(
      (l) => !isSkippable(l) && indentOf(l) === keyIndent && /^\s*uses\s*:/.test(stripComment(l)),
    );
    if (delegates) return { delegated: true };
    return { unknown: 'the job declares no `runs-on` and does not call a reusable workflow' };
  }

  const { index, inline } = matches[0];
  const inlineValue = stripComment(inline).trim();

  if (inlineValue !== '') {
    if (inlineValue.includes('${{')) {
      return {
        expression: inlineValue,
        labels: null,
      };
    }
    const flow = parseFlowSequence(inlineValue);
    if (flow !== null) return { labels: flow };

    // An opening `[` with no closing `]` is a flow sequence spilling onto the
    // next line. Falling through to the scalar branch would "work" — it exits
    // non-zero — but for the wrong reason, reporting an offending label of
    // `[self-hosted,` and sending the reader to look for a label that does not
    // exist. Not understanding the form is the honest answer.
    if (inlineValue.startsWith('[')) {
      return { unknown: 'a `runs-on` flow sequence spanning multiple lines is not recognised' };
    }

    return { labels: [unquote(inlineValue)] };
  }

  // Nothing on the same line: the value is the indented block beneath it.
  const runsOnIndent = indentOf(job.lines[index]);
  const block = [];
  for (let i = index + 1; i < job.lines.length; i++) {
    const line = job.lines[i];
    if (isSkippable(line)) continue;
    if (indentOf(line) <= runsOnIndent) break;
    block.push(line);
  }

  if (block.length === 0) return { unknown: '`runs-on` has an empty value' };

  const asSequence = block.every((l) => /^\s*-\s*\S/.test(stripComment(l)));
  if (asSequence) {
    return {
      labels: block.map((l) => unquote(stripComment(l).replace(/^\s*-\s*/, ''))),
    };
  }

  // Mapping form: `labels:` and/or `group:`.
  const mapIndent = Math.min(...block.map(indentOf));
  const entries = block.filter((l) => indentOf(l) === mapIndent);
  let labels = null;
  let group = null;

  for (let i = 0; i < entries.length; i++) {
    const m = stripComment(entries[i]).match(/^\s*(labels|group)\s*:(.*)$/);
    if (!m) {
      return { unknown: `unrecognised \`runs-on\` mapping key: ${JSON.stringify(entries[i])}` };
    }
    const [, key, rawValue] = m;
    const value = rawValue.trim();

    if (key === 'group') {
      group = unquote(value);
      continue;
    }

    if (value === '') {
      // `labels:` with an indented sequence beneath it.
      const start = block.indexOf(entries[i]);
      const nested = [];
      for (let j = start + 1; j < block.length; j++) {
        if (indentOf(block[j]) <= mapIndent) break;
        nested.push(block[j]);
      }
      if (nested.length === 0 || !nested.every((l) => /^\s*-\s*\S/.test(stripComment(l)))) {
        return { unknown: '`runs-on.labels` has no readable value' };
      }
      labels = nested.map((l) => unquote(stripComment(l).replace(/^\s*-\s*/, '')));
      continue;
    }

    if (value.includes('${{')) return { expression: value, labels: null };
    const flow = parseFlowSequence(value);
    labels = flow !== null ? flow : [unquote(value)];
  }

  if (labels === null) {
    // `group:` alone routes by runner group, and a group name says nothing
    // statically about whether it is hosted — GitHub-hosted larger runners use
    // groups too. Unverifiable, so not verified.
    return {
      unknown:
        group === null
          ? '`runs-on` mapping declares neither `labels` nor `group`'
          : `\`runs-on\` uses \`group: ${group}\` with no \`labels\`, so the pool cannot be ` +
            `confirmed statically`,
    };
  }

  return { labels, group };
}

// ---------------------------------------------------------------------------

if (!existsSync(workflowsDir)) cannotCheck(`${workflowsDir} does not exist`);

const workflowFiles = readdirSync(workflowsDir)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

// `.yaml` is included above on purpose. #280 names a NEW workflow file as the
// likelier route back to a hosted runner, and a guard that only matched `.yml`
// would be silently blind to the one extension a newcomer is equally likely to
// reach for.
if (workflowFiles.length === 0) cannotCheck(`no workflow files found in ${workflowsDir}`);

const violations = [];
const unknowns = [];
const carvedOut = [];
let jobsChecked = 0;
let delegated = 0;

for (const file of workflowFiles) {
  const rel = join('.github', 'workflows', file);
  const text = readFileSync(join(workflowsDir, file), 'utf-8');

  for (const job of parseJobs(text, rel)) {
    const where = `${rel} job '${job.name}'`;
    const result = resolveRunsOn(job, rel);

    if (result.delegated) {
      delegated++;
      continue;
    }

    if (result.unknown) {
      unknowns.push(`${where}: ${result.unknown}`);
      continue;
    }

    if (result.expression) {
      // An expression is a legal GitHub shape, but its value is decided at run
      // time. Reported as a violation rather than CANNOT CHECK because the fix
      // is specific and local — write the labels literally — and because a
      // violation aggregates with the others instead of aborting the pass.
      violations.push(
        `${where}: \`runs-on: ${result.expression}\` is resolved at run time, so the ` +
          `runner cannot be verified here — write the labels literally`,
      );
      continue;
    }

    jobsChecked++;
    const labels = result.labels;

    if (labels.length === 0) {
      violations.push(`${where}: \`runs-on\` resolves to an empty label set`);
      continue;
    }

    // A named per-job carve-out (#595), checked BEFORE the label rules because
    // its whole purpose is to permit labels those rules refuse. It matches on
    // file, job name AND exact labels, so it cannot widen to anything else.
    const carveOut = carveOutFor(rel, job.name, labels);
    if (carveOut) {
      carvedOut.push(`${where}: runs on ${labels.map((l) => `'${l}'`).join(', ')} — ${carveOut.reason}`);
      continue;
    }

    const offending = labels.filter((l) => !APPROVED_LABELS.has(l.toLowerCase()));
    if (offending.length > 0) {
      violations.push(
        `${where}: runs on ${offending.map((l) => `'${l}'`).join(', ')}, which ` +
          `${offending.length === 1 ? 'is not an approved runner label' : 'are not approved runner labels'} — ` +
          `hosted runners are refused at "Set up job" with an empty log because the ` +
          `Actions budget is exhausted (#111/#280)`,
      );
      continue;
    }

    if (!labels.some((l) => l.toLowerCase() === REQUIRED_LABEL)) {
      violations.push(
        `${where}: \`runs-on\` omits '${REQUIRED_LABEL}' — every label used is approved, but ` +
          `without it nothing pins the job to the self-hosted pool`,
      );
    }
  }
}

// Precedence is deliberate: a job whose runner could not be determined
// invalidates the whole verdict, so it outranks a violation even though both
// exit non-zero. Everything found is printed either way — one pass, one fix.
if (unknowns.length > 0) {
  console.error('check-runners: CANNOT CHECK\n');
  for (const u of [...new Set(unknowns)].sort()) console.error(`  - ${u}`);
  if (violations.length > 0) {
    console.error('\nAlso found, but the run above is not trustworthy until these are readable:');
    for (const v of [...new Set(violations)].sort()) console.error(`  - ${v}`);
  }
  console.error(
    `\n${unknowns.length} job(s) whose runner could not be determined. ` +
      `A runner this guard cannot read is a runner it cannot vouch for.`,
  );
  process.exit(2);
}

if (violations.length > 0) {
  console.error('check-runners: FAIL\n');
  for (const v of [...new Set(violations)].sort()) console.error(`  - ${v}`);
  console.error(
    `\n${violations.length} problem(s). Every job must declare ` +
      `\`runs-on: [${[...APPROVED_LABELS].join(', ')}]\` (matching is case-insensitive). ` +
      `If a new SELF-HOSTED pool was added, extend APPROVED_LABELS in ` +
      `.github/scripts/check-runners.mjs rather than removing the guard — see its header. ` +
      `If ONE job genuinely needs a GitHub-hosted runner, add a named entry to ` +
      `HOSTED_JOB_CARVE_OUTS instead: putting a hosted label in APPROVED_LABELS would ` +
      `permit every job in the repository to go hosted, which is #280 reopened.`,
  );
  process.exit(1);
}

// Printed on success, not only on failure: a carve-out that nobody sees is a
// carve-out nobody re-examines when the Actions budget is next under pressure.
if (carvedOut.length > 0) {
  console.log(`check-runners: ${carvedOut.length} named per-job carve-out(s) in effect (#595):`);
  for (const c of carvedOut) console.log(`  - ${c}`);
}

console.log(
  `check-runners: OK — ${jobsChecked} job(s) checked across ${workflowFiles.length} workflow ` +
    `file(s): ${jobsChecked - carvedOut.length} on the approved self-hosted pool` +
    (carvedOut.length > 0 ? `, ${carvedOut.length} on a named per-job hosted carve-out` : '') +
    (delegated > 0 ? `, ${delegated} delegated to reusable workflows` : '') +
    '.',
);
