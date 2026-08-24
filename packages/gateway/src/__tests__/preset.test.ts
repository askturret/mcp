// SPDX-License-Identifier: Apache-2.0
/**
 * Preset parity between gateway mode and the library (#57, §10.2, per #52).
 *
 * ## What "same rule as the library" has to mean to be worth asserting
 *
 * §57 asks that "Regulated preset in gateway mode boots refuses --audit-sink
 * stdout (same rule as library, per Epic #3 #52)". A test that only checked
 * "the gateway throws" would pass on a gateway that re-implemented the check —
 * and would then keep passing while the two drifted apart, which is the exact
 * failure it was written to prevent.
 *
 * So these tests assert the refusal is the LIBRARY's: `RegulatedPresetRefusal`
 * by class, and its `control` field by value. `control` is documented as stable
 * where the message is not, so matching on it is what ties the gateway's
 * behaviour to §10.2 rather than to a string the gateway could have produced
 * itself.
 *
 * ## And that no socket was opened
 *
 * A boot refusal that happened after binding would leave a gateway briefly
 * reachable holding a configuration the preset was about to reject. `startGateway`
 * expands the preset before it listens; the last test here is what holds that.
 */

import { describe, it, expect } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { RegulatedPresetRefusal } from '@askturret/mcp-core';

import { resolveConfig, type GatewayConfig } from '../config.js';
import { resolvePreset } from '../preset.js';
import { startGateway } from '../server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PETSTORE = join(__dirname, '../../../sources-openapi/src/__tests__/fixtures/petstore.json');

/** A module exporting a verifier, for the cases that need Regulated to succeed. */
const VERIFIER_MODULE = join(__dirname, 'fixtures/verify-evidence.js');

function config(overrides: Record<string, unknown>): GatewayConfig {
  return resolveConfig(
    {},
    { spec: PETSTORE, port: 0, metricsPort: 0, ...overrides } as never,
  );
}

describe('Regulated preset in gateway mode', () => {
  it('refuses --audit-sink stdout, with the library’s own refusal', async () => {
    // The refusal §57 names explicitly.
    const promise = resolvePreset(config({ preset: 'regulated', audit: { sink: 'stdout' } }));

    await expect(promise).rejects.toBeInstanceOf(RegulatedPresetRefusal);
    // The stable field, not the message. This is what makes the assertion about
    // §10.2's rule rather than about wording the gateway could have invented.
    await expect(promise).rejects.toMatchObject({ control: 'audit.durability' });
  });

  it('refuses --audit-sink none for the same reason', async () => {
    // Running with no audit sink at all must refuse exactly as stdout does.
    // The gateway declares `none` as `memory` rather than special-casing it, so
    // there is one rule here and core owns it.
    const promise = resolvePreset(config({ preset: 'regulated', audit: { sink: 'none' } }));

    await expect(promise).rejects.toMatchObject({ control: 'audit.durability' });
  });

  it('refuses a missing redaction-review acknowledgement', async () => {
    const promise = resolvePreset(
      config({
        preset: 'regulated',
        audit: { sink: 'jsonl', path: '/tmp/gateway-unused.jsonl' },
        verifyEvidenceModule: VERIFIER_MODULE,
      }),
    );

    await expect(promise).rejects.toMatchObject({
      control: 'redaction.customReviewAcknowledged',
    });
  });

  it('refuses a missing evidence verifier — the config file cannot hold a function', async () => {
    // The interesting one for a STANDALONE deployment: `verifyEvidence` is a
    // function, so no YAML can supply it. The gateway offers a module path and
    // supplies NO fallback, so core's refusal is what fires.
    const promise = resolvePreset(
      config({
        preset: 'regulated',
        audit: { sink: 'jsonl', path: '/tmp/gateway-unused.jsonl' },
        customReviewAcknowledged: true,
      }),
    );

    await expect(promise).rejects.toMatchObject({
      control: 'authorization.verifyEvidence',
    });
  });

  it('expands when every control is satisfied', async () => {
    // The negative tests above prove nothing on their own — a resolvePreset that
    // always threw would pass all four. This is the one that makes them mean
    // something.
    const resolved = await resolvePreset(
      config({
        preset: 'regulated',
        audit: { sink: 'jsonl', path: '/tmp/gateway-unused.jsonl' },
        customReviewAcknowledged: true,
        verifyEvidenceModule: VERIFIER_MODULE,
      }),
    );

    expect(resolved.name).toBe('regulated');
    expect(resolved.configuration).toBeDefined();
    // Regulated's §10.2 column, arriving from core rather than from the gateway.
    expect(resolved.configuration?.discovery).toEqual({
      readInclude: 'explicit-only',
      writeInclude: 'explicit-only',
    });
  });

  it('refuses BEFORE binding a port', async () => {
    // A refusal after listen() would leave the gateway briefly reachable while
    // holding a configuration §10.2 rejects.
    await expect(
      startGateway(config({ preset: 'regulated', audit: { sink: 'stdout' } })),
    ).rejects.toBeInstanceOf(RegulatedPresetRefusal);

    // Nothing to close: if a listener had been opened, the suite would leak a
    // handle and Jest would report an open handle after the run.
  });
});

describe('other presets', () => {
  it('light expands to no preset configuration, matching the facades', async () => {
    const resolved = await resolvePreset(config({ preset: 'light' }));

    // Light is the ABSENCE of an expansion, not a permissive one — the same
    // thing `expressMcp()` gives with no preset named.
    expect(resolved.name).toBe('light');
    expect(resolved.configuration).toBeUndefined();
  });

  it('production expands and accepts a stdout sink', async () => {
    // The contrast that makes the Regulated refusal meaningful: the same sink
    // is admissible one column to the left in §10.2.
    const resolved = await resolvePreset(config({ preset: 'production', audit: { sink: 'stdout' } }));

    expect(resolved.name).toBe('production');
    expect(resolved.configuration).toBeDefined();
  });

  it('production carries the operator’s permission grants through to the policy', async () => {
    const resolved = await resolvePreset(
      config({ preset: 'production', permissions: { listPets: ['pets:read'] } }),
    );

    // Deny-by-default is core's rule; what the gateway owes is delivering the
    // grants it was given, unchanged.
    expect(resolved.configuration?.authorization.callTime).toBe(true);
  });
});
