#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Rejects `npm test` invocations that pass a jest flag npm will silently eat.
 *
 * `npm test --testPathPattern=X` does not filter anything. npm parses the flag
 * as one of ITS OWN config options, never forwards it to jest, and runs the
 * full suite. On npm 11 that prints `npm warn Unknown cli config` — one line,
 * mid-scrollback, above the output of every test it just ran anyway — and on
 * older npm it printed nothing at all. The exit code is 0 either way.
 *
 * That is this repo's usual quarry: a command that reports success for work it
 * did not do. It is the same shape as `check-test-execution` (a suite that ran
 * nothing) and `check-placeholder-tests` (a test that cannot fail), and it had
 * really happened — two steps in `test-integrity` named "Policy parity test
 * (criterion #4)" and "Idempotent+retryable fuzz test (criterion #6)" were each
 * running the ENTIRE workspace suite instead (#207).
 *
 * ## The correct form needs BOTH halves
 *
 *   npm test -w packages/core -- --testPathPattern="parity"
 *              ^^^^^^^^^^^^^^^ ^^
 *
 * `--` makes npm forward the flag to jest instead of consuming it. `-w <pkg>`
 * confines the run to ONE workspace. Neither alone is enough, and this guard
 * therefore fails on both partial forms:
 *
 *   - no `--`  -> the silent no-op above
 *   - `--` but no `-w` -> the flag reaches EVERY workspace under
 *     `--workspaces`, and jest exits 1 in each one the pattern does not match,
 *     so a correct command breaks unrelated packages. That is why #207 could
 *     not be closed by adding `--` and nothing else.
 *
 * ## Scope: files where the string would EXECUTE
 *
 * Workflow files and `package.json` scripts. Prose is deliberately NOT scanned
 * — CONTRIBUTING.md documents the broken form as the thing not to do, and a
 * guard that cannot tell an example from an instruction would either fail on
 * its own documentation or force that documentation to omit the very string a
 * reader needs to recognise.
 *
 * The granularity differs between the two, and this comment used to overstate
 * it (#312). `package.json` really is read through `scripts` only, so a
 * dependency or description mentioning the string cannot trip the guard. A
 * workflow, by contrast, is scanned LINE BY LINE across the whole file, not
 * `run:` blocks only — so the broken form inside a YAML **comment** fails too.
 * That is the safe direction and not worth the YAML parser it would take to
 * narrow, but it is not what the previous wording promised.
 *
 * Usage:
 *   node .github/scripts/check-jest-flag-forwarding.mjs [rootDir]
 *
 * Errors (exit 1):
 *   - an `npm test`/`npm run test` command passing a jest flag with no `--`
 *   - the same with `--` but no `-w`/`--workspace`, which breaks other packages
 *   - `-w` present but AFTER the `--`, where npm forwards it to jest instead of
 *     scoping the run (#312) — the full suite runs and the pattern filters
 *     nothing, which is the #207 silent no-op this guard exists to prevent
 *   - any ONE command in a chain being broken (#331); each is judged separately
 *
 * ## What the command split does NOT model, and why that is the right trade
 *
 * `splitCommands` tracks quotes and nothing else. It is deliberately not a
 * shell tokeniser — no expansion, no subshells, no here-docs, no `$(...)` —
 * because that is the parser dependency this repo's guards refuse, and every
 * shell construct hand-rolled here is a fresh way to mis-read a command.
 *
 * The residual, stated plainly: a separator hidden inside a construct this does
 * not model can split a command that should not be split. That produces a
 * segment which may be reported — a FALSE POSITIVE, which fails loud and prints
 * the command it objected to.
 *
 * An earlier version of this comment claimed that was the ONLY residual. It was
 * wrong, and the correction is the reason `findingsFor` unions rather than
 * merely splitting. A mis-split can also SUPPRESS: with the `--` stranded in a
 * segment holding no `npm test`, the leading segment classifies clean and a
 * genuinely broken command disappears. That is a false NEGATIVE, in the guard
 * whose whole purpose is refusing them, and no rarity argument excuses it —
 * severity here is about direction, not frequency.
 *
 * So suppression is now impossible BY CONSTRUCTION rather than by inspection:
 * the unsplit line is always classified too, and splitting can only add. Do not
 * "simplify" `findingsFor` back to the segments alone; that is the defect, and
 * four assertions marked `#331 QA` fail when you do.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? '.');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

/**
 * Jest flags npm consumes rather than forwards.
 *
 * Only flags that take the `--name=value` or `--name value` shape and are NOT
 * npm config keys. `--coverage` is deliberately absent: npm has no such config,
 * so it forwards cleanly and is not part of this defect.
 */
const JEST_FLAGS = [
  'testPathPattern',
  'testPathPatterns',
  'testNamePattern',
  'testPathIgnorePatterns',
  'runTestsByPath',
  'selectProjects',
  'maxWorkers',
];

const FLAG_ALTERNATION = JEST_FLAGS.join('|');

/**
 * The one form that works, quoted in every finding.
 *
 * #312's sharpest observation is that this guard's OWN advice, followed
 * literally, produced the defect it exists to prevent: "add `--` before the
 * flag, and `-w <package>` to scope it" appends both after `--`, in that order,
 * which is exactly the broken command. A guard that hands out an ambiguous fix
 * has a defect in its output, not merely in its matcher — so every branch now
 * shows the position rather than describing it.
 */
const CANONICAL = 'npm test -w packages/<pkg> -- --testPathPattern="<pattern>"';

/** An `npm test` / `npm run test` command, up to the end of its SEGMENT. */
const NPM_TEST = new RegExp(String.raw`\bnpm\s+(?:run\s+)?test\b[^\n]*`, 'g');

/**
 * Split one line into shell commands at `&&`, `||`, `;`, `|` and `&` (#331).
 *
 * `NPM_TEST` runs to the end of what it is given, so before this a chain was
 * consumed as ONE command: in
 *
 *   npm test -w a -- --testPathPattern=Y && npm test --testPathPattern=Z
 *
 * the well-formed first half matched, classified clean, and the SECOND half was
 * never examined — while that second half is precisely the silent full-suite run
 * #207 exists to prevent. Latent when fixed (nothing in this repo chains
 * `npm test`), which is exactly why it was worth closing before someone writes a
 * two-package step and the guard stays green at them.
 *
 * ## Quote tracking, and what this deliberately is NOT
 *
 * A separator inside a quoted argument is not a separator:
 * `--testPathPattern="a|b"` must stay one command. So quote state is tracked —
 * and that is the ONLY shell concept modelled here. This is not a tokeniser and
 * must not grow into one: no word splitting, no expansion, no subshells, no
 * here-docs. Those are the parser dependency this repo's guards refuse.
 *
 * ## The failure direction is chosen, not incidental
 *
 * If a line ends with a quote still open, the quoting is beyond what this
 * models. Rather than trusting the state we ended up with — which suppresses
 * splits and therefore hides a broken second command, the FALSE NEGATIVE
 * direction that #312 and this issue are both about — the line is re-split with
 * quote tracking off. The residual failure is then a false POSITIVE that fails
 * loud and prints the command, which is the cheap direction.
 */
function splitCommands(line, { respectQuotes = true } = {}) {
  const parts = [];
  let start = 0;
  let quote = null;

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];

    if (quote !== null) {
      // Backslash escapes only inside double quotes, as in sh.
      if (c === '\\' && quote === '"') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (respectQuotes && (c === '"' || c === "'")) {
      quote = c;
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === ';' || c === '&' || c === '|') {
      parts.push(line.slice(start, i));
      if (line[i + 1] === c) i += 1; // `&&` and `||` are one separator, not two
      start = i + 1;
    }
  }
  parts.push(line.slice(start));

  if (respectQuotes && quote !== null) return splitCommands(line, { respectQuotes: false });
  return parts;
}

const posix = (p) => p.split(sep).join('/');

function collect(dir, predicate, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, predicate, out);
    else if (predicate(entry)) out.push(full);
  }
  return out;
}

/**
 * Classify one `npm test ...` command.
 *
 * Returns null when it carries no jest flag at all — the overwhelming majority,
 * and none of this guard's business.
 */
function classify(command) {
  const flag = new RegExp(String.raw`--(${FLAG_ALTERNATION})\b`).exec(command);
  if (!flag) return null;

  const flagAt = flag.index;

  // npm's argv boundary is the FIRST standalone `--`: everything after it is
  // handed to the script rather than read by npm. BOTH checks below are
  // positional against that one boundary (#312).
  const sepMatch = /(?:^|\s)--(?=\s)/.exec(command);
  const sepAt = sepMatch ? sepMatch.index : -1;

  // A `--` BEFORE the flag is what forwards it; one after does not help it.
  const forwarded = sepAt !== -1 && sepAt < flagAt;

  // `-w` AFTER the separator is handed to jest as a plain argument, NOT
  // consumed by npm as a workspace selector — so npm runs every workspace and
  // the pattern scopes nothing. Presence alone was the #312 false negative.
  // The spelling is CAPTURED rather than sliced back out: `wMatch.index` points
  // at the leading whitespace, so `slice(index, index + 2)` yielded " -", which
  // trimmed to "-" and made both spellings print as a flag that does not exist —
  // in the very message #312 added to remove ambiguity (#332 QA).
  const wMatch = /(?:^|\s)(-w|--workspace)(?:=|\s)/.exec(command);
  const scoped = wMatch !== null && (sepAt === -1 || wMatch.index < sepAt);

  if (!forwarded) {
    return {
      problem: `npm eats --${flag[1]} as its own config and runs the FULL suite`,
      fix: `put \`-w <package>\` and \`--\` BEFORE the flag: ${CANONICAL}`,
    };
  }
  // Distinguished from "no -w at all" because the remedy differs: the flag is
  // present and merely on the wrong side of `--`. Saying "add -w" to someone
  // who already typed it is the ambiguity that produced this defect.
  if (wMatch !== null && !scoped) {
    return {
      problem: `\`${wMatch[1]}\` sits AFTER \`--\`, so npm forwards it to jest instead of scoping the run; every workspace runs and --${flag[1]} scopes nothing`,
      fix: `move \`-w <package>\` BEFORE the \`--\`: ${CANONICAL}`,
    };
  }
  if (!scoped) {
    return {
      problem: `--${flag[1]} is forwarded to EVERY workspace; jest exits 1 wherever it matches nothing`,
      fix: `add \`-w <package>\` BEFORE the \`--\`: ${CANONICAL}`,
    };
  }
  return null;
}

const findings = [];

/**
 * Findings for one line: the SEGMENTS *union* the UNSPLIT line.
 *
 * Splitting alone was not safe. A separator INTERIOR to a single command —
 * an ordinary command substitution is enough — strands the `--` in a segment
 * that holds no `npm test`, while the leading segment has no `--` and so
 * classifies clean:
 *
 *   npm test $(cat p|head -1) -- --testPathPattern=Z
 *
 * That is plain `--testPathPattern` reaching EVERY workspace — the #207 silent
 * no-op — caught before #331 and missed after it. Found by QA on this PR, and
 * it is the direction this guard exists to refuse, so an unmodelled construct
 * must never be able to cost a finding.
 *
 * The union makes that true BY CONSTRUCTION rather than by inspection: the
 * unsplit pass IS the pre-#331 behaviour, so every problem it used to report is
 * still reported. Splitting can now only ADD.
 *
 * The one subtraction allowed is a strictly more specific report of the SAME
 * problem: when a segment finding covers a command the unsplit finding merely
 * starts with, the segment wins, because the segment is the actionable unit.
 * That cannot hide anything — the problem is still reported, against a shorter
 * command.
 */
function findingsFor(text, file, line) {
  const fromSegments = [];
  for (const segment of splitCommands(text)) {
    for (const m of segment.matchAll(NPM_TEST)) {
      const verdict = classify(m[0]);
      if (verdict) fromSegments.push({ file, line, command: m[0].trim(), ...verdict });
    }
  }

  const out = [...fromSegments];
  for (const m of text.matchAll(NPM_TEST)) {
    const verdict = classify(m[0]);
    if (!verdict) continue;
    const command = m[0].trim();
    const supersededBySegment = fromSegments.some(
      (f) => f.problem === verdict.problem && command.startsWith(f.command),
    );
    if (!supersededBySegment) out.push({ file, line, command, ...verdict });
  }
  return out;
}

function scan(file, text) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    findings.push(...findingsFor(line, posix(relative(repoRoot, file)), i + 1));
  });
}

const workflowDir = join(repoRoot, '.github', 'workflows');
const workflows = existsSync(workflowDir)
  ? collect(workflowDir, (e) => e.endsWith('.yml') || e.endsWith('.yaml'))
  : [];

for (const file of workflows) scan(file, readFileSync(file, 'utf-8'));

// package.json is scanned through its scripts only, so a dependency or a
// description mentioning the string cannot trip the guard.
for (const file of collect(repoRoot, (e) => e === 'package.json')) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    continue; // not this guard's job to report malformed JSON
  }
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (typeof command !== 'string') continue;
    findings.push(
      ...findingsFor(command, `${posix(relative(repoRoot, file))} (scripts.${name})`, null),
    );
  }
}

console.log(
  `Scanned ${workflows.length} workflow file(s) and every package.json scripts block.`,
);

if (findings.length === 0) {
  console.log('\nNo npm test invocation drops a jest flag.');
  process.exit(0);
}

for (const f of findings) {
  console.error(`  FAIL  ${f.file}${f.line === null ? '' : `:${f.line}`}`);
  console.error(`        ${f.command}`);
  console.error(`        ${f.problem}`);
  console.error(`        fix: ${f.fix}`);
}

console.error(
  `\n::error::${findings.length} npm test invocation(s) pass a jest flag that will not do what ` +
    'they say.\nThe correct form needs BOTH halves:\n' +
    '  npm test -w packages/<pkg> -- --testPathPattern="<pattern>"\n' +
    'See CONTRIBUTING.md > Running a subset of the tests.',
);
process.exit(1);
