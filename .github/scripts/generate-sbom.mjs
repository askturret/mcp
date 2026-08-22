#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Generates a CycloneDX SBOM (#24).
 *
 * Wraps @cyclonedx/cyclonedx-npm at a PINNED version — an unpinned generator
 * would make the SBOM, which is a supply-chain attestation, depend on whatever
 * happened to be published that day.
 *
 * The generator emits every dependency but does not distinguish runtime from
 * development, so this tags each component afterwards from the same inventory
 * the licence gate uses. Without that, a reader cannot tell which components
 * are actually shipped.
 *
 * Usage:
 *   node .github/scripts/generate-sbom.mjs [repoRoot] [--output sbom.cdx.json]
 *
 * Exit codes: 0 written · 2 generation failed
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { inventory } from './lib/dependencies.mjs';

/**
 * Pinned generator version. Bump deliberately, in a reviewed change.
 * See LICENSE_EXCEPTIONS.md for the surrounding policy.
 */
export const CYCLONEDX_NPM_VERSION = '6.0.1';

const PROPERTY_SCOPE = 'askturret:dependency-scope';

const args = process.argv.slice(2);
const outputArgIndex = args.indexOf('--output');
const outputName = outputArgIndex >= 0 ? args[outputArgIndex + 1] : 'sbom.cdx.json';
const positional = args.filter((a, i) => !a.startsWith('--') && i !== outputArgIndex + 1);
const repoRoot = resolve(positional[0] ?? '.');
const outputPath = resolve(repoRoot, outputName);

/** Tag every component with runtime/development scope. */
export function tagComponentScopes(sbom, deps) {
  const scopeByName = new Map();
  for (const dep of deps) {
    // If a package appears in both views, runtime wins — it is shipped.
    if (scopeByName.get(dep.name) === 'runtime') continue;
    scopeByName.set(dep.name, dep.scope);
  }

  let tagged = 0;
  let untagged = 0;

  for (const component of sbom.components ?? []) {
    // cyclonedx-npm strips the scope from the component name but keeps it in
    // `group`, so rebuild the npm package name before looking it up.
    const fullName = component.group
      ? `${component.group}/${component.name}`
      : component.name;

    const scope = scopeByName.get(fullName);
    if (!scope) {
      untagged++;
      continue;
    }

    const properties = component.properties ?? [];
    if (!properties.some((p) => p.name === PROPERTY_SCOPE)) {
      properties.push({ name: PROPERTY_SCOPE, value: scope });
    }
    component.properties = properties;
    tagged++;
  }

  return { tagged, untagged };
}

function main() {
  console.log(`Generating CycloneDX SBOM with @cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION}`);

  const run = spawnSync(
    'npx',
    [
      '--yes',
      `@cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION}`,
      '--output-format',
      'JSON',
      '--output-file',
      outputPath,
    ],
    { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  if (run.status !== 0 || !existsSync(outputPath)) {
    console.error(`::error::SBOM generation failed (exit ${run.status}).`);
    console.error((run.stderr || run.stdout || '').slice(-4000));
    process.exit(2);
  }

  let sbom;
  try {
    sbom = JSON.parse(readFileSync(outputPath, 'utf-8'));
  } catch (err) {
    console.error(`::error::generator produced unparseable JSON: ${err.message}`);
    process.exit(2);
  }

  const componentCount = (sbom.components ?? []).length;
  if (componentCount === 0) {
    // An empty SBOM would pass every downstream check while describing nothing.
    console.error('::error::SBOM contains no components — refusing to publish an empty inventory.');
    process.exit(2);
  }

  let deps;
  try {
    deps = inventory(repoRoot);
  } catch (err) {
    console.error(`::error::could not build the dependency inventory for scope tagging: ${err.message}`);
    process.exit(2);
  }

  const { tagged, untagged } = tagComponentScopes(sbom, deps);
  writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);

  const runtime = (sbom.components ?? []).filter((c) =>
    (c.properties ?? []).some((p) => p.name === PROPERTY_SCOPE && p.value === 'runtime'),
  ).length;

  console.log(`  spec version : ${sbom.specVersion}`);
  console.log(`  components   : ${componentCount}`);
  console.log(`  scope-tagged : ${tagged} (${runtime} runtime, ${tagged - runtime} development)`);
  if (untagged > 0) {
    console.log(`  untagged     : ${untagged} (not present in the installed tree)`);
  }
  console.log(`  written to   : ${outputPath}`);
}

// Only run when invoked directly, so the tagging helper can be imported by tests.
if (process.argv[1] && resolve(process.argv[1]).endsWith('generate-sbom.mjs')) {
  main();
}
