#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Stage 1 of the mutation audit (#428): measure which failure sites have a
 * witness, and report. It does NOT fail on unwitnessed sites.
 *
 * ## What a "site" is, and why it is not `errors.push`
 *
 * The proposal keyed on `errors.push`. Measured against this tree that covers
 * 47 of 113 failure sites and 6 of 24 scripts, while reporting that "the guards
 * are mutation-audited" — #428's own defect shape inside its fix. **18 of 24
 * scripts contain no `errors.push` at all.**
 *
 * So the key is the failure OUTCOME — a guard fails by exiting non-zero — and
 * the enumeration below is the set of routes to it:
 *
 *   errors.push(...)          deferred, drained by `if (errors.length) exit(1)`
 *   throw ...                 uncaught, exits non-zero
 *   process.exit(<non-zero>)  direct
 *   return <non-zero int>     from a `main()` whose result is passed to exit
 *
 * That list is still a CLAIM. `completenessProbe` below is what turns it into
 * an observation.
 *
 * ## What this measures, and what it cannot
 *
 * A site is WITNESSED when neutralising it turns its guard's self-test red. The
 * honest limit: witnessed **relative to what that self-test exercises**. A
 * failure path the self-test never triggers stays invisible — but such a path
 * is unwitnessed by definition, so the blind spot points the same way as the
 * finding rather than against it.
 *
 * ## The mutation traps, and the one that INVERTS here
 *
 * `docs/TESTING.md` catalogues five. Applied to an automated runner:
 *
 *   1  edit breaks the file    THE DANGEROUS ONE. Here RED = PASS, so a
 *                              syntax-broken mutation reddens the self-test and
 *                              the site records as WITNESSED. The audit becomes
 *                              silently too PERMISSIVE — the opposite of the
 *                              failure you would expect. `node --check` runs
 *                              before EVERY self-test run; a parse failure is an
 *                              audit error, never a pass.
 *   2  mutation lands elsewhere  No textual `String.replace` anywhere. Sites are
 *                              byte offsets found in MASKED source, so a match
 *                              cannot be inside a comment or string, and the
 *                              exact original text at the offset is asserted
 *                              before splicing.
 *   3  residue                 Every run restores the file from the original
 *                              bytes and verifies the restore.
 *   4  status-only assertion   Exit status IS this audit's signal, so the newly
 *                              failing assertion NAMES are reported alongside it.
 *   5  vacuous green           A non-green baseline is CANNOT CHECK, never
 *                              "witnessed".
 *
 * ## Usage
 *
 *   node .github/scripts/check-mutation-audit.mjs [rootDir] [--write]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SCRIPTS_REL = '.github/scripts';
export const INVENTORY_REL = '.operum/audit/mutation-audit-inventory.md';

/** Where a site's neutralisation is spliced, and what it becomes. */
export const SITE_KINDS = Object.freeze(['errors-push', 'throw', 'process-exit', 'return-code']);

/* -------------------------------------------------------------------------
 * Masking — the whole defence against trap 2
 *
 * Every byte that is not executable code becomes a space, and offsets are
 * preserved exactly. A site found in the masked text is therefore in real code
 * by construction, which is what makes "anchor by offset" meaningful rather
 * than a restatement of "replace the first occurrence".
 * ---------------------------------------------------------------------- */

/** Chars after which a `/` opens a regex rather than dividing. */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '+', '-', '*', '%', '<', '>', '~', '^']);

export function maskCode(src) {
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = src[i];

  const blank = (from, to) => {
    for (let i = from; i < to && i < src.length; i += 1) {
      out[i] = src[i] === '\n' ? '\n' : ' ';
    }
  };

  let i = 0;
  let lastSignificant = '\n';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      blank(i, Math.min(j + 2, src.length));
      i = j + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j += 1;
      }
      // Keep the quotes so the token stream still balances; blank the inside.
      blank(i + 1, j);
      lastSignificant = c;
      i = j + 1;
      continue;
    }
    if (c === '/' && REGEX_PRECEDERS.has(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') break;
        j += 1;
      }
      blank(i + 1, j);
      lastSignificant = '/';
      i = j + 1;
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }

  return out.join('');
}

/** 1-indexed line of a byte offset. */
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Offset of the `)` matching the `(` at `open`, or -1. */
function matchParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every route to a non-zero exit, as byte ranges with their replacement.
 *
 * `start`/`end` bound the text to be replaced; `token` is what must be there
 * (asserted before splicing, per trap 2); `replacement` is the neutralisation.
 */
export function enumerateSites(src) {
  const masked = maskCode(src);
  const sites = [];

  // errors.push(...) -> (()=>{})(...). Arguments still evaluate, so a mutation
  // cannot mask a crash inside them; only the recording is removed.
  for (const m of masked.matchAll(/\berrors\.push\s*\(/g)) {
    const start = m.index;
    const end = start + 'errors.push'.length;
    sites.push({ kind: 'errors-push', start, end, token: 'errors.push', replacement: '(()=>{})', line: lineOf(src, start) });
  }

  // throw X -> void X. Still constructs the value, then discards it.
  for (const m of masked.matchAll(/\bthrow\b/g)) {
    const start = m.index;
    sites.push({ kind: 'throw', start, end: start + 5, token: 'throw', replacement: 'void', line: lineOf(src, start) });
  }

  // process.exit(<arg>) -> process.exit(0). Replacing the ARGUMENT rather than
  // the call keeps control flow identical, which `(()=>{})` would not.
  for (const m of masked.matchAll(/\bprocess\.exit\s*\(/g)) {
    const open = masked.indexOf('(', m.index);
    const close = matchParen(masked, open);
    if (close < 0) continue;
    const arg = src.slice(open + 1, close).trim();
    if (arg === '0' || arg === '') continue; // a success exit is not a failure site
    sites.push({
      kind: 'process-exit',
      start: open + 1,
      end: close,
      token: src.slice(open + 1, close),
      replacement: '0',
      line: lineOf(src, open),
    });
  }

  // return <non-zero int>; from a main() whose value is passed to process.exit.
  for (const m of masked.matchAll(/\breturn\s+([1-9]\d*)\s*;/g)) {
    const numStart = m.index + m[0].indexOf(m[1]);
    sites.push({
      kind: 'return-code',
      start: numStart,
      end: numStart + m[1].length,
      token: m[1],
      replacement: '0',
      line: lineOf(src, numStart),
    });
  }

  return sites.sort((a, b) => a.start - b.start);
}

/**
 * Splice neutralisations in, asserting each lands where it was found.
 *
 * Descending order so an earlier replacement cannot shift a later offset, and
 * the token assertion is what makes "it landed" an observation rather than an
 * assumption (trap 2).
 */
export function applyMutations(src, sites) {
  let out = src;
  for (const site of [...sites].sort((a, b) => b.start - a.start)) {
    const found = out.slice(site.start, site.end);
    if (found !== site.token) {
      throw new Error(
        `mutation would not land: expected ${JSON.stringify(site.token)} at offset ${site.start} ` +
          `(line ${site.line}), found ${JSON.stringify(found)}`,
      );
    }
    out = out.slice(0, site.start) + site.replacement + out.slice(site.end);
  }
  return out;
}

/**
 * Assertion NAMES that failed, when the self-test's format exposes them.
 *
 * The trailing `(expected X, got Y)` is stripped, and that is not cosmetic.
 * Comparing whole lines makes the SAME assertion read as a different string
 * under two different mutations — `(expected 1, got 2)` versus
 * `(expected 1, got 0)` — so a set difference over lines reports a failure
 * route that does not exist. The first run of this audit produced nine such
 * false "unknown failure path" reports before the suffix was stripped.
 */
export function failingAssertions(output) {
  return [...output.matchAll(/^\s*(?:FAIL|not ok)\s*-?\s*(.+)$/gm)].map((m) =>
    m[1].replace(/\s*\(expected\s[\s\S]*?,\sgot\s[\s\S]*?\)\s*$/, '').trim(),
  );
}

/**
 * Every assertion name the run REACHED, passing or failing.
 *
 * Needed because "absent from the failing list" is not "passed" — it is also
 * what a run that never got there looks like. Neutralising every site at once
 * can leave a guard in a state that aborts its self-test partway, so later
 * assertions never execute. Treating those as passing produced eight false
 * "unknown failure path" reports on this repo's own tree.
 *
 * Same principle as the rest of this file, one level in: "I could not check"
 * is not "it passed".
 */
export function reachedAssertions(output) {
  return [...output.matchAll(/^\s*(?:ok|FAIL|not ok)\s*-?\s*(.+)$/gm)].map((m) =>
    m[1].replace(/\s*\(expected\s[\s\S]*?,\sgot\s[\s\S]*?\)\s*$/, '').trim(),
  );
}

function runNodeCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function runSelfTest(testPath, cwd) {
  const r = spawnSync(process.execPath, [testPath], { encoding: 'utf-8', cwd });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Audit one guard.
 *
 * The guard is mutated IN PLACE and restored from the original bytes in a
 * `finally`, with the restore verified. Copying the tree instead was rejected:
 * several self-tests assert against real repository state, so a copy changes
 * what is being measured.
 */
export function auditGuard({ guardPath, testPath, rootDir, onProgress = () => {} }) {
  const original = readFileSync(guardPath, 'utf-8');
  const sites = enumerateSites(original);
  const name = basename(guardPath);

  if (sites.length === 0) {
    // #63: "all clean" and "there is nothing here" must not render identically.
    return { name, status: 'no-sites', sites: [], results: [] };
  }

  const baseline = runSelfTest(testPath, rootDir);
  if (baseline.code !== 0) {
    // "Red under mutation" is meaningless without a green baseline.
    return {
      name,
      status: 'cannot-check',
      reason: `baseline self-test is not green (exit ${baseline.code})`,
      sites,
      results: [],
    };
  }
  const baselineFailures = new Set(failingAssertions(baseline.out));

  const results = [];
  let probe = null;
  try {
    for (const [i, site] of sites.entries()) {
      onProgress(`${name} ${i + 1}/${sites.length} (line ${site.line}, ${site.kind})`);
      writeFileSync(guardPath, applyMutations(original, [site]), 'utf-8');

      const parsed = runNodeCheck(guardPath);
      if (!parsed.ok) {
        // TRAP 1, INVERTED. A broken file reddens the self-test and would
        // record as WITNESSED. This is an audit error, never a pass.
        results.push({ ...site, verdict: 'unparseable', detail: parsed.out.trim().split('\n')[0] ?? '' });
        continue;
      }

      const run = runSelfTest(testPath, rootDir);
      const newly = failingAssertions(run.out).filter((a) => !baselineFailures.has(a));
      results.push({
        ...site,
        verdict: run.code === 0 ? 'unwitnessed' : 'witnessed',
        newlyFailing: newly,
        namesAvailable: newly.length > 0 || run.code === 0,
      });
    }

    // THE COMPLETENESS PROBE. See `interpretProbe` for why the polarity here is
    // not the one #428's review states.
    onProgress(`${name} completeness probe`);
    writeFileSync(guardPath, applyMutations(original, sites), 'utf-8');
    const parsedAll = runNodeCheck(guardPath);
    if (!parsedAll.ok) {
      probe = { status: 'unparseable', detail: parsedAll.out.trim().split('\n')[0] ?? '' };
    } else {
      const all = runSelfTest(testPath, rootDir);
      probe = {
        status: all.code === 0 ? 'no-failure-witnesses' : 'ok',
        exitCode: all.code,
        failing: failingAssertions(all.out).filter((a) => !baselineFailures.has(a)),
        reached: reachedAssertions(all.out),
      };
    }
  } finally {
    writeFileSync(guardPath, original, 'utf-8');
    const restored = readFileSync(guardPath, 'utf-8');
    if (restored !== original) {
      throw new Error(`RESTORE FAILED for ${guardPath} — the working tree is dirty and must be checked by hand`);
    }
  }

  return { name, status: 'measured', sites, results, probe };
}

/**
 * What the all-sites probe means — and a DELIBERATE DEVIATION from #428's
 * review, flagged rather than silently implemented.
 *
 * The review says: neutralise every known site simultaneously, and "self-test
 * goes fully green" means the enumeration is complete.
 *
 * **That polarity cannot be right, and it inverts the signal.** With every
 * failure route neutralised the guard can no longer exit non-zero, so every
 * self-test case asserting a rejection MUST fail. Fully green is therefore not
 * achievable for any self-test that witnesses anything — and if it IS achieved,
 * it means no case in that self-test depends on the guard failing at all, which
 * is alarming rather than reassuring.
 *
 * So the reading is inverted here:
 *
 *   red   -> expected. The guard's rejections are witnessed by something.
 *   green -> `no-failure-witnesses`. Nothing in this self-test observes a
 *            failure. Reported loudly.
 *
 * The review's INTENT — catch a failure route the enumeration does not know
 * about — is kept via `unknownPathSuspected`: if a single-site mutation reddens
 * an assertion that the all-sites mutation leaves green, the two disagree about
 * what causes that assertion to fail, which is the signature of a route outside
 * the enumeration.
 */
export function interpretProbe(guard) {
  if (guard.probe === null || guard.probe === undefined) return [];
  const notes = [];
  if (guard.probe.status === 'unparseable') {
    notes.push(`${guard.name}: all-sites mutation does not parse — ${guard.probe.detail}`);
    return notes;
  }
  // NOTE what is deliberately NOT here: `no-failure-witnesses`. A self-test
  // that observes no failure at all is the aggregate of "every site in it is
  // unwitnessed" — the measurement stage 1 exists to produce, not an integrity
  // fault. Failing on it would break the rule that stage 1 never fails on
  // finding unwitnessed sites. It is reported via `noFailureWitnesses` instead.
  const probeFailing = new Set(guard.probe.failing ?? []);
  const probeReached = new Set(guard.probe.reached ?? []);
  for (const r of guard.results) {
    if (r.verdict !== 'witnessed') continue;
    // An assertion counts as contradicting the probe only if the probe RAN it
    // and it passed. One the probe never reached is inconclusive, not evidence.
    const orphaned = (r.newlyFailing ?? []).filter((a) => probeReached.has(a) && !probeFailing.has(a));
    if (orphaned.length > 0) {
      notes.push(
        `${guard.name} line ${r.line}: ${JSON.stringify(orphaned[0])} reddens for this site alone but ` +
          `not when every site is neutralised — a failure route outside the enumeration is suspected`,
      );
    }
  }
  return notes;
}

/** Non-test scripts, and the self-test beside each (or null). */
export function discoverGuards(rootDir) {
  const dir = join(rootDir, SCRIPTS_REL);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .sort()
    .map((f) => {
      const testName = `${f.slice(0, -'.mjs'.length)}.test.mjs`;
      const testPath = join(dir, testName);
      return {
        name: f,
        guardPath: join(dir, f),
        testPath: existsSync(testPath) ? testPath : null,
      };
    });
}

export function renderInventory(report) {
  const lines = [];
  lines.push('# Mutation-audit inventory (#428 stage 1)');
  lines.push('');
  lines.push('Generated by `.github/scripts/check-mutation-audit.mjs`. **Report-only.**');
  lines.push('A site is WITNESSED when neutralising it turns its guard\'s self-test red —');
  lines.push('witnessed *relative to what that self-test exercises*, which is the honest limit.');
  lines.push('');
  lines.push(`- measured guards: **${report.totals.guards}**`);
  lines.push(`- failure sites: **${report.totals.sites}**`);
  lines.push(`- witnessed: **${report.totals.witnessed}**`);
  lines.push(`- unwitnessed: **${report.totals.unwitnessed}**`);
  lines.push(`- unreachable (no self-test, #431): **${report.totals.unreachableSites}** sites across ${report.totals.unreachable} scripts`);
  lines.push(`- cannot check (non-green baseline): **${report.totals.cannotCheck}** scripts`);
  lines.push('');
  lines.push('| script | sites | witnessed | unwitnessed | status |');
  lines.push('|---|---|---|---|---|');
  for (const g of report.guards) {
    const w = g.results.filter((r) => r.verdict === 'witnessed').length;
    const u = g.results.filter((r) => r.verdict === 'unwitnessed').length;
    lines.push(`| \`${g.name}\` | ${g.sites.length} | ${w} | ${u} | ${g.status} |`);
  }
  lines.push('');
  if (report.unwitnessed.length > 0) {
    lines.push('## Unwitnessed sites');
    lines.push('');
    lines.push('Neutralising these changed nothing their self-test could see.');
    lines.push('');
    lines.push('| script | line | kind |');
    lines.push('|---|---|---|');
    for (const u of report.unwitnessed) lines.push(`| \`${u.name}\` | ${u.line} | ${u.kind} |`);
    lines.push('');
  }
  if ((report.noFailureWitnesses ?? []).length > 0) {
    lines.push('## Self-tests that observe no failure at all');
    lines.push('');
    lines.push('With EVERY failure site in these neutralised, the self-test stays green — so');
    lines.push('nothing in it depends on the guard failing. This is the aggregate of "every');
    lines.push('site here is unwitnessed", reported rather than failed, because it is the');
    lines.push('measurement and not an integrity fault.');
    lines.push('');
    for (const n of report.noFailureWitnesses) lines.push(`- \`${n}\``);
    lines.push('');
  }
  if (report.unreachable.length > 0) {
    lines.push('## Unreachable — failure sites with no self-test (#431)');
    lines.push('');
    lines.push('Reported rather than omitted: there is nothing here to turn red, so no');
    lines.push('re-keying of this audit reaches them. Separately owned by #431.');
    lines.push('');
    lines.push('| script | sites |');
    lines.push('|---|---|');
    for (const r of report.unreachable) lines.push(`| \`${r.name}\` | ${r.sites} |`);
    lines.push('');
  }
  lines.push('---');
  lines.push('*Operum Engineer · [operum.ai](https://operum.ai)*');
  return `${lines.join('\n')}\n`;
}

export function audit(rootDir, { onProgress = () => {} } = {}) {
  const guards = discoverGuards(rootDir);
  const errors = [];
  const measured = [];
  const unreachable = [];
  let noSites = 0;

  for (const g of guards) {
    if (g.testPath === null) {
      const sites = enumerateSites(readFileSync(g.guardPath, 'utf-8'));
      if (sites.length > 0) unreachable.push({ name: g.name, sites: sites.length });
      else noSites += 1;
      continue;
    }
    const result = auditGuard({ ...g, rootDir, onProgress });
    if (result.status === 'no-sites') { noSites += 1; continue; }
    measured.push(result);
  }

  // #63 — refuse to render "all clean" and "nothing here" identically.
  if (measured.length === 0) {
    errors.push('no guard produced a single failure site — the enumeration is broken, not the tree clean');
  }

  const unwitnessed = [];
  const noFailureWitnesses = [];
  for (const g of measured) {
    if (g.probe?.status === 'no-failure-witnesses') noFailureWitnesses.push(g.name);
    for (const r of g.results) {
      if (r.verdict === 'unparseable') {
        errors.push(`${g.name} line ${r.line}: mutation does not parse — ${r.detail}`);
      } else if (r.verdict === 'unwitnessed') {
        unwitnessed.push({ name: g.name, line: r.line, kind: r.kind });
      }
    }
    if (g.status === 'cannot-check') {
      errors.push(`${g.name}: CANNOT CHECK — ${g.reason}`);
    }
    errors.push(...interpretProbe(g).map((n) => `unknown failure path: ${n}`));
  }

  const totals = {
    guards: measured.length,
    sites: measured.reduce((n, g) => n + g.sites.length, 0),
    witnessed: measured.reduce((n, g) => n + g.results.filter((r) => r.verdict === 'witnessed').length, 0),
    unwitnessed: unwitnessed.length,
    unreachable: unreachable.length,
    unreachableSites: unreachable.reduce((n, r) => n + r.sites, 0),
    cannotCheck: measured.filter((g) => g.status === 'cannot-check').length,
    noSites,
  };

  return { guards: measured, unreachable, unwitnessed, noFailureWitnesses, errors, totals };
}

function main(argv) {
  const args = argv.slice(2).filter((a) => a !== '--write');
  const write = argv.includes('--write');
  const root = resolve(args[0] ?? '.');

  const report = audit(root, { onProgress: (m) => process.stderr.write(`  ... ${m}\n`) });

  console.log(renderInventory(report));

  if (write) {
    writeFileSync(join(root, INVENTORY_REL), renderInventory(report), 'utf-8');
    console.log(`wrote ${INVENTORY_REL}`);
  }

  if (report.errors.length > 0) {
    console.error(`\ncheck-mutation-audit: ${report.errors.length} AUDIT-INTEGRITY problem(s)\n`);
    for (const e of report.errors) console.error(`  - ${e}`);
    console.error('\nStage 1 fails only on its own integrity — never on finding unwitnessed');
    console.error('sites, which are the measurement it exists to produce.');
    return 1;
  }

  console.log(
    `check-mutation-audit: OK — ${report.totals.witnessed}/${report.totals.sites} sites witnessed, ` +
      `${report.totals.unwitnessed} unwitnessed (reported, not failed).`,
  );
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exit(main(process.argv));
}
