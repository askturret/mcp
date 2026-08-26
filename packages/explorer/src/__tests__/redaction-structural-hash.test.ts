// SPDX-License-Identifier: Apache-2.0
/**
 * The structural-hash exemption on the Explorer surface (#266).
 *
 * A snapshot hash that happens to be 16 all-decimal Luhn-valid digits matched
 * `creditCardRule` and was masked before it reached panel 6, where it renders
 * as a `<select>` option VALUE — so two such snapshots became indistinguishable
 * and `syncWarning`'s comparison could return true for a pair the operator did
 * not select.
 *
 * ## Why these assertions go through `buildExplorerPanels`
 *
 * Redaction runs TWICE over the same value — once inside `buildDiffView` and
 * again over the assembled panels object — so one hash is visited at both
 * `snapshots.<i>.hash` and `diff.snapshots.<i>.hash`. A fix that handles only
 * the outer framing silently half-works: pass 1 masks the value before pass 2
 * ever sees it, and a test that called `buildDiffView` alone would still be
 * green. Asserting on the assembled object is what makes criterion 2 real.
 *
 * ## What the exemption is NOT
 *
 * It is not sound by construction. `[0-9]` is a subset of `[0-9a-f]`, so a
 * 16-digit Luhn-valid PAN still clears the shape gate — and no regex can fix
 * that, because the values criterion 1 requires exempting are precisely
 * 16-character all-decimal hashes, the same string space as a PAN. What the
 * gate buys is a bounded blast radius, and the tests below pin its edges: the
 * neighbouring caller-controlled path stays masked (criterion 3) and a
 * non-hash-shaped value at the exempted path stays masked (criterion 7).
 */

import { describe, it, expect } from '@jest/globals';
import {
  BUILTIN_RULES,
  createRedactionPipeline,
  createSnapshot,
  highEntropyRule,
  redactExplorerModel,
  type RegistrySnapshot,
} from '@askturret/mcp-core';

import { buildExplorerPanels } from '../panels.js';

const REDACTED = '[REDACTED]';

/**
 * Two 16-digit, all-decimal, Luhn-valid strings — the collision case.
 *
 * Both are standard test PANs, which is the point: they are simultaneously
 * valid truncated-SHA-256 renderings and valid card numbers, and nothing about
 * the string tells them apart.
 */
const CARD_SHAPED_A = '4242424242424242';
const CARD_SHAPED_B = '4000000000000002';

function snapshotWithHash(version: number, hash: string): RegistrySnapshot {
  return {
    version,
    hash,
    createdAt: new Date(0),
    operations: new Map(),
  } as unknown as RegistrySnapshot;
}

/** Panel 6 as the browser receives it, after BOTH redaction passes. */
function diffPanel(retained: readonly RegistrySnapshot[], report?: unknown) {
  const panels = buildExplorerPanels({
    retained,
    ...(report === undefined ? {} : { diff: report as never }),
  }) as { diff?: { snapshots?: { hash: string }[]; comparing?: { before: { hash: string } } } };
  return panels.diff;
}

// ---------------------------------------------------------------------------
// Criterion 6 — the length coupling, asserted FIRST because everything else
// depends on the regex still describing real compiler output.
// ---------------------------------------------------------------------------

describe('the exemption is tied to the compiler truncation length (#266 criterion 6)', () => {
  // DERIVED from the compiler's own hash path, never a hard-coded literal. A
  // literal keeps passing after `freeze-and-hash.ts` changes its truncation and
  // the guard silently stops guarding.
  const realHash = createSnapshot([], 1).hash;

  it('a real compiler-produced hash survives redaction on the Explorer surface', () => {
    const panel = diffPanel([snapshotWithHash(1, realHash), snapshotWithHash(2, realHash)]);
    expect(panel?.snapshots?.[0]?.hash).toBe(realHash);
  });

  it('the card-shaped fixtures are the same length as a real hash, or they prove nothing', () => {
    // This is the coupling. If the compiler's truncation length changes, the
    // fixtures below stop describing a hash, and this goes red rather than the
    // suite quietly testing a shape the product no longer produces.
    expect(CARD_SHAPED_A).toHaveLength(realHash.length);
    expect(CARD_SHAPED_B).toHaveLength(realHash.length);
  });

  it('the pattern is an EXACT length, not a minimum — a longer card-shaped value is still redacted', () => {
    // The value must be one a rule would otherwise redact, or this cannot fail.
    //
    // An earlier version of this test used a 17-character hex and asserted it
    // SURVIVED. That passed under a `{16,}` widening too, because no rule fires
    // on a 17-char hex in the first place — not card-shaped, no dots, and far
    // short of highEntropyRule's 24-character floor. It was satisfied by the
    // absence of any applicable rule rather than by the exemption's width.
    //
    // A 19-digit Luhn-valid PAN is longer than a hash, is all-decimal (so a
    // `{16,}` pattern WOULD exempt it), and creditCardRule matches 12-19
    // digits. So it discriminates.
    const LONGER_CARD = '4000000000000000006';
    expect(LONGER_CARD.length).toBeGreaterThan(realHash.length);

    const panel = diffPanel([
      snapshotWithHash(1, LONGER_CARD),
      snapshotWithHash(2, CARD_SHAPED_B),
    ]);
    expect(panel?.snapshots?.[0]?.hash).toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// Criteria 1, 2 and 4 — the defect itself
// ---------------------------------------------------------------------------

describe('a Luhn-valid snapshot hash survives both redaction passes (#266 criteria 1, 2)', () => {
  it('renders intact at snapshots[].hash', () => {
    const panel = diffPanel([
      snapshotWithHash(2, CARD_SHAPED_A),
      snapshotWithHash(1, CARD_SHAPED_B),
    ]);

    expect(panel?.snapshots?.[0]?.hash).toBe(CARD_SHAPED_A);
    expect(panel?.snapshots?.[1]?.hash).toBe(CARD_SHAPED_B);
  });

  it('renders intact at comparing.before.hash, which is a different path', () => {
    const panel = diffPanel(
      [snapshotWithHash(2, CARD_SHAPED_A), snapshotWithHash(1, CARD_SHAPED_B)],
      {
        before: { version: 1, hash: CARD_SHAPED_B },
        after: { version: 2, hash: CARD_SHAPED_A },
        changes: [],
        summary: { added: 0, removed: 0, changed: 0 },
      },
    );

    expect(panel?.comparing?.before.hash).toBe(CARD_SHAPED_B);
  });

  it('two colliding hashes remain DISTINGUISHABLE, which is what panel 6 needs (#266 criterion 4)', () => {
    const panel = diffPanel([
      snapshotWithHash(2, CARD_SHAPED_A),
      snapshotWithHash(1, CARD_SHAPED_B),
    ]);

    const [first, second] = panel?.snapshots ?? [];
    // The defect was not "a hash is masked" but "two DIFFERENT hashes become
    // equal", which is what let syncWarning compare a mismatched pair as equal.
    expect(first?.hash).not.toBe(second?.hash);
    expect(first?.hash).not.toBe(REDACTED);
    expect(second?.hash).not.toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — the soundness guard, which matters MORE than criterion 1
// ---------------------------------------------------------------------------

describe('the exemption pins the container, not the leaf (#266 criterion 3)', () => {
  it('a caller-controlled attributes.hash on the traces panel is STILL redacted', () => {
    // `buildTraceView` spreads caller-influenced span attributes straight into
    // the model. A last-segment match on `hash` would exempt this, which is the
    // #129 shape: a caller-controlled value reaching an exempted field.
    const panels = buildExplorerPanels({
      spans: [
        {
          name: 'op',
          startedAt: 0,
          durationMs: 1,
          attributes: { hash: CARD_SHAPED_A },
        } as never,
      ],
    }) as { traces?: { spans?: { attributes?: Record<string, unknown> }[] } };

    expect(panels.traces?.spans?.[0]?.attributes?.hash).toBe(REDACTED);
  });

  it('a hash-shaped value at an UNRELATED explorer path is still redacted', () => {
    // Guards against the suffix match being widened into "anywhere on the
    // explorer surface". Asserted through the pipeline rather than the panels,
    // because no panel puts a bare `hash` at the root today — and a test that
    // could only be written via a panel would stop covering this the moment
    // one did.
    const redacted = redactExplorerModel({ hash: CARD_SHAPED_A }) as { hash: string };
    expect(redacted.hash).toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// Criterion 7 — what pins option 2's actual guarantee
// ---------------------------------------------------------------------------

describe('a non-hash-shaped value at the exempted path is still redacted (#266 criterion 7)', () => {
  // Each of these reaches snapshots[].hash — the EXEMPTED path — and must be
  // masked anyway, because the exemption is gated on value shape. This is the
  // test that fails if someone later "simplifies" the valuePattern away, and
  // without it the gate is unverified.
  const cases: readonly (readonly [string, string])[] = [
    ['a JWT', 'eyJhbGciOi.eyJzdWIiOiI.SflKxwRJSMeK'],
    ['a bearer token', 'Bearer abcdefghijklmnop'],
  ];

  it.each(cases)('%s at snapshots[].hash is redacted', (_label, value) => {
    const panel = diffPanel([snapshotWithHash(2, value), snapshotWithHash(1, CARD_SHAPED_B)]);
    expect(panel?.snapshots?.[0]?.hash).toBe(REDACTED);
  });

  it('a 40-character hex digest is redacted at the exempted path, with highEntropyRule enabled', () => {
    // `highEntropyRule` is deliberately NOT a built-in, so a 40-char hex is not
    // redacted by the default pipeline at all — asserting it through
    // `buildExplorerPanels` would pass whether or not the exemption applied.
    // Enabling the rule is what makes this case able to fail.
    // A REAL 40-char digest, not a repeated character: `highEntropyRule` also
    // gates on Shannon entropy >= 3.5, and 'a'.repeat(40) has an entropy of
    // zero — it would fail the rule for a reason that has nothing to do with
    // the exemption, and the test would then prove nothing.
    const pipeline = createRedactionPipeline({ rules: [...BUILTIN_RULES, highEntropyRule] });
    const model = { snapshots: [{ hash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709' }] };

    const out = redactExplorerModel(model, pipeline) as { snapshots: { hash: string }[] };
    expect(out.snapshots[0]?.hash).toBe(REDACTED);
  });

  // NOT asserted, and the reason is the point: a 16-character UPPERCASE hex is
  // outside `valuePattern` (which is lowercase-only), but NO rule can fire on
  // it — it is not card-shaped, has no dots, no bearer prefix, and is far short
  // of highEntropyRule's 24-character floor. So an "it is still redacted"
  // assertion would pass identically whether or not the exemption covered it,
  // and an "it survives" assertion would pass even if the pattern were widened
  // to accept uppercase.
  //
  // Either direction is satisfied by the absence of any applicable rule rather
  // than by the behaviour under test. The lowercase-only property is real but
  // unobservable at this length, so it is recorded here instead of pinned by a
  // test that could not fail.

  it('...while the hash-shaped sibling in the same object survives', () => {
    // The pair matters: it shows the redaction above is the VALUE being
    // rejected, not the path having lost its exemption.
    const panel = diffPanel([
      snapshotWithHash(2, 'Bearer abcdefghijklmnop'),
      snapshotWithHash(1, CARD_SHAPED_B),
    ]);

    expect(panel?.snapshots?.[0]?.hash).toBe(REDACTED);
    expect(panel?.snapshots?.[1]?.hash).toBe(CARD_SHAPED_B);
  });
});
