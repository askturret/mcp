// SPDX-License-Identifier: Apache-2.0
/**
 * "Was this module run directly, or imported?" — one implementation (#455).
 *
 * Guards in this directory need to do two things at once: expose their logic as
 * an importable `check()` so a self-test can call it, and still run as a CI
 * script. That means every such guard needs this predicate, and five of them
 * had grown their own byte-identical copy of it.
 *
 * Copying it is what #443 names as the expensive mistake — a rule that spreads
 * by copy arrives incomplete somewhere, and nothing notices. The subtle part
 * here is `realpathSync`: without it, a guard invoked through a symlinked path
 * compares a resolved URL against an unresolved one, never matches, and exits 0
 * having checked nothing. A silent pass, from a guard, is the exact failure
 * #281's doctrine is about — so it is worth having in one place that can be
 * fixed once.
 *
 * @param {string} moduleUrl - the caller's `import.meta.url`. Passed in rather
 *   than read here, because `import.meta.url` inside this file would always be
 *   this file.
 * @returns {boolean} true when `moduleUrl` is the process entry point.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isProcessEntryPoint(moduleUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    // An unresolvable argv[1] means we cannot establish that we are the entry
    // point. Returning false keeps an imported module from running its CI body
    // as a side effect of being imported, which is the safe direction.
    return false;
  }
}
