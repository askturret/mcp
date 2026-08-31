#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Prose asserting external platform state, with something that notices when it
 * changes (#535).
 *
 * ADR-022 said the organisation was on the FREE plan and the repository was
 * PRIVATE. Both were true when written. Both became false on 2026-08-30 when
 * the repository went public. Nobody touched the file, no test reddened, no
 * guard complained, and it was four days from being read as current fact by
 * whoever opened it next. The wording fix repairs that instance; this repairs
 * the class.
 *
 * ## THE BOUND — read this before citing the guard (#535, Architect ruling)
 *
 *   This mechanism cannot make anyone DECLARE a claim. It can only stop a
 *   DECLARED claim from silently going stale.
 *
 * Detecting "this sentence asserts something about platform state" in arbitrary
 * prose is not decidable — the same wall as detecting a decorative assertion. A
 * new claim, written into a new file, with no block, is invisible here. That is
 * acceptable because it is not the failure that occurred: #330's claim WAS
 * written and DID go stale. But "platform claims are guarded" must not be read
 * as more than this sentence says, because reading a guard as broader than it is
 * is this family's signature defect.
 *
 * ## Two parts, split by DETERMINISM rather than by concern
 *
 * PART A - declaration integrity. Default mode. In CI, blocking, OFFLINE.
 *   Checks the DECLARATIONS, never the world: every registered site carries a
 *   well-formed block, every property is drawn from the closed vocabulary
 *   below, and every declared tag matches that vocabulary's own classification
 *   so a checkable claim cannot be quietly downgraded to avoid checking it.
 *   Bidirectional (#428): a registered file with no block fails, AND a block in
 *   an unregistered file fails. Without the second direction the registry goes
 *   stale silently, which is the decay this repository has already hit twice.
 *   No network, no credentials, no flakiness — so it can fail closed without
 *   reservation.
 *
 * PART B - divergence detection. `--live`. SCHEDULED, networked, out of the PR
 *   path. Reads live platform state, compares, and fails the scheduled run on
 *   divergence, naming the file and the specific claim.
 *
 * ## Why the live read is NOT in the PR path
 *
 * Put it there and the trilemma has no good corner: cannot-read -> fail reddens
 * every PR on a GitHub API outage (a red nobody can clear); cannot-read -> pass
 * is "could not check" resolving as "it passed", the exact #281 violation this
 * guard exists to prevent; cannot-read -> warn is the same thing wearing a
 * different word. `tag-readiness-advisory.yml` already ruled on this shape: a
 * red X on something nothing actually refused is "an overclaim in the other
 * direction". Off the PR path, an outage delays detection by a day instead.
 *
 * ## Exit codes, and WHICH PATH each one runs in
 *
 * Recorded next to the code deliberately, because the two paths want opposite
 * things and the distinction is easy to reverse:
 *
 *   Part A (PR path)      0 pass, 1 a declaration is malformed/stale-by-shape.
 *                         NEVER 2 — Part A reads only local files, so it has no
 *                         cannot-check state. An exit 2 here would redden every
 *                         PR at creation, which is the corner ruled out above.
 *
 *   Part B (SCHEDULED)    0 pass, 1 divergence, 2 CANNOT CHECK. Exit 2 is
 *                         CORRECT here and only here: it reddens a nightly job
 *                         and blocks nothing. Do not "fix" it into a pass, and
 *                         do not copy it into the PR path.
 *
 * Precedence when both occur in one run: divergence (1) outranks cannot-check
 * (2), because a divergence is a CONFIRMED falsehood while a cannot-check is an
 * unknown. Both are always PRINTED regardless of which code is returned — the
 * exit code narrows to one number, the report must not.
 *
 * Run:
 *   node .github/scripts/check-platform-claims.mjs [rootDir]           # Part A
 *   node .github/scripts/check-platform-claims.mjs [rootDir] --live    # Part B
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The CLOSED vocabulary of platform properties.
 *
 * Closed is what makes the guard honest: a claim about a property not in this
 * list is REFUSED at declaration time, so the guard can never imply coverage it
 * does not have.
 *
 * `declared-unverifiable` is load-bearing and must NOT be optimised away.
 * #330's most important claim — that the author is an `always` bypass actor —
 * lives in it. Dropping unverifiable properties from the block would leave that
 * claim undeclared, reproducing the original defect INSIDE the mechanism built
 * to prevent it.
 */
export const VOCABULARY = Object.freeze({
  repository_visibility: Object.freeze({
    classification: 'verifiable',
    source: 'GET /repos/{owner}/{repo} -> .visibility',
  }),
  organisation_plan: Object.freeze({
    classification: 'verifiable',
    source: 'GET /orgs/{org} -> .plan.name',
    // READABLE ONLY WITH AN ORG-SCOPED CREDENTIAL. Measured 2026-08-31:
    // unauthenticated, `plan` is ABSENT from the response entirely. So this
    // property is verifiable in principle and may be CANNOT CHECK in practice,
    // depending on what the scheduled job's token can see. That is exactly what
    // exit 2 is for; it must never degrade to a pass on a missing field.
  }),
  code_owner_review_required: Object.freeze({
    classification: 'declared-unverifiable',
    reason:
      'Reading it needs `GET /repos/{owner}/{repo}/rulesets/{id}`, which requires admin ' +
      'credentials CI does not hold; ruleset reads return 403 on this repository.',
  }),
  author_is_bypass_actor: Object.freeze({
    classification: 'declared-unverifiable',
    reason:
      'The bypass-actor list needs the same admin credentials, and WHO WILL AUTHOR THE NEXT PR ' +
      'is not knowable at all — no credential makes a future fact readable.',
  }),
});

/**
 * Files expected to carry a declaration block.
 *
 * Half of a BIDIRECTIONAL contract: a file here without a block fails, and a
 * block in a file NOT here fails. One direction alone lets the registry rot.
 */
export const REGISTERED_SITES = Object.freeze([
  'docs/adr/ADR-022-concealment-allowlist-is-evidence-bound.md',
  'docs/ownership.md',
]);

export const BLOCK_OPEN = '<!-- platform-claims';
export const BLOCK_CLOSE = '-->';

/** Directories never walked when looking for stray blocks. */
const SKIP_DIRS = Object.freeze(['node_modules', '.git', 'dist', 'coverage', 'build']);

/**
 * `property: value (tag)` — one claim per line inside a block.
 *
 * The tag is written out even though the vocabulary already knows it. That is
 * not redundancy: Part A asserts the two AGREE, which is what stops someone
 * relabelling a verifiable claim as `declared-unverifiable` to get it out of
 * Part B's comparison. A silent downgrade is the cheapest way to defeat this
 * guard, so it is the one Part A is built to catch.
 */
const CLAIM_RE = /^([a-z_]+):\s*(\S+)\s*\(([a-z-]+)\)\s*$/;

/** Every `.md` file under `rootDir`, excluding build and vendor trees. */
export function markdownFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is not a claim site
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.includes(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(relative(rootDir, join(dir, e.name)).split(sep).join('/'));
      }
    }
  };
  walk(rootDir);
  return out.sort();
}

/**
 * Parse the declaration block out of a document.
 *
 * Returns `{ found, claims, errors }`. `found: false` with no errors means the
 * file simply carries no block — which is a failure only for a REGISTERED file,
 * and that judgement belongs to the caller, not here.
 */
export function parseBlock(text) {
  const openIdx = text.indexOf(BLOCK_OPEN);
  if (openIdx === -1) return { found: false, claims: [], errors: [] };

  const rest = text.slice(openIdx + BLOCK_OPEN.length);
  const closeIdx = rest.indexOf(BLOCK_CLOSE);
  if (closeIdx === -1) {
    return {
      found: true,
      claims: [],
      errors: [`the block opens with \`${BLOCK_OPEN}\` and is never closed with \`${BLOCK_CLOSE}\``],
    };
  }

  // A SECOND block is refused rather than merged. Two blocks in one file means
  // two answers to "what does this file depend on", and picking one silently is
  // how a stale half survives next to a fresh half.
  if (text.indexOf(BLOCK_OPEN, openIdx + BLOCK_OPEN.length) !== -1) {
    return { found: true, claims: [], errors: ['more than one declaration block in the same file'] };
  }

  const body = rest.slice(0, closeIdx);
  const claims = [];
  const errors = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const m = CLAIM_RE.exec(line);
    if (m === null) {
      errors.push(`unparseable claim line ${JSON.stringify(line)} — expected \`property: value (tag)\``);
      continue;
    }
    claims.push({ property: m[1], value: m[2], tag: m[3] });
  }
  if (claims.length === 0 && errors.length === 0) errors.push('the declaration block is empty');
  return { found: true, claims, errors };
}

/**
 * PART A. Declaration integrity — offline, deterministic, PR path.
 *
 * Makes no network call by construction: nothing in this function or anything
 * it calls performs I/O beyond `readFileSync`/`readdirSync`. The self-test
 * asserts that rather than trusting this sentence.
 */
export function checkDeclarations({ rootDir, sites = REGISTERED_SITES, vocabulary = VOCABULARY }) {
  const problems = [];
  const registered = new Set(sites);

  for (const rel of sites) {
    const abs = join(rootDir, rel);
    if (!existsSync(abs)) {
      problems.push(`${rel}: registered as a platform-claim site, but the file does not exist`);
      continue;
    }
    const parsed = parseBlock(readFileSync(abs, 'utf-8'));
    if (!parsed.found) {
      problems.push(
        `${rel}: registered as a platform-claim site but carries no \`${BLOCK_OPEN}\` block. ` +
          'Either declare what this file depends on, or remove it from the registry.',
      );
      continue;
    }
    for (const e of parsed.errors) problems.push(`${rel}: ${e}`);

    const seen = new Set();
    for (const c of parsed.claims) {
      const spec = vocabulary[c.property];
      if (spec === undefined) {
        problems.push(
          `${rel}: \`${c.property}\` is not in the closed vocabulary ` +
            `(${Object.keys(vocabulary).join(', ')}). A claim about an unlisted property would ` +
            'imply coverage this guard does not have.',
        );
        continue;
      }
      if (seen.has(c.property)) {
        problems.push(`${rel}: \`${c.property}\` is declared twice`);
      }
      seen.add(c.property);
      if (c.tag !== spec.classification) {
        problems.push(
          `${rel}: \`${c.property}\` is tagged \`${c.tag}\` but the vocabulary classifies it as ` +
            `\`${spec.classification}\`. A verifiable claim relabelled as unverifiable would drop ` +
            'silently out of the live comparison, which is the cheapest way to defeat this guard.',
        );
      }
    }
  }

  // THE SECOND DIRECTION (#428). Without it the registry goes stale silently:
  // someone adds a block to a new file, nothing checks it, and the file reads as
  // guarded while nothing is watching it — the exact property this guard exists
  // to remove, reproduced inside the guard.
  for (const rel of markdownFiles(rootDir)) {
    if (registered.has(rel)) continue;
    if (readFileSync(join(rootDir, rel), 'utf-8').includes(BLOCK_OPEN)) {
      problems.push(
        `${rel}: carries a \`${BLOCK_OPEN}\` block but is not in REGISTERED_SITES, so nothing ` +
          'compares it against live state. Register it, or remove the block.',
      );
    }
  }

  return { code: problems.length === 0 ? 0 : 1, problems };
}

/**
 * The default live reader. The ONLY networked code in this file.
 *
 * Returns `{ values, unreadable }` rather than throwing, so a property that
 * cannot be read is a DATUM the caller reports rather than an exception that
 * loses which property failed.
 */
export async function readLiveState({ owner = 'askturret', repo = 'mcp', token = process.env['GITHUB_TOKEN'] } = {}) {
  const values = {};
  const unreadable = [];
  const headers = {
    'user-agent': 'check-platform-claims',
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  const get = async (url) => {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return r.json();
  };

  try {
    const j = await get(`https://api.github.com/repos/${owner}/${repo}`);
    if (typeof j.visibility === 'string') values['repository_visibility'] = j.visibility;
    else unreadable.push({ property: 'repository_visibility', reason: 'the repository payload carried no `visibility` field' });
  } catch (e) {
    unreadable.push({ property: 'repository_visibility', reason: e.message });
  }

  try {
    const j = await get(`https://api.github.com/orgs/${owner}`);
    // A MISSING `plan` IS CANNOT CHECK, NEVER A PASS. Unauthenticated — and
    // possibly with a repo-scoped Actions token — the field is absent
    // altogether. Treating absence as agreement is the #281 defect verbatim.
    if (j.plan && typeof j.plan.name === 'string') values['organisation_plan'] = j.plan.name;
    else {
      unreadable.push({
        property: 'organisation_plan',
        reason: 'the organisation payload carried no `plan` field — the credential in use cannot see it',
      });
    }
  } catch (e) {
    unreadable.push({ property: 'organisation_plan', reason: e.message });
  }

  return { values, unreadable };
}

/**
 * PART B. Divergence detection — networked, SCHEDULED path.
 *
 * `readState` is injected so the self-test can witness both arms — divergence
 * and cannot-check — deterministically and offline. A self-test that had to
 * reach the network to exercise the cannot-check arm would be flaky in exactly
 * the conditions that arm exists for, and #535 names that arm as the one most
 * likely to be written and never exercised.
 */
export async function checkLive({ rootDir, sites = REGISTERED_SITES, vocabulary = VOCABULARY, readState = readLiveState }) {
  const divergences = [];
  const cannotCheck = [];
  const declaredUnverifiable = [];

  const { values, unreadable } = await readState();
  const unreadableBy = new Map(unreadable.map((u) => [u.property, u.reason]));

  for (const rel of sites) {
    const abs = join(rootDir, rel);
    if (!existsSync(abs)) {
      cannotCheck.push(`${rel}: registered, but the file does not exist — nothing to compare`);
      continue;
    }
    const parsed = parseBlock(readFileSync(abs, 'utf-8'));
    if (!parsed.found) {
      cannotCheck.push(`${rel}: no declaration block — Part A is what fails this; Part B cannot compare it`);
      continue;
    }
    for (const c of parsed.claims) {
      const spec = vocabulary[c.property];
      if (spec === undefined) continue; // Part A owns vocabulary violations
      if (spec.classification === 'declared-unverifiable') {
        // NOT silently skipped. It is reported as declared-and-unchecked, so the
        // run says out loud which claims nothing verified.
        declaredUnverifiable.push(`${rel}: \`${c.property}\` = ${c.value} — declared, not verified. ${spec.reason}`);
        continue;
      }
      if (unreadableBy.has(c.property)) {
        cannotCheck.push(`${rel}: \`${c.property}\` could not be read — ${unreadableBy.get(c.property)}`);
        continue;
      }
      const live = String(values[c.property]);
      if (live !== c.value) {
        divergences.push(
          `${rel}: \`${c.property}\` is declared \`${c.value}\` but live platform state reads ` +
            `\`${live}\`. The prose in this file depending on that claim is now false.`,
        );
      }
    }
  }

  return { code: divergences.length > 0 ? 1 : cannotCheck.length > 0 ? 2 : 0, divergences, cannotCheck, declaredUnverifiable };
}

export async function main(argv) {
  const args = argv.slice(2);
  const live = args.includes('--live');
  const rootDir = resolve(args.find((a) => !a.startsWith('--')) ?? '.');

  if (!live) {
    const { code, problems } = checkDeclarations({ rootDir });
    if (code === 0) {
      console.log(
        `check-platform-claims: OK — ${REGISTERED_SITES.length} registered site(s), every declared ` +
          `property in the closed vocabulary and correctly classified.`,
      );
      return 0;
    }
    for (const p of problems) console.error(`  ${p}`);
    console.error(`\n::error::${problems.length} platform-claim declaration problem(s).`);
    return 1;
  }

  const { code, divergences, cannotCheck, declaredUnverifiable } = await checkLive({ rootDir });
  for (const d of declaredUnverifiable) console.log(`  declared-unverifiable — ${d}`);
  for (const c of cannotCheck) console.error(`  CANNOT CHECK — ${c}`);
  for (const d of divergences) console.error(`  DIVERGENCE — ${d}`);

  if (code === 1) {
    console.error(`\n::error::${divergences.length} platform claim(s) diverge from live state.`);
    return 1;
  }
  if (code === 2) {
    // EXIT 2 IS CORRECT HERE AND ONLY HERE. This runs on a schedule, so it
    // reddens a nightly job and blocks nothing. "Could not check" is never
    // "passed" (#281) — do not turn this into a 0, and do not copy it into the
    // PR path, where it would redden every PR at creation.
    console.error(`\n::error::CANNOT CHECK — ${cannotCheck.length} claim(s) could not be verified.`);
    return 2;
  }
  console.log('check-platform-claims: OK — every verifiable claim matches live platform state.');
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exit(await main(process.argv));
}
