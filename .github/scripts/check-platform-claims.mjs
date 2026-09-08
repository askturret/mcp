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
import { isProcessEntryPoint } from './lib/entry-point.mjs';

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
    classification: 'declared-unverifiable',
    reason:
      'Reading it needs `GET /orgs/{org}` -> `.plan.name`, which GitHub returns only to an ' +
      'organisation OWNER. The Actions `GITHUB_TOKEN` is a repository-scoped installation token, ' +
      'and no workflow `permissions:` block exposes an organisation scope at all — so the field ' +
      'is absent from an otherwise-200 response rather than producing an error.',
    // RECLASSIFIED FROM `verifiable`, ON A MEASUREMENT OF THE JOB'S OWN
    // CREDENTIAL (#784).
    //
    // The previous classification was not careless, and it is worth being exact
    // about what was wrong with it. It recorded an UNAUTHENTICATED read showing
    // `plan` absent, and concluded the property was "verifiable in principle and
    // may be CANNOT CHECK in practice, depending on what the scheduled job's
    // token can see". Every word of that was true. The missing step was that
    // nobody had ever asked the scheduled job's token.
    //
    // An unauthenticated read is a PROXY for "holds no admin", not an exercise
    // of the credential, and it could not settle this on its own: the two
    // resources have DIFFERENT PERMISSION MODELS, so an org's `plan` might have
    // been readable by a member token where a repo's `security_and_analysis` is
    // admin-only. Reasoning from one to the other — in either direction — is
    // what produced the original classification.
    //
    // MEASURED 2026-09-08 by exercising `secrets.GITHUB_TOKEN` from a pushed
    // workflow on this repository, which is the SAME credential
    // `reliability-nightly.yml`'s `platform-claims` job passes to this guard:
    //
    //     GET /orgs/askturret                -> 200, 24 keys, `plan` ABSENT
    //     GET /repos/askturret/mcp           -> 200, `visibility` present,
    //                                           `security_and_analysis` ABSENT
    //     GET .../automated-security-fixes   -> 403
    //
    // The run's own log reported the token's scopes as `Contents: read`,
    // `Metadata: read`, `Packages: read`.
    //
    // The org response carries 24 keys — identical to what an anonymous caller
    // sees. So this is the `code_owner_review_required` case rather than the
    // "depends on the token" case: no `permissions:` block can widen it, which
    // makes it CLOSED rather than token-dependent.
    //
    // TO UPGRADE THIS TO `verifiable`, the job needs an org-owner credential — a
    // PAT or App token in `secrets`, not the Actions token. Then move the
    // classification, add the read back to `readLiveState`, and the divergence
    // arm starts working. Same escape hatch as `dependabot_security_updates`,
    // and for the same reason.
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
  dependabot_security_updates: Object.freeze({
    classification: 'declared-unverifiable',
    reason:
      'Both surfaces that expose it — `GET /repos/{owner}/{repo} -> .security_and_analysis' +
      '.dependabot_security_updates.status` and `GET /repos/{owner}/{repo}/automated-security-fixes` ' +
      '— require ADMIN READ ACCESS, which the Actions `GITHUB_TOKEN` cannot hold: there is no ' +
      '`administration` scope in a workflow `permissions:` block at all.',
    // CLASSIFIED `declared-unverifiable` DELIBERATELY, AGAINST THE FIRST READING (#677).
    //
    // #677 was filed expecting `verifiable`, on the ground that the property is
    // readable from the repository payload. It IS readable — but only by an
    // ADMIN credential, and the question this classification answers is not "can
    // it be read?" but "can the SCHEDULED JOB read it?"
    //
    // MEASURED 2026-09-08, four ways:
    //   - authenticated with an admin token: `security_and_analysis` present,
    //     `dependabot_security_updates.status = "enabled"`;
    //   - UNAUTHENTICATED: the `security_and_analysis` block is ABSENT ENTIRELY
    //     while `visibility` is still present, so absence is the documented
    //     under-privileged shape rather than a transport failure;
    //   - GitHub's own docs on both endpoints: "must have admin read access";
    //   - and, added by #784, WITH THE SCHEDULED JOB'S OWN `secrets.GITHUB_TOKEN`
    //     exercised from a pushed workflow: `GET /repos/askturret/mcp` returns
    //     200 with `visibility` present and `security_and_analysis` ABSENT, and
    //     `GET .../automated-security-fixes` returns 403.
    //
    // That fourth measurement is the one that matters, and it was missing until
    // #784. QA named the gap explicitly when this was classified: "I did NOT
    // establish that the workflow token cannot read it; only that an unprivileged
    // read does not." The first three are all proxies for the credential; only
    // the fourth exercises it. The classification was right, but it is only now
    // EVIDENCED rather than inferred.
    //
    // WHY THAT FORCES THIS CLASSIFICATION RATHER THAN `verifiable`. The two
    // classifications are separated by ONE question, and #784 changed what
    // answers it: does the SCHEDULED JOB'S OWN CREDENTIAL read the property —
    // MEASURED, not reasoned?
    //
    //   `verifiable` example: `repository_visibility` — the job reads it, 200
    //     with `visibility` present. THE LINE ABOVE IS MACHINE-CHECKED: the
    //     self-test extracts that property name and asserts the vocabulary really
    //     classifies it `verifiable`. Keep it on one line. It exists because the
    //     sentence it replaces named a property that this very PR reclassified,
    //     and stayed green (#802, QA).
    //   `declared-unverifiable`: this entry, and every other in this vocabulary
    //     carrying a `reason` — each needs a credential no `permissions:` block
    //     can grant. Deliberately NOT enumerated here: the membership is pinned
    //     exactly, by name, in the self-test, and a second hand-maintained copy
    //     is the thing that just went stale.
    //
    // THIS PARAGRAPH USED TO ASK A WEAKER QUESTION — whether the credential could
    // EVER suffice — and it named `organisation_plan` as the `verifiable` side,
    // because that property MIGHT be readable depending on the token. #784
    // measured it: it is not, so it now sits in the class below, and that example
    // is gone rather than replaced.
    //
    // THE TOKEN-DEPENDENT SIDE HAS NO EXAMPLE ON PURPOSE. An aspirational
    // `verifiable` — "we think a token could read this" — is precisely what #784
    // cost, and `checkLive`'s misclassification audit now reports one as a
    // divergence for any property the job actually reads. So do not reintroduce
    // "might be readable" as a reason to classify something `verifiable`: measure
    // it, and if the job cannot read it, it belongs here with a reason.
    //
    // WHAT THE AUDIT DOES NOT COVER, recorded so nobody leans on it further than
    // it reaches (QA, #802): it needs an `absent-field` entry in `unreadable`, so
    // it is silent for a property classified `verifiable` that `readLiveState`
    // never reads. Flipping a classification WITHOUT restoring the read — the
    // likelier half of the mistake — is caught by the naming pins in
    // `check-platform-claims.test.mjs`, not here. Those pins are the protection;
    // do not weaken them on the strength of this audit existing.
    //
    // AND THE COST OF GETTING IT WRONG IS NOT SYMMETRIC. `repository_visibility`
    // is the ONLY `verifiable` property in this vocabulary, so the nightly's
    // platform-claims job runs GREEN. Declaring this one `verifiable` would make
    // it CANNOT CHECK on every run, permanently — exit 2 forever, with no path
    // to green and no way to distinguish it from a real unreadability. That
    // trades a working signal for a standing alarm, which is the failure mode
    // this repository keeps naming: an alarm that is never a true positive is
    // one the reader learns to skim.
    //
    // TO UPGRADE THIS TO `verifiable`, the scheduled job needs a credential with
    // admin read — a PAT or App token in `secrets`, not the Actions token. At
    // that point move the classification, add the read to `readLiveState`, and
    // the divergence arm starts working. Nothing else here needs to change.
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
    // A MISSING FIELD IS CANNOT CHECK, NEVER A PASS. Treating absence as
    // agreement is the #281 defect verbatim.
    if (typeof j.visibility === 'string') values['repository_visibility'] = j.visibility;
    else {
      unreadable.push({
        property: 'repository_visibility',
        kind: 'absent-field',
        reason: 'the repository payload carried no `visibility` field',
      });
    }
  } catch (e) {
    unreadable.push({ property: 'repository_visibility', kind: 'transport', reason: e.message });
  }

  // NO ORGANISATION READ. `organisation_plan` is `declared-unverifiable` since
  // #784, and every other property in that class is likewise not fetched here —
  // a read whose result can never be compared is a nightly API call that cannot
  // inform anything. Restore it in the same commit that reclassifies the
  // property back to `verifiable`, never before.

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

  // THE CLASSIFICATION IS ITSELF A CLAIM, and until #784 nothing tested it.
  //
  // `verifiable` asserts that the credential THIS JOB HOLDS could read the
  // property. Nothing ever checked that assertion against the credential, and
  // #784 is what that cost: `organisation_plan` sat classified `verifiable` and
  // unreadable, silently, because it was DECLARED AT NO SITE — and the loop
  // below only ever visits declared claims.
  //
  // So this runs over the VOCABULARY, not over the declarations. That is the
  // whole point: an undeclared entry is a claim nobody has tested, and it stays
  // untested right up until someone declares it and inherits a permanently red
  // nightly that looks like their change broke. The cost lands on whoever does
  // the right thing next, which is the worst place to put it.
  //
  // ONLY `absent-field` COUNTS, and the distinction is load-bearing. A transport
  // failure means the read did not happen — an unknown, which belongs in
  // cannot-check. A 200 response with the field missing is the under-privileged
  // shape, and THAT is evidence about the credential. Conflating them would turn
  // every GitHub outage into a spurious "your vocabulary is wrong", which is the
  // standing-alarm failure this file already argues against elsewhere.
  const misclassified = [];
  for (const [property, spec] of Object.entries(vocabulary)) {
    if (spec.classification !== 'verifiable') continue;
    const u = unreadable.find((x) => x.property === property && x.kind === 'absent-field');
    if (u === undefined) continue;
    misclassified.push(
      `\`${property}\` is classified \`verifiable\`, but the credential this job holds cannot read it — ` +
        `${u.reason}. Give the job a credential that can, or reclassify it \`declared-unverifiable\` ` +
        `with a reason (#784).`,
    );
  }

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

  // A misclassification ranks with a divergence, not with a cannot-check: it is
  // a CONFIRMED falsehood about our own vocabulary, and unlike a missing
  // credential it has a path to green that costs one line.
  const confirmedFalse = divergences.length + misclassified.length;
  return {
    code: confirmedFalse > 0 ? 1 : cannotCheck.length > 0 ? 2 : 0,
    divergences,
    cannotCheck,
    declaredUnverifiable,
    misclassified,
  };
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

  const { code, divergences, cannotCheck, declaredUnverifiable, misclassified } = await checkLive({ rootDir });
  for (const d of declaredUnverifiable) console.log(`  declared-unverifiable — ${d}`);
  for (const c of cannotCheck) console.error(`  CANNOT CHECK — ${c}`);
  for (const m of misclassified) console.error(`  MISCLASSIFIED — ${m}`);
  for (const d of divergences) console.error(`  DIVERGENCE — ${d}`);

  if (code === 1) {
    const parts = [];
    if (divergences.length > 0) parts.push(`${divergences.length} platform claim(s) diverge from live state`);
    if (misclassified.length > 0) parts.push(`${misclassified.length} vocabulary entr(ies) misclassified \`verifiable\``);
    console.error(`\n::error::${parts.join('; ')}.`);
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

if (isProcessEntryPoint(import.meta.url)) {
  process.exit(await main(process.argv));
}
