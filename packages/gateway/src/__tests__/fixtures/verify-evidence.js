// SPDX-License-Identifier: Apache-2.0
/**
 * A stand-in evidence verifier, for the Regulated-preset tests.
 *
 * Plain JS and NOT TypeScript, because `--verify-evidence` takes a module the
 * gateway `import()`s at runtime — which is what an operator supplies in a
 * deployment, and what a `.ts` file would not be.
 *
 * It accepts everything, which is exactly what core refuses to ship as a
 * default (§10.2: a verifier that accepted any proof would make the evidence
 * requirement decorative). That is fine HERE and only here: these tests are
 * about whether the gateway delivers a verifier to the preset, not about
 * whether any particular signature scheme is sound.
 */
export function verifyEvidence() {
  return true;
}
