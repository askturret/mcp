#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The fake-SDK-upgrade drill (#61, §17 criterion 11).
 *
 * §17 criterion 11: *"An MCP SDK upgrade can be completed inside the transport
 * boundary without changes to operation definitions."*
 *
 * `check-sdk-boundary.mjs` proves nothing else IMPORTS the SDK. That is a
 * necessary condition and not the criterion — the criterion is about what a
 * breaking SDK change actually costs, and the only way to know is to break one
 * and look.
 *
 * So this drill:
 *   1. injects a synthetic breaking change at the SDK boundary — a renamed
 *      export, which is the commonest shape of real SDK churn;
 *   2. builds the whole workspace;
 *   3. reports EVERY package that failed to compile;
 *   4. passes only if that set is a subset of the transport package;
 *   5. restores the file, always, including on failure or Ctrl-C.
 *
 * Committed as a scripted procedure, per §61's acceptance, so the next real SDK
 * upgrade runs it rather than reasoning about it.
 *
 * ## It reports how much it actually proved
 *
 * The drill measures the SDK surface first and prints it. That number is the
 * context the PASS has to be read in: with a large surface a pass is a strong
 * result, and with a tiny one it is a weak one. Today the surface is ONE
 * type-only import that nothing references, so a pass here means "the boundary
 * is intact and barely loaded" — not "we have proven isolation under stress".
 *
 * Saying so is the point. A drill that printed PASS without that number would
 * let a reader infer a guarantee the code does not support, which is the exact
 * failure mode §12.3's boundary exists to prevent in the first place.
 *
 * Usage:
 *   node .github/scripts/sdk-upgrade-drill.mjs [repoDir]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SDK = '@modelcontextprotocol/sdk';
const BOUNDARY_FILE = 'packages/transports/src/http/index.ts';
const ALLOWED_PACKAGE = 'packages/transports';

/** A renamed export — what an SDK major bump most often does. */
const SYNTHETIC_BREAK = {
  find: /import type \{ Server as _McpSdkServer \}/,
  replace: 'import type { ServerRenamedByUpstream as _McpSdkServer }',
};

function build(root) {
  return spawnSync('node', ['node_modules/typescript/bin/tsc', '-b'], {
    cwd: root,
    encoding: 'utf-8',
  });
}

/**
 * Which packages the compiler complained about.
 *
 * `tsc -b` prefixes each diagnostic with the file path, so the failing package
 * is the second path segment. Derived from the compiler's own output rather
 * than assumed, because the whole question is *which* packages broke.
 */
function failingPackages(output) {
  const packages = new Set();
  for (const line of output.split('\n')) {
    const match = /^(packages\/[^/]+)\/.*\(\d+,\d+\): error/.exec(line.trim());
    if (match) packages.add(match[1]);
  }
  return packages;
}

export function runDrill(repoDir = '.') {
  const root = resolve(repoDir);
  const file = join(root, BOUNDARY_FILE);

  if (!existsSync(file)) {
    return { code: 2, message: `Boundary file not found: ${BOUNDARY_FILE}. The drill did not run.` };
  }

  const original = readFileSync(file, 'utf-8');

  // How much SDK surface exists to break. Printed with the verdict so a PASS
  // is interpretable rather than merely reassuring.
  const surface = (original.match(new RegExp(SDK.replace('/', '\\/'), 'g')) ?? []).length;

  if (!SYNTHETIC_BREAK.find.test(original)) {
    return {
      code: 2,
      message:
        `Could not find the SDK import to break in ${BOUNDARY_FILE}.\n` +
        `The drill DID NOT RUN — it has not proven anything.\n\n` +
        `The import was probably renamed or removed. Update SYNTHETIC_BREAK in\n` +
        `this script to match, or if the SDK is genuinely no longer used, retire\n` +
        `this drill and check-sdk-boundary.mjs together and say why.`,
    };
  }

  // Always restore, including on an uncaught throw or a Ctrl-C. A drill that
  // left a deliberately-broken file behind would be indistinguishable from a
  // real breakage to the next person who ran a build.
  const restore = () => {
    try {
      writeFileSync(file, original, 'utf-8');
    } catch {
      /* best effort — the message below tells the operator what to check */
    }
  };
  process.once('SIGINT', () => {
    restore();
    process.exit(130);
  });

  try {
    // Baseline: the workspace must build BEFORE the drill, or a failure
    // afterwards proves nothing about the SDK.
    const before = build(root);
    if (before.status !== 0) {
      return {
        code: 2,
        message:
          `The workspace does not build BEFORE the drill, so the drill cannot\n` +
          `attribute anything to the SDK. Fix the build and retry.\n\n` +
          `${(before.stdout + before.stderr).trim().split('\n').slice(0, 20).join('\n')}`,
      };
    }

    writeFileSync(file, original.replace(SYNTHETIC_BREAK.find, SYNTHETIC_BREAK.replace), 'utf-8');

    const after = build(root);
    const output = `${after.stdout}${after.stderr}`;
    const failed = failingPackages(output);

    if (after.status === 0) {
      return {
        code: 1,
        message:
          `The synthetic SDK break did not fail the build AT ALL.\n\n` +
          `That is not a pass. It means the boundary import is not type-checked —\n` +
          `so this drill is measuring nothing, and would keep reporting PASS after\n` +
          `a real SDK change broke something. Investigate before trusting it.`,
      };
    }

    const escaped = [...failed].filter((p) => p !== ALLOWED_PACKAGE);

    if (escaped.length > 0) {
      return {
        code: 1,
        message:
          `A synthetic SDK change broke packages OUTSIDE the transport:\n\n` +
          escaped.map((p) => `  ${p}`).join('\n') +
          `\n\n§17 criterion 11 requires an SDK upgrade to be completable inside the\n` +
          `transport boundary. These packages would need a diff for an SDK change,\n` +
          `so they are coupled to it — re-model what they need in the canonical\n` +
          `model and translate at the transport.`,
      };
    }

    return {
      code: 0,
      message:
        `PASS — a synthetic SDK break failed ${ALLOWED_PACKAGE} and nothing else.\n\n` +
        `Blast radius: ${[...failed].join(', ') || '(none)'}\n` +
        `SDK surface in ${BOUNDARY_FILE}: ${String(surface)} reference(s).\n\n` +
        `Read that surface number with the verdict. The SDK is currently used for\n` +
        `a single type-only import that nothing references, so this PASS means the\n` +
        `boundary is intact and LIGHTLY LOADED — not that isolation has been\n` +
        `proven under a realistic upgrade. It will mean more when the surface does.`,
    };
  } finally {
    restore();
  }
}

function isProcessEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isProcessEntryPoint()) {
  const result = runDrill(process.argv[2] ?? '.');
  if (result.code === 0) {
    console.log(result.message);
  } else {
    console.error(`\n${result.message}\n`);
    console.error(`::error::fake-SDK-upgrade drill did not pass.`);
  }
  process.exit(result.code);
}
