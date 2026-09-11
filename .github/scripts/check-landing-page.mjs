#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * THE LANDING PAGE SAYS ONLY WHAT THE REPOSITORY CAN EVIDENCE (#860).
 *
 * `site/index.html` is the most visible surface this project owns, and it is the
 * one most likely to be edited by someone reaching for a stronger sentence. This
 * guard is what makes that safe.
 *
 * ## Three checks, and why each exists
 *
 * CHECK A — NO DRIFT FROM THE README. Every command line inside a `<pre>` on the
 * page must appear VERBATIM in README.md. The quick start was corrected three
 * times for 0.2.0 (#716, #717, #719); a second hand-maintained copy would start
 * rotting from the next correction onward, and nothing would report it. That is
 * the duplicate-fact class this repository keeps deleting.
 *
 * A block that genuinely has no README equivalent declares `data-page-only="…"`
 * with a REASON, inline on the element. Declared rather than pattern-excluded,
 * for the reason the version-literal registry gives: a block that is merely
 * skipped is indistinguishable from one nobody looked at. An empty or missing
 * reason does not count as a declaration.
 *
 * CHECK B — NO UNSOURCEABLE CLAIMS. Users, adopters, production deployments,
 * benchmarks and performance numbers are forbidden because the repository cannot
 * source a single one of them. This is matched on PHRASES rather than bare words
 * so that ordinary prose does not trip it — `\busers\b` alone would fire on "a
 * user of the CLI", which is not a claim about adoption.
 *
 * CHECK C — A PINNED VERSION CANNOT ROT. Any `@askturret/mcp-core@X.Y.Z` on the
 * page must equal `packages/core/package.json#version`. The verification command
 * is the differentiator of the trust section, and a pinned version that npm no
 * longer serves turns it into a 404 in front of exactly the reader it was for.
 * The 0.2.0 cut found THREE stale version strings across the docs tree; this is
 * the same defect, on the surface where it would be most expensive.
 *
 * ## Why it is exit-code-honest
 *
 * "Could not check" is never "it passed". A missing page, an unreadable README
 * or an unparseable manifest exits 2, distinct from the exit 1 that means a real
 * finding. Nothing here can pass by failing to look.
 *
 * Builtins only — no dependency, matching every other guard under this directory.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PAGE = 'site/index.html';
const README = 'README.md';
const CORE_MANIFEST = 'packages/core/package.json';

/**
 * Claim vocabulary the repository cannot source.
 *
 * Phrases, not bare words. Each carries the reason it is forbidden so a future
 * reader can tell a rule from a taboo — and so anyone who genuinely acquires the
 * evidence knows which claim they have just earned.
 */
const FORBIDDEN = [
  { re: /\b(?:trusted|used|adopted)\s+by\b/i, why: 'implies adopters; there are none to cite' },
  { re: /\b\d[\d,.]*\s*(?:\+\s*)?(?:users|developers|teams|companies|downloads)\b/i, why: 'an adoption count the repository cannot source' },
  { re: /\bour\s+(?:users|customers|adopters)\b/i, why: 'implies an existing user base' },
  { re: /\bin\s+production\s+(?:at|by)\b/i, why: 'implies a production deployment that cannot be named' },
  { re: /\bproduction[-\s]ready\b/i, why: 'a maturity claim; the project is pre-1.0 and says so' },
  { re: /\bproduction[-\s]grade\b/i, why: 'a maturity claim; the project is pre-1.0 and says so' },
  { re: /\bbattle[-\s]tested\b/i, why: 'implies production exposure that has not happened' },
  { re: /\benterprise[-\s]grade\b/i, why: 'a maturity claim with nothing behind it' },
  { re: /\bbenchmark(?:s|ed|ing)?\b/i, why: 'no benchmark exists in this repository' },
  { re: /\b(?:blazing|lightning)[-\s]fast\b/i, why: 'a performance claim with no measurement' },
  { re: /\b(?:\d+(?:\.\d+)?)\s*(?:x|times)\s+faster\b/i, why: 'a performance comparison with no measurement' },
  { re: /\bhigh[-\s]performance\b/i, why: 'a performance claim with no measurement' },
  { re: /\blow[-\s]latency\b/i, why: 'a performance claim with no measurement' },
  { re: /\bzero[-\s]overhead\b/i, why: 'a performance claim with no measurement' },
];

/**
 * Command lines worth asserting, extracted from one `<pre>` block.
 *
 * Blank lines and pure-comment lines are dropped: a comment is prose, and prose
 * is allowed to differ between a terminal walkthrough and a web page. What must
 * not differ is anything the reader would RUN.
 */
export function commandLines(blockText) {
  return blockText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith('#') && !l.startsWith('//'));
}

/** Decode the small set of entities a hand-written page can contain. */
export function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Every `<pre>` on the page, with its raw attributes and decoded text.
 *
 * A hand-rolled scan rather than an HTML parser, for the reason the path-filter
 * guard gives for its own: adding a dependency to this directory is a
 * supply-chain claim, and the input is a single file we control. The self-test
 * pins the shapes it must handle.
 */
export function extractPreBlocks(html) {
  const blocks = [];
  const re = /<pre([^>]*)>([\s\S]*?)<\/pre>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    const inner = (m[2] ?? '').replace(/<\/?code[^>]*>/g, '');
    const pageOnly = /data-page-only\s*=\s*"([^"]*)"/.exec(attrs);
    blocks.push({
      attrs,
      text: decodeEntities(inner),
      // A declaration needs a REASON. `data-page-only=""` is not a declaration.
      pageOnlyReason: pageOnly && pageOnly[1].trim().length > 0 ? pageOnly[1].trim() : null,
      declaredEmpty: Boolean(pageOnly) && (!pageOnly[1] || pageOnly[1].trim().length === 0),
    });
  }
  return blocks;
}

/** Forbidden-claim scan over the page's visible text. */
export function findForbiddenClaims(text) {
  const found = [];
  for (const { re, why } of FORBIDDEN) {
    const m = re.exec(text);
    if (m) found.push({ match: m[0], why });
  }
  return found;
}

/** Strip HTML comments and tags so checks read what a VISITOR reads. */
export function visibleText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

export function checkLandingPage(repoRoot) {
  const problems = [];
  const pagePath = join(repoRoot, PAGE);
  const readmePath = join(repoRoot, README);
  const manifestPath = join(repoRoot, CORE_MANIFEST);

  // Fail closed, and distinguishably: a missing input is exit 2, not a pass.
  for (const [label, p] of [[PAGE, pagePath], [README, readmePath], [CORE_MANIFEST, manifestPath]]) {
    if (!existsSync(p)) return { cannotCheck: `${label} does not exist at ${p}`, problems: [] };
  }

  let html, readme, manifest;
  try {
    html = readFileSync(pagePath, 'utf-8');
    readme = readFileSync(readmePath, 'utf-8');
  } catch (err) {
    return { cannotCheck: `could not read an input (${err?.message ?? err})`, problems: [] };
  }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return { cannotCheck: `${CORE_MANIFEST} is not parseable (${err?.message ?? err})`, problems: [] };
  }
  if (typeof manifest.version !== 'string') {
    return { cannotCheck: `${CORE_MANIFEST} has no string "version"`, problems: [] };
  }

  const readmeLines = new Set(readme.split('\n').map((l) => l.trim()));
  const blocks = extractPreBlocks(html);

  if (blocks.length === 0) {
    return { cannotCheck: `${PAGE} contains no <pre> block — the extractor matched nothing`, problems: [] };
  }

  // CHECK A — no drift from the README.
  let comparedBlocks = 0;
  let comparedLines = 0;
  for (const block of blocks) {
    if (block.declaredEmpty) {
      problems.push(
        `${PAGE}: a <pre> declares data-page-only with an EMPTY reason. A declaration without a reason ` +
          `is indistinguishable from one nobody looked at — state why the block has no README equivalent.`,
      );
      continue;
    }
    if (block.pageOnlyReason) continue;

    comparedBlocks++;
    for (const line of commandLines(block.text)) {
      comparedLines++;
      if (!readmeLines.has(line)) {
        problems.push(
          `${PAGE}: this command does not appear verbatim in ${README}:\n      ${line}\n` +
            `      Either correct it to match the README, or declare the block ` +
            `data-page-only="<reason>" if it genuinely has no README equivalent.`,
        );
      }
    }
  }

  // CHECK B — no unsourceable claims.
  for (const { match, why } of findForbiddenClaims(visibleText(html))) {
    problems.push(`${PAGE}: unsourceable claim "${match}" — ${why}.`);
  }

  // CHECK C — a pinned core version matches the manifest.
  const pins = [...html.matchAll(/@askturret\/mcp-core@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  for (const pin of pins) {
    if (pin !== manifest.version) {
      problems.push(
        `${PAGE}: pins @askturret/mcp-core@${pin} but ${CORE_MANIFEST}#version is ${manifest.version}. ` +
          `A pinned version the registry no longer serves turns the verification command into a 404.`,
      );
    }
  }

  return { cannotCheck: null, problems, comparedBlocks, comparedLines, pins: pins.length };
}

function main() {
  const repoRoot = resolve(process.argv[2] ?? '.');
  const { cannotCheck, problems, comparedBlocks, comparedLines, pins } = checkLandingPage(repoRoot);

  if (cannotCheck) {
    console.error(`check-landing-page: CANNOT CHECK — ${cannotCheck}`);
    console.error('Refusing to report success. "Could not check" is not "it passed".');
    process.exit(2);
  }

  if (problems.length > 0) {
    console.error('check-landing-page: FAIL\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\n${problems.length} problem(s).`);
    process.exit(1);
  }

  console.log(
    `check-landing-page: OK — ${comparedLines} command line(s) across ${comparedBlocks} block(s) ` +
      `matched ${README} verbatim, ${pins} pinned core version(s) agree with the manifest, ` +
      `and no unsourceable claim vocabulary is present.`,
  );
}

// Only run when invoked directly, so the self-test can import the functions.
if (process.argv[1] && resolve(process.argv[1]).endsWith('check-landing-page.mjs')) {
  main();
}
